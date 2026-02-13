import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { XMLParser } from "fast-xml-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const NEWS_TTL_MS = 24 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const cacheDir = path.join(__dirname, "cache");
const newsCacheFile = path.join(cacheDir, "news_daily_brief.json");

const NEWS_FEEDS = [
  { source: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { source: "WSJ World", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml" },
  { source: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { source: "ABC International", url: "https://abcnews.go.com/abcnews/internationalheadlines" },
  { source: "ABC Money", url: "https://abcnews.go.com/abcnews/moneyheadlines" },
  { source: "NY Post World", url: "https://nypost.com/world-news/feed/" },
  { source: "NY Post Business", url: "https://nypost.com/business/feed/" },
  { source: "The Economist International", url: "https://www.economist.com/international/rss.xml" },
  { source: "The Economist Finance", url: "https://www.economist.com/finance-and-economics/rss.xml" },
  // Reuters feed can fail in some networks, so we keep it optional.
  { source: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews" },
  { source: "Reuters World", url: "https://feeds.reuters.com/Reuters/worldNews" },
];

const readJSONSafe = async (filePath) => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJSONSafe = async (filePath, data) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
};

const fetchWithTimeout = async (url, timeoutMs = 12000) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "DossierNewsBot/1.0" } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
};

const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const normalizeItemsFromFeed = (source, xmlText) => {
  try {
    const parsed = xmlParser.parse(xmlText);
    const channel = parsed?.rss?.channel;
    const items = toArray(channel?.item);

    return items
      .map((it) => {
        const title = typeof it?.title === "string" ? it.title.trim() : "";
        const link = typeof it?.link === "string" ? it.link.trim() : "";
        const pubDate = it?.pubDate || it?.published || it?.updated || null;
        const ts = pubDate ? Date.parse(pubDate) : NaN;

        return {
          source,
          title,
          link,
          publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
        };
      })
      .filter((x) => x.title && x.link);
  } catch {
    return [];
  }
};

const getNewsArticles = async () => {
  const settled = await Promise.allSettled(
    NEWS_FEEDS.map(async (f) => {
      const xml = await fetchWithTimeout(f.url);
      const items = normalizeItemsFromFeed(f.source, xml);
      return { source: f.source, items, ok: true };
    }),
  );

  const items = [];
  const feedStatus = [];

  for (const r of settled) {
    if (r.status === "fulfilled") {
      items.push(...r.value.items);
      feedStatus.push({ source: r.value.source, ok: true, count: r.value.items.length });
    } else {
      feedStatus.push({ source: "unknown", ok: false, error: r.reason instanceof Error ? r.reason.message : "feed_error" });
    }
  }

  const sorted = items
    .sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    })
    .slice(0, 80);

  return { items: sorted, feedStatus };
};

const buildDigestInput = (articles) => {
  const rows = articles.slice(0, 40).map((a, idx) => {
    const when = a.publishedAt ? a.publishedAt : "unknown_time";
    return `${idx + 1}. [${a.source}] ${a.title} (${when})`;
  });
  return rows.join("\n");
};

const fallbackDailyBrief = (articles, reason = "ai_unavailable") => {
  const top = articles.slice(0, 18);
  const macroKeywords = /(market|inflation|oil|econom|trade|rates|bank|fiscal|gdp|tariff|stocks)/i;
  const geoKeywords = /(war|military|sanction|diplom|election|border|security|geopolit|iran|china|russia|ukraine)/i;

  const macroeconomia = top.filter((a) => macroKeywords.test(a.title)).slice(0, 5).map((a) => `${a.source}: ${a.title}`);
  const geopolitica = top.filter((a) => geoKeywords.test(a.title)).slice(0, 5).map((a) => `${a.source}: ${a.title}`);

  const summary = reason === "quota_exceeded"
    ? "Resumen IA no disponible por limite de cuota API. Se muestra resumen automático por titulares."
    : "Resumen IA no disponible temporalmente. Se muestra resumen automático por titulares.";

  return {
    summary,
    macroeconomia: macroeconomia.length ? macroeconomia : top.slice(0, 4).map((a) => `${a.source}: ${a.title}`),
    geopolitica: geopolitica.length ? geopolitica : top.slice(4, 8).map((a) => `${a.source}: ${a.title}`),
    riesgos_clave: [
      "Confirmar cuando haya cuota API para volver a síntesis con modelo.",
      "Validar manualmente titulares de mayor impacto antes de decisiones.",
    ],
    watchlist_24h: top.slice(0, 4).map((a) => `${a.source}: ${a.title}`),
    confidence: "low",
  };
};

