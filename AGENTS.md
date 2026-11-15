# SiteScout — project context

Judges whether a business website is worth pitching a redesign to. Personal,
open-source, educational project: **non-commercial**, no ads, no client work.
That is what allows the API to run on Vercel's free Hobby plan.

## Three parts, one pipeline

| Part | Where | What |
|------|-------|------|
| Python CLI | repo root (`sitescout.py`, `cli.py`, ...) | Local batch tool, one line per site, writes one `report.json`. |
| TypeScript API | `api/` | HTTP wrapper around the same pipeline, deployed on Vercel. |
| Web interface | `web/` | Static page at `/`: paste 1–50 URLs, close the browser, come back for the reports. |

The CLI is the reference implementation. The API must produce the same verdicts
and the same report field names. The page has no build step and no framework:
plain HTML, CSS and one ES module.

**Production:** https://sitescout-dusky.vercel.app — the page at `/`, the JSON
index at `/v1`. Deployed from the `main` branch of
`https://github.com/Kaizen3424/sitescout` — pushing to `main` redeploys it.

## Rules that must not be broken

- **One full-page screenshot, untouched.** No crop, no resize, no upload budget in
  the API. Only Google's 20 MB inline limit is enforced (above it: `UNSCORED`).
- **Three separate Gemini Decisions calls** per site (design / verdict / page).
  Never merge them into one call.
- **API keys come from the environment only**: `.env` for the CLI, `.env.local`
  locally and Vercel Environment Variables in production. Never in code or Git.
  The same goes for the Upstash Redis and QStash credentials.
- **The Python CLI's behaviour and output stay as they are**, including the single
  `report.json`.
- Keep the API to Vercel Hobby limits: 300 s per request, 5 URLs per request for
  `/v1/analyze`, 3 in parallel.
- **Batch work runs on QStash, never in the browser.** One message per URL, so a
  closed tab cannot stop a batch, and no Vercel cron is needed (Hobby allows one
  run per day, which is useless here).
- **The web form is public**: no login. Abuse protection is the Redis quota
  (batches per IP per hour, URLs per day globally), not a token.
- `/v1/analyze` stays token-protected; the batch endpoints do not use the token.
- `/v1/jobs/run` accepts only genuine QStash callbacks: verify the signature
  against `${origin}/v1/jobs/run`, never against `request.url`.

## Commands

```powershell
python sitescout.py https://example.com     # CLI, one site
npx tsc --noEmit                            # type-check the API
node --check web/app.js                     # syntax-check the page's script
vercel dev                                  # API + page locally (needs login/link)
vercel --prod                               # deploy
```

`vercel dev` needs Redis/QStash credentials for the batch form. For a quick local
run without a public callback URL:

```powershell
$env:SITESCOUT_JOBS_INLINE = "1"
vercel dev
```

Testing production (token is in `.env.local`):

```powershell
curl.exe -s https://sitescout-dusky.vercel.app/health
curl.exe -s -X POST https://sitescout-dusky.vercel.app/v1/analyze `
  -H "Authorization: Bearer $env:SITESCOUT_API_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"urls":["arngren.net"]}'
curl.exe -s -X POST https://sitescout-dusky.vercel.app/v1/jobs `
  -H "Content-Type: application/json" `
  -d '{"urls":["arngren.net"]}'
```

## Layout

- `api/index.ts` — the single Vercel function (routing, auth, batching).
- `api/_lib/` — port of the Python modules. The `_` prefix keeps Vercel from
  deploying each file as its own function.
- `api/_lib/jobs.ts` — job store in Upstash Redis, quota counters, QStash
  dispatch and signature checks.
- `api/_lib/jobrunner.ts` — analyses exactly one URL per callback.
- `api/_lib/redis.ts` — REST client; `hgetall` returns a flat array in raw mode.
- `api/README.md` — endpoint contract, env vars, deploy steps.
- `web/index.html`, `web/styles.css`, `web/app.js` — the page.
- `vercel.json` — rewrites (`/` and `/j/:id` → the page) and the 300 s limit.
  `/v1/jobs/run` must stay before `/v1/jobs/:id`.
- `tsconfig.json`, `package.json` — build config (Vercel only reads these from the
  repo root). `tsconfig.json` covers `api/` only; `web/` is not type-checked.
