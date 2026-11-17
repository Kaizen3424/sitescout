# SiteScout API

TypeScript HTTP API around the same pipeline as the Python CLI, plus the public
batch interface in [`web/`](../web). Runs as one Vercel Function. Personal,
open-source, non-commercial project, so it fits Vercel's free Hobby plan.

**Deployed at:** <https://sitescout-dusky.vercel.app> — `main` auto-deploys.
The batch interface is the site root; the JSON index moved to `/v1` because `/`
now serves a page.

## Two ways to analyse

| Endpoint | Wait for the answer? | Limit | Auth |
|----------|----------------------|-------|------|
| `POST /v1/analyze` | Yes, inside the request | 5 URLs | Bearer token |
| `POST /v1/jobs` | No, it runs in the background | 50 URLs | None (rate-limited) |

The web page uses only `/v1/jobs`, so a batch survives a closed tab, a closed
browser or a phone that lost its connection.

## Endpoints

### `GET /v1`

No auth. Name, version and a list of the endpoints below. `/` serves the web
interface instead of JSON.

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
      "need_score": 0.79,
      "design_quality": 0.26,
      "need_parts": { "visual": 0.48, "navigation": 0.1, "credibility": 0.16, "signals": 0.05 },
      "image": { "mime": "image/png", "width": 1440, "height": 2587, "bytes": 4066507 },
      "scores": {
        "visual": { "score_0_to_10": 2.0, "confidence": 0.91, "grade": "dated", "label": "Clearly dated" },
        "navigation": { "score_0_to_10": 5.0, "confidence": 0.84, "grade": "workable", "label": "Workable" },
        "credibility": { "score_0_to_10": 2.0, "confidence": 0.88, "grade": "weak", "label": "Weak" }
      },
      "reasons": ["Redesign need 0.79 is above the reach-out threshold (0.60)."],
      "issues": [{ "label": "...", "phrase": "...", "severity": 0.9 }]
    }
  ],
  "totals": { "REACH_OUT": 1 },
  "elapsed_s": 61.2
}
```

The three design grades are **visual appeal**, **navigation** and **professional
look**, combined **60/20/20**. Technical HTML flags add at most **0.10**; they
never reduce a score. `need_parts` shows that arithmetic per report.

A failing URL returns `UNSCORED` or `SITE_DOWN` with a reason; it never fails the
whole batch. Status codes: `400` bad body, `401` bad token, `404` unknown path,
`405` wrong method, `500` missing configuration.

A request that runs out of its time budget still answers with `200` and JSON:
URLs that did not finish carry `deadline_exceeded: true` and a reason. Send them
again in a smaller batch.

### `POST /v1/jobs`

No token. It is the public form, so the door is guarded by counters instead of
a login: a few batches per address per hour and a daily ceiling on URLs (see
[Limits](#limits-and-quotas)).

```json
{ "urls": ["arngren.net", "funda.nl"], "fresh": false }
```

`urls` accepts 1–50 entries, deduplicated and normalised (a missing `https://`
is added). `fresh` behaves as it does for `/v1/analyze`.

`201` with the new batch:

```json
{
  "ok": true,
  "dispatched": true,
  "job": {
    "id": "Rw5c_3o4j3geFU741_nl0A",
    "createdAt": "2026-11-15T09:47:02.186Z",
    "urls": ["https://arngren.net"],
    "total": 1,
    "fresh": false,
    "status": "queued",
    "done": 0,
    "results": [],
    "totals": {},
    "elapsed_s": 0,
    "waiting": 0,
    "next_retry_at": null,
    "canRetry": false,
    "ttlDays": 30
  }
}
```

The id is 22 URL-safe characters from 16 random bytes: unguessable, and the only
key to the batch. Anyone holding the link can read the reports, so treat it as a
private link.

If the batch is saved but the queue cannot be reached, the answer is still `201`
with `"dispatched": false` and a `warning`; `POST /v1/jobs/:id/retry` sends the
missing work later.

Errors: `400` bad body / more than 50 URLs / an address that cannot be used,
`429` rate limit (`retry_after_s` says when to try again), `500` missing
configuration.

### `GET /v1/jobs/:id`

No auth. Current progress and every finished report:

```json
{
  "ok": true,
  "job": {
    "id": "Rw5c_3o4j3geFU741_nl0A",
    "status": "running",
    "total": 12,
    "done": 5,
    "results": [{ "input_url": "https://arngren.net", "verdict": "REACH_OUT" }],
    "totals": { "REACH_OUT": 4, "MAYBE": 1 },
    "elapsed_s": 184.2,
    "waiting": 2,
    "next_retry_at": "2026-11-15T10:03:00.000Z",
    "canRetry": false,
    "ttlDays": 30
  }
}
```

