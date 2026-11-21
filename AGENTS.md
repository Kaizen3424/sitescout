# SiteScout — project context

Judges whether a business website is worth pitching a redesign to. Personal,
open-source, educational project: **non-commercial**, no ads, no client work.
That is what allows the API to run on Vercel's free Hobby plan.

## Four parts, one pipeline

| Part | Where | What |
|------|-------|------|
| Python CLI | `cli/` (`sitescout.py`, `cli.py`, ...) | Local batch tool, one line per site, writes one `report.json`. |
| TypeScript API | `api/` | HTTP wrapper around the same pipeline, deployed on Vercel. |
| Web interface | `web/` | Static page at `/`: paste 1–50 URLs, close the browser, come back for the reports. Also `/lists`: the permanent lists (see below). |
| Lists | `api/_lib/lists.ts` | Permanent copies of finished reports: status, notes, tags, history. |

The CLI is the reference implementation. The API must produce the same verdicts
and the same report field names. The page has no build step and no framework:
plain HTML, CSS and one ES module.

Lists are the part that outlives a batch: they copy finished reports out of a
batch into permanent rows, one per domain, with outreach status, notes, tags and
a short history. Batches keep their 30-day TTL; lists have none. Nothing is added
automatically — the page calls `importJob` or `importReports` only when the owner
presses Add. Lists never call Firecrawl, Gemini or QStash.

Workflow: test and iterate in `cli/`; once a change is finalised, port it to
`api/` and deploy.

**Production:** https://sitescout-dusky.vercel.app — the page at `/`, the JSON
index at `/v1`. Deployed from the `main` branch of
`https://github.com/Kaizen3424/sitescout` — pushing to `main` redeploys it.

## Rules that must not be broken

- **Three viewport-sized frames, untouched.** One Firecrawl scrape returns the
  first screen, the middle and the bottom as 1440×900 screenshots. No crop, no
  resize, no upload budget in the API. Only Google's 20 MB inline limit per image
  is enforced (above it: `UNSCORED`). All three go to the design call; only the
  first goes to verdict/page. Never go back to a full-page strip: Firecrawl's
  100,000 px viewport breaks scroll-animated layouts, and the downscaled strip
  made the scores inconsistent.
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
- **Lists are public by link too.** With no `SITESCOUT_LIST_KEY` the link is the
  secret and management is open; with a key, writes need `x-sitescout-list-key`
  and private lists answer 404 without it. Never add a session or user table.
- **Nothing is added to a list automatically.** `POST /v1/jobs` only registers the
  batch for the picker; importing is an explicit call.
- `/v1/analyze` stays token-protected; the batch endpoints do not use the token.
- `/v1/jobs/run` accepts only genuine QStash callbacks: verify the signature
  against `${origin}/v1/jobs/run`, never against `request.url`.

## Commands

```powershell
python cli/sitescout.py https://example.com  # CLI, one site (from repo root)
npx tsc --noEmit                            # type-check the API
node --check web/app.js                     # syntax-check the page's script
vercel dev                                  # API + page locally (needs login/link)
vercel --prod                               # deploy
```

Or `cd cli` first and run `python sitescout.py ...` — both work. The CLI reads
its keys from `cli/.env`; `report.json` lands in the folder you run from.

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
- `api/_lib/lists.ts` — permanent lists: merge rules, caps, key, rate limits,
  CSV, backup/restore. Key space is `ss:list:*` and has no TTL.
- `api/_lib/jobrunner.ts` — analyses exactly one URL per callback.
- `api/_lib/redis.ts` — REST client; `hgetall` returns a flat array in raw mode.
- `api/README.md` — endpoint contract, env vars, deploy steps.
- `web/index.html`, `web/styles.css`, `web/app.js` — the page.
- `test/lists.model.test.ts` — merge rules without Redis.
- `test/lists.redis.test.ts` — the store against real Redis (unique namespace per
  test, skipped without credentials).
- `test/lists.api.test.ts` — the real handler, key handling and the public view.
- `vercel.json` — rewrites (`/`, `/j/:id`, `/lists`, `/l/:id` → the page) and the
  300 s limit. `/v1/jobs/run` must stay before `/v1/jobs/:id`, and
  `/v1/lists/import` + `/v1/lists/reports` before `/v1/lists/:id`.
- `tsconfig.json`, `package.json` — build config (Vercel only reads these from the
  repo root). `tsconfig.json` covers `api/` only; `web/` is not type-checked.
