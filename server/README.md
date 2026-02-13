# Dossier AI Server

## 1) Create env
Copy `server/.env.example` to `server/.env` and set `OPENAI_API_KEY`.

## 2) Run
`npm run server`

## 3) Health
`GET http://localhost:8787/health`

## 4) OSINT brief endpoint
`POST http://localhost:8787/api/brief`

Body JSON:
{
  "scope": "osint",
  "text": "Pegas aqui titulares o reportes"
}

## 5) Daily press brief endpoint (24h cache)
`GET http://localhost:8787/api/news/daily-brief`

Notes:
- It pulls headlines from international outlets (BBC, WSJ, ABC, NYPost, The Economist, optional Reuters).
- It generates one AI brief and caches it for 24h.
- You can force refresh: `GET /api/news/daily-brief?force=1`

## 6) Connect mobile app
In project root `.env` add:
`EXPO_PUBLIC_API_BASE_URL=http://TU_IP_LOCAL:8787`

Example:
`EXPO_PUBLIC_API_BASE_URL=http://192.168.1.25:8787`