`status` is `queued`, `running`, `completed` or `failed`. `results` only holds
finished URLs, in the order they were submitted, so a poller can grow the list
without re-fetching earlier work. `404` once the batch is older than the TTL.

`waiting` counts the URLs that hit a Gemini quota limit and are parked with a
delayed retry; `next_retry_at` is when the soonest one tries again. Those URLs
need no attention: they come back on their own.

`canRetry` is deliberately narrow. It is only `true` when the batch made no
progress for 15 minutes and nothing is waiting, i.e. when it really is stuck.

### `POST /v1/jobs/:id/retry`

No auth. Queues the URLs that still have no report and returns the batch like
`GET /v1/jobs/:id` with a `dispatched` count. A completed batch is a no-op.

`409` when there is nothing to restart:

- the batch is still running normally, or
- URLs are waiting for Gemini quota (`waiting` and `next_retry_at` say how
  many and until when) — restarting would only spend quota twice, or
- the automatic restart budget is used up; start a new batch instead.

### `GET /v1/jobs/:id/report.json`

No auth. Downloads the finished reports as a plain JSON array — exactly the
shape of the CLI's `report.json` — with
`Content-Disposition: attachment; filename="sitescout-<id>.json"`.

### `GET /health`

No token. Returns key counts (never key values), model name, request limits and
the current Gemini quota window, or `503` when configuration is incomplete.

```json
{
  "ok": true,
  "model": "gemini-decision-1",
  "keys": { "firecrawl": { "total": 5, "alive": 5 }, "gemini": { "total": 14, "alive": 14 } },
  "quota": {
    "window_s": 60,
    "tokens_per_minute": 45000,
    "requests_per_minute": 180,
    "global": { "tokens_used": 8120, "requests_used": 7, "cooldown_s": 0 },
    "keys": [{ "hash": "4f1c9a0d2e6b8c31", "tokens_used": 1043, "requests_used": 1, "cooldown_s": 0 }]
  },
  "limits": { "max_urls": 5, "concurrency": 5, "max_key_attempts": 3, "request_deadline_s": 270 }
}
```

Keys appear only as a 16-character hash, so the endpoint is safe to open in a
browser. If Redis is unreachable the quota block is omitted instead of failing
the whole answer.

## How a batch runs

1. `POST /v1/jobs` checks the quota counters, normalises the URLs and writes one
   Redis hash: `ss:job:<id>`.
2. It publishes **one QStash message per URL** to `POST /v1/jobs/run`
   (flow-control key `sitescout-jobs`, parallelism from
   `SITESCOUT_JOB_CONCURRENCY`). QStash retries twice and gives the function up
   to 280 s.
3. `POST /v1/jobs/run` verifies the QStash signature, **claims** the URL,
   analyses it and writes its report to `ss:job:<id>:r`. A URL that already has
   a report is skipped, and the claim (`SET NX PX 420s`) stops two deliveries of
   the same URL from both calling Gemini.
4. When the last report lands, the hash is marked `completed`. Both keys get the
   same TTL (30 days by default), so batches clean themselves up.

That one-message-per-URL design is what makes a closed tab irrelevant: nothing
in the browser is doing the work.

### When Gemini is out of quota

Google's limits are counted per Cloud project, not per key, and a batch can
easily ask for more than one project allows in a minute. A URL that runs into a
limit is therefore **not** written off as `UNSCORED`:

1. The refusal is read properly: `QuotaFailure` says which limit, `RetryInfo`
   says how long. A per-minute limit differs from a per-day one.
2. That one key cools down in Redis, so every worker instance leaves it alone for
   a while. The other keys keep working.
3. The URL goes back in the queue through QStash with a `delay` — 2 minutes
   first, doubling per attempt up to 15. A daily limit waits for midnight
   Pacific, where Google resets it.
4. The page shows "Waiting for quota" with a countdown. No button to press, and
   closing the tab changes nothing.
5. After `SITESCOUT_QUOTA_MAX_ATTEMPTS` (5, or 2 for a daily limit) the URL
   becomes `UNSCORED` with the actual reason instead of a generic failure.

A requeued URL is captured with Firecrawl again: the screenshot is not kept in
Redis (it is far too large), so the capture credit is spent twice. The Gemini
answers are cached in Redis by page content, so an unchanged page does not pay
for the same questions twice.

### Why the keys do not simply rotate

