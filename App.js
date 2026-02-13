import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Line, Polyline } from "react-native-svg";

const CACHE_KEY = "dossier_cache_v4";
const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "";

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const compactSeries = (arr, max = 48) => {
  if (!Array.isArray(arr)) return [];
  const clean = arr.map(toNumber).filter((n) => n !== null);
  return clean.slice(-max);
};

const lastNumber = (arr) => {
  const values = compactSeries(arr, 500);
  if (!values.length) return null;
  return values[values.length - 1];
};

const pctFromSeries = (arr, stepsBack = 24) => {
  const values = compactSeries(arr, 500);
  if (values.length < 2) return null;

  const last = values[values.length - 1];
  const idx = Math.max(0, values.length - 1 - stepsBack);
  const base = values[idx];
  if (!base) return null;
  return ((last - base) / base) * 100;
};

const updateHistory = (prev, patch, nowTs) => {
  const next = { ...(prev || {}) };
  const cutoff = nowTs - 1000 * 60 * 60 * 24 * 30;

  Object.keys(patch).forEach((key) => {
    const value = toNumber(patch[key]);
    const old = Array.isArray(next[key]) ? next[key] : [];
    const kept = old.filter((p) => p && typeof p.t === "number" && p.t >= cutoff && toNumber(p.v) !== null);
    if (value !== null) kept.push({ t: nowTs, v: value });
    next[key] = kept.slice(-400);
  });

  return next;
};

const valuesFromHistory = (history, key) => {
  const arr = Array.isArray(history?.[key]) ? history[key] : [];
  return arr.map((p) => toNumber(p?.v)).filter((n) => n !== null);
};

const pct24hFromHistoryInfo = (history, key) => {
  const arr = Array.isArray(history?.[key]) ? history[key] : [];
  if (arr.length < 2) return { pct: null, mode: "na" };

  const last = arr[arr.length - 1];
  if (!last || toNumber(last.v) === null) return { pct: null, mode: "na" };

  const target = last.t - 1000 * 60 * 60 * 24;
  let base = null;
  let mode = "24h";
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].t <= target) {
      base = arr[i];
      break;
    }
  }

  // If we still do not have a full 24h window, fallback to earliest available point.
  if (!base) {
    base = arr[0];
    mode = "since_start";
  }
  const b = toNumber(base.v);
  const l = toNumber(last.v);
  if (!b || l === null) return { pct: null, mode: "na" };
  return { pct: ((l - b) / b) * 100, mode };
};

