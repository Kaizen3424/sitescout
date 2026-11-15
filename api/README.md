# SiteScout API

TypeScript HTTP API around the same pipeline as the Python CLI. Runs as one
Vercel Function. Personal, open-source, non-commercial project, so it fits
Vercel's free Hobby plan.

**Deployed at:** <https://sitescout-dusky.vercel.app> — `main` auto-deploys.

## Endpoints

### `POST /v1/analyze`

Header: `Authorization: Bearer <SITESCOUT_API_TOKEN>`

```json
{ "urls": ["arngren.net", "funda.nl"], "fresh": false }
```

`urls` accepts 1–5 entries (a single `"url": "..."` also works). `fresh: true`
ignores cached Gemini answers. The response contains one report per URL, using
the same field names as the CLI's `report.json`:

```json
{
  "ok": true,
  "count": 1,
  "results": [
    {
      "input_url": "https://arngren.net",
      "verdict": "REACH_OUT",
      "need_score": 0.86,
      "design_quality": 0.104,
      "image": { "mime": "image/png", "width": 1440, "height": 2587, "bytes": 4066507 },
      "scores": { "visual_modernity": { "score_0_to_10": 1.2, "confidence": 0.91 } },
      "reasons": ["Redesign need 0.86 is above the reach-out threshold (0.60)."],
      "issues": [{ "label": "...", "phrase": "...", "severity": 0.9 }]
    }
  ],
  "totals": { "REACH_OUT": 1 },
  "elapsed_s": 61.2
}
```

A failing URL returns `UNSCORED` or `SITE_DOWN` with a reason; it never fails the
whole batch. Status codes: `400` bad body, `401` bad token, `404` unknown path,
`405` wrong method, `500` missing configuration.

An unknown path is answered by Vercel's own `404` page, so its body is HTML
rather than JSON. A request that runs out of its time budget still answers with
`200` and JSON: URLs that did not finish carry `deadline_exceeded: true` and a
reason. Send them again in a smaller batch.

### `GET /health`

No token. Returns key counts (never key values), model name and request limits,
or `503` when configuration is incomplete.

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FIRECRAWL_API_KEYS` | yes | — | One or more keys, comma-separated. |
| `GEMINI_API_KEYS` | yes | — | One or more keys, comma-separated. |
| `SITESCOUT_API_TOKEN` | yes | — | Bearer token clients must send. |
| `SITESCOUT_MAX_URLS` | no | `5` | URLs per request (max 10). |
| `SITESCOUT_CONCURRENCY` | no | `3` | URLs analysed in parallel. |
| `SITESCOUT_MODEL` | no | `gemini-decision-1` | Decisions model. |
| `SITESCOUT_IMAGE_RESOLUTION` | no | `high` | Gemini's own image setting (`low`/`medium`/`high`/`ultra_high`). |
| `SITESCOUT_REACH_OUT_THRESHOLD` | no | `0.60` | Verdict threshold. |
| `SITESCOUT_MAYBE_THRESHOLD` | no | `0.40` | Verdict threshold. |
| `SITESCOUT_REQUEST_DEADLINE_MS` | no | `270000` | Internal stop before Vercel's 300 s limit. |
| `SITESCOUT_MAX_IMAGE_BYTES` | no | `18874368` | Safety stop below Google's 20 MB inline limit. |

The image itself is **never** cropped, resized or recompressed. The size in the
report is the full-page capture from Firecrawl.

## Local development

```powershell
npm install
vercel login
vercel link          # create/link the project
vercel dev           # downloads Development env vars automatically
```

Then call it:

```powershell
curl.exe -X POST http://localhost:3000/v1/analyze `
  -H "Authorization: Bearer $env:SITESCOUT_API_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"urls":["arngren.net"]}'
```

Prefer the key-value file for other tools: `vercel env pull .env.local`.

## Deploy

1. Create a free account at <https://vercel.com>.
2. `npm i -g vercel`, then in the repo root: `vercel login` and `vercel link`.
3. In the dashboard: **Project → Settings → Environment Variables** and add
   `FIRECRAWL_API_KEYS`, `GEMINI_API_KEYS`, `SITESCOUT_API_TOKEN` for
   **Production** and **Preview**.
4. `vercel --prod`.

## Notes and limits

- Vercel Hobby: 300 s per request, 512 MB–2 GB memory, 1 M invocations/month.
  5 URLs at 3-way concurrency normally finishes in 60–150 s.
- The internal budget stops at 270 s (configurable, clamped to 280 s) and aborts
  in-flight work, so a slow batch always answers with JSON inside Vercel's 300 s
  limit instead of being killed with an HTML 504.
- Runtime Cache items are capped at 2 MB, so screenshots are not cached. Gemini
  answers are cached for 72 h, keyed by the page's HTML content, so re-running an
  unchanged page spends Firecrawl credits but no Gemini quota.
- Each URL costs 1 Firecrawl credit and 3 Gemini calls.
- Hobby is for non-commercial use. Ads, paid access, or client lead-generation
  would require Vercel Pro; Cloudflare Workers Paid is the cheaper paid fallback.