Rotating through every key on each `429` is what turned a single minute of
exhausted quota into an hour of failures: 14 keys, one sweep each, a ~58 s wait,
then another sweep. Now:

- a call tries at most `SITESCOUT_MAX_KEY_ATTEMPTS` keys (3) and then defers;
- a key that is cooling down in Redis is skipped without spending an attempt;
- the shared budget in Redis stops the burst before Google has to.

The shared budget is the important one: it stays inside the free tier even if
every configured key happens to belong to the same Cloud project. The per-key
budget is the second line of defence.

## Redis layout

| Key | Type | Contents |
|-----|------|----------|
| `ss:job:<id>` | hash | `createdAt`, `urls`, `total`, `fresh`, `status`, `dispatches`, `lastProgressAt`, `completedAt`, `error` |
| `ss:job:<id>:r` | hash | field `"<index>"` → JSON report |
| `ss:job:<id>:a` | hash | field `"<index>"` → quota deferrals so far |
| `ss:job:<id>:w` | hash | field `"<index>"` → due timestamp of the delayed retry |
| `ss:job:<id>:claim:<index>` | string | `SET NX PX 420s`, one owner per URL |
| `ss:quota:tok:<scope>` | sorted set | reserved tokens in the rolling minute |
| `ss:quota:req:<scope>` | sorted set | requests in the rolling minute |
| `ss:quota:cd:<scope>` | string | cooldown end timestamp |
| `ss:cache:<hash>` | string | cached Decisions answers (72 h) |
| `ss:rate:job:<ip-hash>:<hour>` | counter | batches per address per hour |
| `ss:rate:urls:<date>` | counter | URLs analysed today (UTC) |

`<scope>` is either `global` (all keys together) or a key hash. Addresses and
keys are stored as a 16-character SHA-256 prefix, never raw:

- a key hash keeps the quota book free of key material, so `/health` can show
  the budgets without leaking anything;
- an address hash keeps the rate limiter free of personal data.


## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FIRECRAWL_API_KEYS` | yes | — | One or more keys, comma-separated. |
| `GEMINI_API_KEYS` | yes | — | One or more keys, comma-separated. |
| `SITESCOUT_API_TOKEN` | `/v1/analyze` | — | Bearer token clients must send. |
| `SITESCOUT_MAX_URLS` | no | `5` | URLs per `/v1/analyze` request (max 10). |
| `SITESCOUT_CONCURRENCY` | no | `3` | URLs analysed in parallel per request. |
| `SITESCOUT_MODEL` | no | `gemini-decision-1` | Decisions model. |
| `SITESCOUT_IMAGE_RESOLUTION` | no | `high` | Gemini's own image setting (`low`/`medium`/`high`/`ultra_high`). |
| `SITESCOUT_REACH_OUT_THRESHOLD` | no | `0.60` | Verdict threshold. |
| `SITESCOUT_MAYBE_THRESHOLD` | no | `0.40` | Verdict threshold. |
| `SITESCOUT_REQUEST_DEADLINE_MS` | no | `270000` | Internal stop before Vercel's 300 s limit. |
| `SITESCOUT_MAX_IMAGE_BYTES` | no | `18874368` | Safety stop below Google's 20 MB inline limit. |
| `UPSTASH_REDIS_REST_URL` | jobs | — | Upstash Redis REST URL (`KV_REST_API_URL` also works). |
| `UPSTASH_REDIS_REST_TOKEN` | jobs | — | Upstash Redis REST token (`KV_REST_API_TOKEN` also works). |
| `QSTASH_TOKEN` | jobs | — | QStash publish token. |
| `QSTASH_URL` | no | `https://qstash.upstash.io` | Set for a non-default region, e.g. `https://qstash-eu-central-1.upstash.io`. |
| `QSTASH_CURRENT_SIGNING_KEY` | jobs | — | Verifies callbacks. |
| `QSTASH_NEXT_SIGNING_KEY` | jobs | — | Verifies callbacks during a key rotation. |
| `SITESCOUT_PUBLIC_ORIGIN` | no | Vercel URL | Public origin QStash calls back to (custom domain, local tunnel). |
| `SITESCOUT_MAX_JOB_URLS` | no | `50` | URLs per batch (max 50). |
| `SITESCOUT_JOB_TTL_DAYS` | no | `30` | How long a batch stays readable. |
| `SITESCOUT_JOB_CONCURRENCY` | no | `5` | How many URLs one deployment analyses at once (max 10). |
| `SITESCOUT_JOBS_PER_HOUR` | no | `8` | Batches per address per hour. |
| `SITESCOUT_DAILY_URL_BUDGET` | no | `500` | URLs per day across everyone (UTC). |
| `SITESCOUT_GEMINI_TOKENS_PER_MINUTE` | no | `45000` | Input tokens per minute for **all** Gemini keys together. |
| `SITESCOUT_GEMINI_REQUESTS_PER_MINUTE` | no | `180` | Requests per minute for all keys together. |
| `SITESCOUT_GEMINI_TOKENS_PER_KEY` | no | `45000` | Input tokens per minute for one key. |
| `SITESCOUT_GEMINI_REQUESTS_PER_KEY` | no | `180` | Requests per minute for one key. |
| `SITESCOUT_MAX_KEY_ATTEMPTS` | no | `3` | How many different Gemini keys one call may try (max 14). |
| `SITESCOUT_QUOTA_RETRY_BASE_MS` | no | `120000` | First delay before a quota-blocked URL is retried; doubles per attempt. |
| `SITESCOUT_QUOTA_MAX_ATTEMPTS` | no | `5` | Quota deferrals before a URL is reported as unscored (daily limits: 2). |
| `SITESCOUT_JOBS_INLINE` | no | off | Development only: run the batch inside the request, no QStash. |