const fmtMoney = (n) => (n !== null && n !== undefined ? `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--");
const fmtBs = (n) => (n !== null && n !== undefined ? `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 })} Bs` : "--");
const fmtPct = (p) => (p === null || p === undefined ? "24h: N/D" : `24h: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
const fmtPctCustom = (p, label = "24h") => (p === null || p === undefined ? `${label}: N/D` : `${label}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
const shortTitle = (s) => (typeof s === "string" ? s : "");
const fmtIso = (v) => {
  const ts = toTs(v);
  if (!ts) return "N/D";
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
const toTs = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const fmtLastData = (ts) => {
  if (!ts) return "Ultimo dato: N/D";
  const d = new Date(ts);
  return `Ultimo dato: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
const isClosedByAge = (ts, maxMinutes, nowTs) => {
  if (!ts) return false;
  return nowTs - ts > maxMinutes * 60 * 1000;
};

const readCache = async () => {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeCache = async (data) => {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
};

const avgTopPrices = (json, count = 8) => {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const prices = rows.map((r) => toNumber(r?.adv?.price)).filter((n) => n !== null).slice(0, count);
  if (!prices.length) return null;
  return prices.reduce((acc, v) => acc + v, 0) / prices.length;
};

const average = (arr) => {
  const nums = arr.map(toNumber).filter((n) => n !== null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

const buildPizzaSeries = (rows) => {
  const seriesList = rows
    .map((r) => (Array.isArray(r?.sparkline_24h) ? r.sparkline_24h.map((p) => toNumber(p?.current_popularity)) : []))
    .filter((s) => s.length > 0);

  if (!seriesList.length) return [];
  const maxLen = Math.max(...seriesList.map((s) => s.length));
  const out = [];

  for (let i = 0; i < maxLen; i += 1) {
    const point = average(seriesList.map((s) => s[i]));
    if (point !== null) out.push(point);
  }
  return compactSeries(out, 48);
};

const fetchP2P = async (tradeType) => {
  const res = await fetch("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page: 1,
      rows: 12,
      payTypes: [],
      countries: [],
      publisherType: "merchant",
      asset: "USDT",
      fiat: "VES",
      tradeType,
    }),
  });

  return res.json();
};

const chartMeta = (series, width, height) => {
  const values = compactSeries(series, 28);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return { points, min, max, span };
};

function MiniChart({ series, positive, baselineValue = null }) {
  const width = 92;
  const height = 34;
  const meta = chartMeta(series, width, height);
  const stroke = positive ? "#00c087" : "#f6465d";

  if (!meta) {
    return <Text style={styles.noChart}>--</Text>;
  }

  const baselineY = baselineValue !== null && baselineValue !== undefined
    ? height - ((baselineValue - meta.min) / meta.span) * height
    : null;

  return (
    <Svg width={width} height={height}>
      {baselineY !== null ? (
        <Line
          x1="0"
          y1={Math.max(0, Math.min(height, baselineY))}
          x2={width}
          y2={Math.max(0, Math.min(height, baselineY))}
          stroke="#f0b90b"
          strokeWidth="1.5"
          strokeDasharray="3,2"
        />
      ) : null}
      <Polyline points={meta.points} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

function Row({ label, valueText, pct24h, series, pctText, lastTs, marketClosed }) {
  const isPositive = (pct24h ?? 0) >= 0;
  return (
    <View style={styles.row}>
      <View style={styles.leftCol}>
        <View style={styles.labelLine}>
          <Text style={styles.rowLabel}>{label}</Text>
          {marketClosed ? <Text style={styles.closedBadge}>Mercado cerrado</Text> : null}
        </View>
        <Text style={styles.rowValue}>{valueText}</Text>
        <Text style={[styles.rowPct, isPositive ? styles.up : styles.down]}>{pctText || fmtPct(pct24h)}</Text>
        <Text style={styles.lastData}>{fmtLastData(lastTs)}</Text>
      </View>
      <View style={styles.chartCol}>
        <MiniChart series={series} positive={isPositive} />
      </View>
    </View>
  );
}

export default function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [parallelInfo, setParallelInfo] = useState("");
  const [pizzaIndex, setPizzaIndex] = useState({ score: null, pct24h: null, spikes: 0, series: [], normal: null });
  const [polyTrends, setPolyTrends] = useState([]);
  const [usdMeta, setUsdMeta] = useState({ oficialLabel: "24h", paraleloLabel: "24h" });
  const [refreshTick, setRefreshTick] = useState(0);
  const [activeTab, setActiveTab] = useState("markets");
  const [newsDaily, setNewsDaily] = useState({
    summary: "",
    macroeconomia: [],
    geopolitica: [],
    generatedAt: "",
    validUntil: "",
    sourceCount: 0,
    cacheHit: false,
  });
  const [lastTs, setLastTs] = useState({
    btc: null,
    oro: null,
    plata: null,
    petroleo: null,
    sp500: null,
    oficial: null,
    paralelo: null,
  });

  const [prices, setPrices] = useState({
    btc: null,
    oro: null,
    plata: null,
    petroleo: null,
    sp500: null,
    oficial: null,
    paralelo: null,
  });

  const [series, setSeries] = useState({
    btc: [],
    oro: [],
    plata: [],
    petroleo: [],
    sp500: [],
    oficial: [],
    paralelo: [],
  });

  const [changes, setChanges] = useState({
    btc: null,
    oro: null,
    plata: null,
    petroleo: null,
    sp500: null,
    oficial: null,
    paralelo: null,
  });

  const [history, setHistory] = useState({});

  const cargarDatos = async () => {
    try {
      setLoading(true);
      setError("");

      const [
        btcSimpleRes,
        btcChartRes,
        btcYahooChartRes,
        oficialRes,
        paraleloFallbackRes,
        oroSpotRes,
        plataSpotRes,
        oroChartRes,
        plataChartRes,
        petroleoChartRes,
        sp500ChartRes,
        p2pBuyRes,
        p2pSellRes,
        pizzaRes,
        polyRes,
      ] = await Promise.all([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"),
        fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=2&interval=hourly"),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1h&range=5d"),
        fetch("https://ve.dolarapi.com/v1/dolares/oficial"),
        fetch("https://ve.dolarapi.com/v1/dolares/paralelo"),
        fetch("https://api.gold-api.com/price/XAU"),
        fetch("https://api.gold-api.com/price/XAG"),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/GLD?interval=1h&range=5d"),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/SLV?interval=1h&range=5d"),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1h&range=5d"),
        fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1h&range=5d"),
        fetchP2P("BUY"),
        fetchP2P("SELL"),
        fetch("https://www.pizzint.watch/api/dashboard-data"),
        fetch("https://www.pizzint.watch/api/markets/breaking?window=30m"),
      ]);

      const [
        btcSimple,
        btcChart,
        btcYahooChart,
        oficialJson,
        paraleloFallback,
        oroSpot,
        plataSpot,
        oroChart,
        plataChart,
        petroleoChart,
        sp500Chart,
        p2pBuy,
        p2pSell,
        pizzaJson,
        polyJson,
      ] = await Promise.all([
        btcSimpleRes.json(),
        btcChartRes.json(),
        btcYahooChartRes.json(),
        oficialRes.json(),
        paraleloFallbackRes.json(),
        oroSpotRes.json(),
        plataSpotRes.json(),
        oroChartRes.json(),
        plataChartRes.json(),
        petroleoChartRes.json(),
        sp500ChartRes.json(),
        p2pBuyRes,
        p2pSellRes,
        pizzaRes.json(),
        polyRes.json(),
      ]);

      const p2pBuyAvg = avgTopPrices(p2pBuy);
      const p2pSellAvg = avgTopPrices(p2pSell);
      const p2pMid = p2pBuyAvg !== null && p2pSellAvg !== null ? (p2pBuyAvg + p2pSellAvg) / 2 : null;
      const pizzaRows = Array.isArray(pizzaJson?.data) ? pizzaJson.data : [];
      const pizzaScore = average(pizzaRows.map((r) => r?.current_popularity));
      const pizzaSpikes = pizzaRows.filter((r) => r?.is_spike).length;
      const pizzaSeries = buildPizzaSeries(pizzaRows);
      const pizzaPct = pctFromSeries(pizzaSeries, 24);

      const polyMarketsRaw = Array.isArray(polyJson?.markets) ? polyJson.markets : [];
      const topPoly = [...polyMarketsRaw]
        .sort((a, b) => (toNumber(b?.volume_24h) ?? 0) - (toNumber(a?.volume_24h) ?? 0))
        .slice(0, 4)
        .map((m) => ({
          constYes: toNumber(m?.latest_price ?? m?.price ?? m?.end_price_24h ?? m?.last_price),
          title: shortTitle(m?.title || m?.label || m?.slug || "Market"),
          url: m?.url || (m?.slug ? `https://polymarket.com/market/${m.slug}` : ""),
          changeRaw: toNumber(m?.price_movement),
          vol24h: toNumber(m?.volume_24h),
        }))
        .map((m) => {
          const yesPct = m.constYes !== null ? Math.max(0, Math.min(100, m.constYes * 100)) : null;
          const noPct = yesPct !== null ? 100 - yesPct : null;
          const change = m.changeRaw !== null ? (Math.abs(m.changeRaw) <= 1 ? m.changeRaw * 100 : m.changeRaw) : null;
          return {
            title: m.title,
            url: m.url,
            change,
            vol24h: m.vol24h,
            yesPct,
            noPct,
          };
        });

      const btcSeriesCoingecko = compactSeries((btcChart?.prices || []).map((p) => p?.[1]), 48);
      const btcSeriesYahoo = compactSeries(btcYahooChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close, 48);
      const btcSeriesFinal = btcSeriesCoingecko.length ? btcSeriesCoingecko : btcSeriesYahoo;
      const btcTsFromCg = Array.isArray(btcChart?.prices) && btcChart.prices.length ? toNumber(btcChart.prices[btcChart.prices.length - 1]?.[0]) : null;
      const btcYLast = Array.isArray(btcYahooChart?.chart?.result?.[0]?.timestamp) && btcYahooChart.chart.result[0].timestamp.length
        ? toNumber(btcYahooChart.chart.result[0].timestamp[btcYahooChart.chart.result[0].timestamp.length - 1])
        : null;
      const oroYLast = Array.isArray(oroChart?.chart?.result?.[0]?.timestamp) && oroChart.chart.result[0].timestamp.length
        ? toNumber(oroChart.chart.result[0].timestamp[oroChart.chart.result[0].timestamp.length - 1])
        : null;
      const plataYLast = Array.isArray(plataChart?.chart?.result?.[0]?.timestamp) && plataChart.chart.result[0].timestamp.length
        ? toNumber(plataChart.chart.result[0].timestamp[plataChart.chart.result[0].timestamp.length - 1])
        : null;
      const wtiYLast = Array.isArray(petroleoChart?.chart?.result?.[0]?.timestamp) && petroleoChart.chart.result[0].timestamp.length
        ? toNumber(petroleoChart.chart.result[0].timestamp[petroleoChart.chart.result[0].timestamp.length - 1])
        : null;
      const spYLast = Array.isArray(sp500Chart?.chart?.result?.[0]?.timestamp) && sp500Chart.chart.result[0].timestamp.length
        ? toNumber(sp500Chart.chart.result[0].timestamp[sp500Chart.chart.result[0].timestamp.length - 1])
        : null;
      const btcTsFromY = btcYLast !== null ? btcYLast * 1000 : null;
      const yOroTs = oroYLast !== null ? oroYLast * 1000 : null;
      const yPlataTs = plataYLast !== null ? plataYLast * 1000 : null;
      const yWtiTs = wtiYLast !== null ? wtiYLast * 1000 : null;
      const ySpTs = spYLast !== null ? spYLast * 1000 : null;
      const nextLastTs = {
        btc: btcTsFromCg ?? btcTsFromY ?? lastTs.btc,
        oro: toTs(oroSpot?.updatedAt) ?? yOroTs ?? lastTs.oro,
        plata: toTs(plataSpot?.updatedAt) ?? yPlataTs ?? lastTs.plata,
        petroleo: yWtiTs ?? lastTs.petroleo,
        sp500: ySpTs ?? lastTs.sp500,
        oficial: toTs(oficialJson?.fechaActualizacion) ?? lastTs.oficial,
        paralelo: p2pMid !== null ? Date.now() : (toTs(paraleloFallback?.fechaActualizacion) ?? toTs(paraleloFallback?.fecha) ?? lastTs.paralelo),
      };

      const nextPrices = {
        btc: toNumber(btcSimple?.bitcoin?.usd) ?? lastNumber(btcSeriesFinal) ?? prices.btc,
        oro: toNumber(oroSpot?.price) ?? prices.oro,
        plata: toNumber(plataSpot?.price) ?? prices.plata,
        petroleo: lastNumber(petroleoChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close) ?? prices.petroleo,
        sp500: lastNumber(sp500Chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close) ?? prices.sp500,
        oficial: toNumber(oficialJson?.promedio) ?? prices.oficial,
        paralelo: p2pMid ?? toNumber(paraleloFallback?.promedio) ?? prices.paralelo,
      };

      const nextSeries = {
        btc: btcSeriesFinal,
        oro: compactSeries(oroChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close, 48),
        plata: compactSeries(plataChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close, 48),
        petroleo: compactSeries(petroleoChart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close, 48),
        sp500: compactSeries(sp500Chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close, 48),
        oficial: series.oficial,
        paralelo: series.paralelo,
      };

      const nowTs = Date.now();
      const nextHistory = updateHistory(history, { ...nextPrices, pizzaIndex: pizzaScore }, nowTs);
      nextSeries.oficial = valuesFromHistory(nextHistory, "oficial");
      nextSeries.paralelo = valuesFromHistory(nextHistory, "paralelo");
      const pizzaHistoricalSeries = valuesFromHistory(nextHistory, "pizzaIndex");
      const pizzaNormal = average(pizzaHistoricalSeries.length ? pizzaHistoricalSeries : pizzaSeries);
      const oficialInfo = pct24hFromHistoryInfo(nextHistory, "oficial");
      const paraleloInfo = pct24hFromHistoryInfo(nextHistory, "paralelo");

      const nextChanges = {
        btc: toNumber(btcSimple?.bitcoin?.usd_24h_change) ?? pctFromSeries(nextSeries.btc, 24),
        oro: pctFromSeries(nextSeries.oro, 24),
        plata: pctFromSeries(nextSeries.plata, 24),
        petroleo: pctFromSeries(nextSeries.petroleo, 24),
        sp500: pctFromSeries(nextSeries.sp500, 24),
        oficial: oficialInfo.pct,
        paralelo: paraleloInfo.pct,
      };

      setPrices(nextPrices);
      setSeries(nextSeries);
      setChanges(nextChanges);
      setHistory(nextHistory);
      setUpdatedAt(oficialJson?.fechaActualizacion ?? new Date().toISOString());
      setLastTs(nextLastTs);
      setPizzaIndex({ score: pizzaScore, pct24h: pizzaPct, spikes: pizzaSpikes, series: pizzaSeries, normal: pizzaNormal });
      setUsdMeta({
        oficialLabel: oficialInfo.mode === "24h" ? "24h" : oficialInfo.mode === "since_start" ? "Desde inicio" : "24h",
        paraleloLabel: paraleloInfo.mode === "24h" ? "24h" : paraleloInfo.mode === "since_start" ? "Desde inicio" : "24h",
      });
      setPolyTrends(topPoly);

      if (p2pBuyAvg !== null && p2pSellAvg !== null) {
        setParallelInfo(`P2P USDT/VES promedio top 8: BUY ${p2pBuyAvg.toFixed(3)} | SELL ${p2pSellAvg.toFixed(3)}`);
      } else {
        setParallelInfo("P2P no disponible, usando fallback de DolarApi");
      }

      let nextNewsDaily = newsDaily;
      if (API_BASE) {
        try {
          const forceNews = typeof newsDaily?.summary === "string" && newsDaily.summary.includes("OPENAI_API_KEY no configurada");
          const newsRes = await fetch(`${API_BASE}/api/news/daily-brief${forceNews ? "?force=1" : ""}`);
          const newsJson = await newsRes.json();
          if (newsJson?.ok && newsJson?.data?.brief) {
            nextNewsDaily = {
              summary: newsJson.data.brief.summary || "",
              macroeconomia: Array.isArray(newsJson.data.brief.macroeconomia) ? newsJson.data.brief.macroeconomia.slice(0, 3) : [],
              geopolitica: Array.isArray(newsJson.data.brief.geopolitica) ? newsJson.data.brief.geopolitica.slice(0, 3) : [],
              generatedAt: newsJson.data.generatedAt || "",
              validUntil: newsJson.data.validUntil || "",
              sourceCount: Number(newsJson.data.articleCount || 0),
              cacheHit: Boolean(newsJson.data.cacheHit),
            };
            setNewsDaily(nextNewsDaily);
          }
        } catch {
          // keep previous news card state if server is unavailable
        }
      }

      await writeCache({
        prices: nextPrices,
        series: nextSeries,
        changes: nextChanges,
        history: nextHistory,
        updatedAt: oficialJson?.fechaActualizacion ?? new Date().toISOString(),
        pizzaIndex: { score: pizzaScore, pct24h: pizzaPct, spikes: pizzaSpikes, series: pizzaSeries, normal: pizzaNormal },
        polyTrends: topPoly,
        usdMeta: {
          oficialLabel: oficialInfo.mode === "24h" ? "24h" : oficialInfo.mode === "since_start" ? "Desde inicio" : "24h",
          paraleloLabel: paraleloInfo.mode === "24h" ? "24h" : paraleloInfo.mode === "since_start" ? "Desde inicio" : "24h",
        },
        newsDaily: nextNewsDaily,
        lastTs: nextLastTs,
        parallelInfo: p2pBuyAvg !== null && p2pSellAvg !== null
          ? `P2P USDT/VES promedio top 8: BUY ${p2pBuyAvg.toFixed(3)} | SELL ${p2pSellAvg.toFixed(3)}`
          : "P2P no disponible, usando fallback de DolarApi",
      });
    } catch (e) {
      setError(e?.message || "No se pudieron cargar los datos.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const cache = await readCache();
      if (cache && mounted) {
        setPrices(cache.prices || prices);
        setSeries(cache.series || series);
        setChanges(cache.changes || changes);
        setHistory(cache.history || {});
        setUpdatedAt(cache.updatedAt || "");
        setParallelInfo(cache.parallelInfo || "");
        setPizzaIndex(cache.pizzaIndex || { score: null, pct24h: null, spikes: 0, series: [], normal: null });
        setPolyTrends(cache.polyTrends || []);
        setUsdMeta(cache.usdMeta || { oficialLabel: "24h", paraleloLabel: "24h" });
        setNewsDaily(cache.newsDaily || {
          summary: "",
          macroeconomia: [],
          geopolitica: [],
          generatedAt: "",
          validUntil: "",
          sourceCount: 0,
          cacheHit: false,
        });
        setLastTs(cache.lastTs || {
          btc: null,
          oro: null,
          plata: null,
          petroleo: null,
          sp500: null,
          oficial: null,
          paralelo: null,
        });
      }
      if (mounted) await cargarDatos();
    };

    init();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setRefreshTick((v) => v + 1);
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (refreshTick > 0) {
      cargarDatos();
    }
  }, [refreshTick]);

  const nowTs = Date.now();
  const closed = {
    btc: isClosedByAge(lastTs.btc, 90, nowTs),
    oro: isClosedByAge(lastTs.oro, 240, nowTs),
    plata: isClosedByAge(lastTs.plata, 240, nowTs),
    petroleo: isClosedByAge(lastTs.petroleo, 240, nowTs),
    sp500: isClosedByAge(lastTs.sp500, 240, nowTs),
    oficial: isClosedByAge(lastTs.oficial, 720, nowTs),
    paralelo: isClosedByAge(lastTs.paralelo, 180, nowTs),
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {loading ? (
        <View style={styles.loadingBadge}>
          <ActivityIndicator color="#f0b90b" size="small" />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Dossier</Text>
        <Text style={styles.subtitle}>{activeTab === "markets" ? "Markets" : "Resumen de prensa del dia"}</Text>

        <View style={styles.tabBar}>
          <Pressable style={[styles.tabBtn, activeTab === "markets" ? styles.tabBtnActive : null]} onPress={() => setActiveTab("markets")}>
            <Text style={[styles.tabBtnText, activeTab === "markets" ? styles.tabBtnTextActive : null]}>Markets</Text>
          </Pressable>
          <Pressable style={[styles.tabBtn, activeTab === "news" ? styles.tabBtnActive : null]} onPress={() => setActiveTab("news")}>
            <Text style={[styles.tabBtnText, activeTab === "news" ? styles.tabBtnTextActive : null]}>Resumen de prensa del dia</Text>
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {activeTab === "markets" ? (
          <>
            <View style={styles.panel}>
              <Row label="BTC" valueText={fmtMoney(prices.btc)} pct24h={changes.btc} series={series.btc} lastTs={lastTs.btc} marketClosed={closed.btc} />
              <Row label="Gold (XAU)" valueText={fmtMoney(prices.oro)} pct24h={changes.oro} series={series.oro} lastTs={lastTs.oro} marketClosed={closed.oro} />
              <Row label="Silver (XAG)" valueText={fmtMoney(prices.plata)} pct24h={changes.plata} series={series.plata} lastTs={lastTs.plata} marketClosed={closed.plata} />
              <Row label="WTI" valueText={fmtMoney(prices.petroleo)} pct24h={changes.petroleo} series={series.petroleo} lastTs={lastTs.petroleo} marketClosed={closed.petroleo} />
              <Row label="S&P 500" valueText={fmtMoney(prices.sp500)} pct24h={changes.sp500} series={series.sp500} lastTs={lastTs.sp500} marketClosed={closed.sp500} />
              <Row
                label="USD Oficial"
                valueText={fmtBs(prices.oficial)}
                pct24h={changes.oficial}
                pctText={fmtPctCustom(changes.oficial, usdMeta.oficialLabel)}
                series={series.oficial}
                lastTs={lastTs.oficial}
                marketClosed={closed.oficial}
              />
              <Row
                label="USD Paralelo P2P"
                valueText={fmtBs(prices.paralelo)}
                pct24h={changes.paralelo}
                pctText={fmtPctCustom(changes.paralelo, usdMeta.paraleloLabel)}
                series={series.paralelo}
                lastTs={lastTs.paralelo}
                marketClosed={closed.paralelo}
              />
            </View>

            <Text style={styles.info}>{parallelInfo}</Text>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Indice Pizzerias Washington</Text>
              <Text style={styles.sectionValue}>{pizzaIndex.score !== null ? `${pizzaIndex.score.toFixed(1)} / 100` : "--"}</Text>
              <Text style={[styles.sectionMeta, (pizzaIndex.pct24h ?? 0) >= 0 ? styles.up : styles.down]}>{fmtPct(pizzaIndex.pct24h)}</Text>
              <Text style={styles.sectionMeta}>Spikes activos: {pizzaIndex.spikes}</Text>
              <Text style={styles.sectionMeta}>Linea amarilla: nivel normal (promedio historico local, 30 dias)</Text>
              <MiniChart series={pizzaIndex.series} positive={(pizzaIndex.pct24h ?? 0) >= 0} baselineValue={pizzaIndex.normal} />
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Polymarket Tendencias (30m)</Text>
              {polyTrends.length ? polyTrends.map((m, idx) => (
                <View key={`${m.title}-${idx}`} style={styles.trendRow}>
                  <Text style={styles.trendTitle}>{idx + 1}. {m.title}</Text>
                  <Text style={[styles.trendMeta, (m.change ?? 0) >= 0 ? styles.up : styles.down]}>
                    {m.change !== null ? `${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)}%` : "N/D"}
                  </Text>
                  <Text style={styles.trendMeta2}>
                    Yes: {m.yesPct !== null ? `${m.yesPct.toFixed(1)}%` : "N/D"} | No: {m.noPct !== null ? `${m.noPct.toFixed(1)}%` : "N/D"}
                  </Text>
                  <Text style={styles.trendMeta2}>Vol24h: {m.vol24h !== null ? `$${m.vol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "N/D"}</Text>
                </View>
              )) : <Text style={styles.trendMeta2}>Sin datos por ahora.</Text>}
            </View>
          </>
        ) : (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Resumen de Prensa Diario (Economia + Geopolitica)</Text>
            {newsDaily.summary ? (
              <>
                <Text style={styles.sectionMeta}>Generado: {fmtIso(newsDaily.generatedAt)} | Valido hasta: {fmtIso(newsDaily.validUntil)}</Text>
                <Text style={styles.sectionMeta}>Articulos analizados: {newsDaily.sourceCount} | Cache 24h: {newsDaily.cacheHit ? "si" : "no"}</Text>
                <Text style={styles.newsSummary}>{newsDaily.summary}</Text>
                {newsDaily.macroeconomia.length ? <Text style={styles.newsSub}>Macroeconomia</Text> : null}
                {newsDaily.macroeconomia.map((x, i) => <Text key={`m-${i}`} style={styles.trendMeta2}>- {x}</Text>)}
                {newsDaily.geopolitica.length ? <Text style={styles.newsSub}>Geopolitica</Text> : null}
                {newsDaily.geopolitica.map((x, i) => <Text key={`g-${i}`} style={styles.trendMeta2}>- {x}</Text>)}
              </>
            ) : (
              <Text style={styles.trendMeta2}>
                Sin resumen diario aun. Configura `EXPO_PUBLIC_API_BASE_URL` y levanta `npm run server`.
              </Text>
            )}
          </View>
        )}

        <Text style={styles.updated}>{updatedAt ? `Actualizado: ${updatedAt}` : ""}</Text>

        <Pressable style={styles.button} onPress={cargarDatos}>
          <Text style={styles.buttonText}>Actualizar</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0b1220",
  },
  container: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 30,
    gap: 10,
  },
  title: {
    color: "#f5f5f5",
    fontSize: 32,
    fontWeight: "700",
  },
  subtitle: {
    color: "#8892a0",
    fontSize: 16,
    marginBottom: 6,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#141e2f",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#202b3f",
    padding: 4,
    gap: 6,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  tabBtnActive: {
    backgroundColor: "#1f2c45",
  },
  tabBtnText: {
    color: "#8f9bab",
    fontSize: 12,
    fontWeight: "600",
  },
  tabBtnTextActive: {
    color: "#f0f4fa",
  },
  panel: {
    backgroundColor: "#141e2f",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#202b3f",
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#202b3f",
  },
  leftCol: {
    flex: 1,
    paddingRight: 8,
    gap: 2,
  },
  labelLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  chartCol: {
    width: 96,
    alignItems: "flex-end",
  },
  rowLabel: {
    color: "#c7d0dc",
    fontSize: 13,
  },
  rowValue: {
    color: "#f5f7fb",
    fontSize: 24,
    fontWeight: "700",
  },
  rowPct: {
    fontSize: 13,
    fontWeight: "600",
  },
  lastData: {
    color: "#95a1b3",
    fontSize: 11,
  },
  closedBadge: {
    backgroundColor: "#3a2a16",
    color: "#f0b90b",
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  up: {
    color: "#00c087",
  },
  down: {
    color: "#f6465d",
  },
  noChart: {
    color: "#6a7382",
    fontSize: 14,
  },
  loadingBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 20,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(20,30,47,0.85)",
    borderWidth: 1,
    borderColor: "#2b3a55",
  },
  error: {
    color: "#f6465d",
    fontSize: 12,
  },
  info: {
    color: "#8f9bab",
    fontSize: 12,
    marginTop: 4,
  },
  sectionCard: {
    backgroundColor: "#141e2f",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#202b3f",
    padding: 12,
    gap: 6,
    marginTop: 8,
  },
  sectionTitle: {
    color: "#dce3ec",
    fontSize: 14,
    fontWeight: "700",
  },
  sectionValue: {
    color: "#f5f7fb",
    fontSize: 24,
    fontWeight: "700",
  },
  sectionMeta: {
    color: "#9aa6b8",
    fontSize: 12,
  },
  trendRow: {
    borderTopWidth: 1,
    borderTopColor: "#202b3f",
    paddingTop: 8,
    marginTop: 2,
  },
  trendTitle: {
    color: "#f1f5fb",
    fontSize: 13,
    fontWeight: "600",
  },
  trendMeta: {
    fontSize: 12,
    fontWeight: "600",
  },
  trendMeta2: {
    color: "#95a1b3",
    fontSize: 12,
  },
  newsSummary: {
    color: "#dbe2ec",
    fontSize: 13,
    lineHeight: 19,
  },
  newsSub: {
    color: "#f1f5fb",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  updated: {
    color: "#6f7b8d",
    fontSize: 12,
  },
  button: {
    backgroundColor: "#f0b90b",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#111827",
    fontWeight: "700",
    fontSize: 16,
  },
});