const aiDailyBrief = async (articles) => {
  if (!client) {
    const fb = fallbackDailyBrief(articles, "no_api_key");
    return {
      ...fb,
      summary: "OPENAI_API_KEY no configurada. Resumen IA no disponible; se muestra resumen automático por titulares.",
    };
  }

  const input = buildDigestInput(articles);
  const system = [
    "Eres editor de riesgo macro y geopolítico.",
    "Tu misión: producir un brief diario claro para un dashboard financiero.",
    "No inventes hechos, no cites fuentes fuera de la lista dada.",
    "Devuelve JSON válido con resumen breve, bullets accionables y riesgos.",
  ].join(" ");

  try {
    const resp = await client.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "daily_news_brief_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              macroeconomia: { type: "array", items: { type: "string" } },
              geopolitica: { type: "array", items: { type: "string" } },
              riesgos_clave: { type: "array", items: { type: "string" } },
              watchlist_24h: { type: "array", items: { type: "string" } },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["summary", "macroeconomia", "geopolitica", "riesgos_clave", "watchlist_24h", "confidence"],
          },
        },
      },
    });

    return JSON.parse(resp.output_text || "{}");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    const quota = msg.includes("429") || msg.toLowerCase().includes("quota");
    return fallbackDailyBrief(articles, quota ? "quota_exceeded" : "ai_error");
  }
};

const getOrCreateDailyNewsBrief = async ({ force = false } = {}) => {
  const now = Date.now();
  const cached = await readJSONSafe(newsCacheFile);
  const cachedNoKey = typeof cached?.brief?.summary === "string" && cached.brief.summary.includes("OPENAI_API_KEY no configurada");
  const shouldBypassCachedNoKey = cachedNoKey && Boolean(client);

  if (!force && !shouldBypassCachedNoKey && cached?.generatedAt && now - Date.parse(cached.generatedAt) < NEWS_TTL_MS) {
    return { ...cached, cacheHit: true };
  }

  const { items, feedStatus } = await getNewsArticles();
  const brief = await aiDailyBrief(items);

  const payload = {
    generatedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + NEWS_TTL_MS).toISOString(),
    feedStatus,
    articleCount: items.length,
    topHeadlines: items.slice(0, 12),
    brief,
  };

  await writeJSONSafe(newsCacheFile, payload);
  return { ...payload, cacheHit: false };
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, model, hasOpenAIKey: Boolean(apiKey) });
});

app.get("/api/osint/sources", (_req, res) => {
  res.json({
    sources: [
      { id: "daopz", label: "@daopz", type: "social" },
      { id: "munitionsportal", label: "@munitionsportal", type: "social" },
      { id: "news", label: "News Stream", type: "news" },
    ],
  });
});

app.get("/api/news/daily-brief", async (req, res) => {
  try {
    const force = req.query?.force === "1";
    const data = await getOrCreateDailyNewsBrief({ force });
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({
      error: "daily_news_failed",
      detail: err instanceof Error ? err.message : "unknown_error",
    });
  }
});

app.post("/api/brief", async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const scope = typeof req.body?.scope === "string" ? req.body.scope.trim() : "general";

    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }
    if (!client) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing in server env" });
    }

    const prompt = `You are an intelligence analyst assistant. Scope: ${scope}. Return valid JSON with keys: summary, key_points, risks, confidence. Keep concise and neutral.`;

    const resp = await client.responses.create({
      model,
      input: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "brief_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              key_points: { type: "array", items: { type: "string" } },
              risks: { type: "array", items: { type: "string" } },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["summary", "key_points", "risks", "confidence"],
          },
        },
      },
    });

    const raw = resp.output_text || "{}";
    const parsed = JSON.parse(raw);
    return res.json({ ok: true, data: parsed });
  } catch (err) {
    return res.status(500).json({
      error: "brief_generation_failed",
      detail: err instanceof Error ? err.message : "unknown_error",
    });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Dossier AI server running on http://localhost:${port}`);
});