Leave the four `SITESCOUT_GEMINI_*` budgets alone unless your Google plan is
bigger than the free tier: the free tier of the decision model allows 50,000
input tokens and 200 requests per minute per Cloud project, and the defaults sit
just below that.

The image itself is **never** cropped, resized or recompressed. The size in the
report is the full-page capture from Firecrawl.

## Local development

```powershell
npm install
vercel login
vercel link          # create/link the project
vercel env pull .env.local
vercel dev           # http://localhost:3000
```

Serve the page with the API for a real end-to-end test:

```powershell
$env:SITESCOUT_JOBS_INLINE = "1"     # analyse inside the request, no public callback
vercel dev
```

`SITESCOUT_JOBS_INLINE=1` skips QStash entirely, so no public URL is needed and
the POST returns when the whole batch is done. Keep test batches to one or two
URLs: the request still has Vercel's time budget.

The page itself is static (`web/index.html`, `web/styles.css`, `web/app.js`);
`vercel.json` maps `/` and `/j/:id` to it.

Call the token endpoint:

```powershell
curl.exe -X POST http://localhost:3000/v1/analyze `
  -H "Authorization: Bearer $env:SITESCOUT_API_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"urls":["arngren.net"]}'
```

## Deploy

1. Create a free account at <https://vercel.com>.
2. `npm i -g vercel`, then in the repo root: `vercel login` and `vercel link`.
3. Create the two Upstash resources on their free plan and copy the credentials
   into **Project → Settings → Environment Variables** for **Production** and
   **Preview**:
   - Redis: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - QStash: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
     `QSTASH_NEXT_SIGNING_KEY`, and `QSTASH_URL` if the region is not the
     default.
4. Add `FIRECRAWL_API_KEYS`, `GEMINI_API_KEYS` and `SITESCOUT_API_TOKEN` the same
   way.
5. `vercel --prod`.

No cron job is involved: QStash delivers the work, so Hobby's once-a-day cron
limit does not matter.

## Limits and quotas

- Vercel Hobby: 300 s per request, 512 MB–2 GB memory, 1 M invocations/month.
- The internal budget stops at 270 s (configurable, clamped to 280 s) and aborts
  in-flight work, so a slow batch always answers with JSON inside Vercel's 300 s
  limit instead of being killed with an HTML 504.
- QStash free plan: 1,000 messages/day, 10 parallel deliveries, 15 min per
  delivery. One message is one URL, so 50 URLs cost 50 messages.
- Upstash Redis free plan: 250 MB, 500K commands/month, persistence on.
- The default daily ceiling in code is 500 URLs, comfortably inside both free
  tiers. `SITESCOUT_JOBS_PER_HOUR=8` stops one visitor from spending the day's
  budget with a script.
- Screenshots are never cached: they are far too large for Redis (250 MB total)
  and for the Runtime Cache (2 MB per item). Gemini answers **are** cached in
  Redis for 72 h, keyed by the page's HTML content, so re-running an unchanged
  page spends Firecrawl credits but no Gemini quota.
- Each URL costs 1 Firecrawl credit and 3 Gemini calls (design, verdict, page —
  deliberately separate calls, never merged).
- Hobby is for non-commercial use. Ads, paid access, or client lead-generation
  would require Vercel Pro; Cloudflare Workers Paid is the cheaper paid fallback.
