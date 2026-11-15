# SiteScout — project context

Judges whether a business website is worth pitching a redesign to. Personal,
open-source, educational project: **non-commercial**, no ads, no client work.
That is what allows the API to run on Vercel's free Hobby plan.

## Two independent tools

| Part | Where | What |
|------|-------|------|
| Python CLI | repo root (`sitescout.py`, `cli.py`, ...) | Local batch tool, one line per site, writes one `report.json`. |
| TypeScript API | `api/` | HTTP wrapper around the same pipeline, deployed on Vercel. |

The CLI is the reference implementation. The API must produce the same verdicts
and the same report field names.

## Rules that must not be broken

- **One full-page screenshot, untouched.** No crop, no resize, no upload budget in
  the API. Only Google's 20 MB inline limit is enforced (above it: `UNSCORED`).
- **Three separate Gemini Decisions calls** per site (design / verdict / page).
  Never merge them into one call.
- **API keys come from the environment only**: `.env` for the CLI, `.env.local`
  locally and Vercel Environment Variables in production. Never in code or Git.
- **The Python CLI's behaviour and output stay as they are**, including the single
  `report.json`.
- Keep the API to Vercel Hobby limits: 300 s per request, 5 URLs per request,
  3 in parallel.

## Commands

```powershell
python sitescout.py https://example.com     # CLI, one site
npx tsc --noEmit                            # type-check the API
vercel dev                                  # API locally (needs vercel login/link)
vercel --prod                               # deploy the API
```

## Layout

- `api/index.ts` — the single Vercel function (routing, auth, batching).
- `api/_lib/` — port of the Python modules. The `_` prefix keeps Vercel from
  deploying each file as its own function.
- `api/README.md` — endpoint contract and deploy steps.
- `vercel.json`, `tsconfig.json`, `package.json` — API build config (Vercel only
  reads these from the repo root).
