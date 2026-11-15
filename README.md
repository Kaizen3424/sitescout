# SiteScout

Judges whether a business website is worth pitching a redesign to.

For every URL you get one of five verdicts:

| Verdict      | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `REACH_OUT`  | Clear redesign opportunity - worth contacting.                          |
| `MAYBE`      | Borderline: decent but improvable, or one signal is uncertain.          |
| `SKIP`       | Looks fine (or it is a large company / chain, which you don't target).  |
| `SITE_DOWN`  | The site does not load / is unreachable.                                |
| `UNSCORED`   | No result this time (quota, blocked capture, broken screenshot).        |

---

## How to run

Open PowerShell in this folder.

First time only: install the two libraries and create your `.env` file (see
[API keys](#api-keys) below).

```powershell
pip install requests pillow
```

**One site** (prints a full report):

```powershell
python sitescout.py https://example.com
```

**Several sites** (prints one line per site):

```powershell
python sitescout.py https://a.com https://b.com https://c.com
```

**From a text file** (one URL per line, `urls.txt` is an example):

```powershell
python sitescout.py -f urls.txt
```

Every batch also writes **`report.json`** - a single file with all results of that run.

---

## HTTP API (optional)

There is also a TypeScript API in `api/`, made for Vercel. It runs the same
pipeline and returns the same report fields, so you can call SiteScout from
another app or your phone.

```powershell
curl.exe -X POST https://your-project.vercel.app/v1/analyze `
  -H "Authorization: Bearer YOUR_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"urls":["arngren.net"]}'
```

Unlike the CLI, the API sends the full-page screenshot untouched: no crop, no
resize, no upload budget. See [`api/README.md`](api/README.md) for the endpoint
contract, environment variables and deploy steps.

---

## Reading the one-line output

```
REACH_OUT need 0.85  q  1.1/10  https://arngren.net/  - the overall design looks dated; the layout is cluttered
```

- **need** = redesign need, 0 to 1. `0.60` and above is `REACH_OUT`, `0.40-0.60` is `MAYBE`.
- **q** = design quality, 0 to 10.
- Everything after the `-` is the main reason or the strongest talking point.

Useful flags:

| Flag            | What it does                                                     |
|-----------------|------------------------------------------------------------------|
| `--full`        | Print the full report for every URL in a batch.                  |
| `--json`        | Print JSON instead.                                              |
| `-w 1`          | One site at a time (best on slow / mobile internet).             |
| `--fresh`       | Ignore the cache: re-scrape the site and ask Gemini again.       |
| `--out FILE`    | Write the report somewhere else (default `report.json`).         |
| `--no-save`     | Do not write a report file.                                      |
| `--calibrate CSV` | Score a CSV of `url,label` (`reach_out`/`skip`) to check accuracy. |
| `-v`            | Show what is happening (cache hits, key rotation, waits).        |

---

## How a verdict is made

1. **Firecrawl** makes one full-page screenshot of the homepage and returns the HTML.
2. **Gemini Decisions** answers three small, focused sets of questions about the screenshot:
   - the six design scores (modernity, layout, typography, imagery, offer, trust),
   - the design verdict (outdated? unprofessional? which era?),
   - page checks (broken/blank, placeholder, small local business, popup, category).
3. **HTML checks** add hard technical signals: no HTTPS, no mobile viewport, old
   jQuery/Bootstrap, table layout, stale copyright year, etc.
4. The redesign need combines the design quality, "looks outdated", "looks
   unprofessional" and the technical signals. The reported confidence comes from
   the decisive yes/no answers, not from the soft 1-10 ratings.

Splitting the questions into three calls is deliberate: the decision model gets
noticeably more confident when asked fewer things at once.

---

## API keys

Keys live in a file called **`.env`** next to `sitescout.py`, never in the code.
Copy `.env.example` to `.env` and fill in your own keys:

```
FIRECRAWL_API_KEYS=fc-first,fc-second
GEMINI_API_KEYS=AIza-first,AIza-second
```

- Several keys: separate them with commas. Spaces after commas are fine.
- The singular names `FIRECRAWL_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY`
  also work, as do normal Windows environment variables.
- A rejected key (403) is retired for that run; a rate-limited key (429) is paused.
- `.env` contains secrets: don't email it, share it, or put it in Git (it is in
  `.gitignore`).

---

## Quota and the cache

Each site costs **3 Gemini calls**. The free tier is limited, so:

- Screenshots are cached for **12 hours** (`~/.cache/sitescout`).
- Gemini answers are cached for **72 hours**. Running the same URL again is
  instant and spends no quota.
- If a run hits the quota, the site shows `UNSCORED`. **Re-run it later**: the
  question groups that already succeeded are cached, so only the missing part is
  requested.
- `--fresh` ignores both caches (re-scrape + new Gemini calls).

If `UNSCORED` keeps happening for every site, all keys are out of quota for now;
wait, or add keys from another Google Cloud project.

---

## Troubleshooting

**Uploads fail or time out on mobile internet**
Use `-w 1` and keep the default image budget. On a fast network you can send a
sharper image:

```powershell
$env:SITESCOUT_UPLOAD_BUDGET_KB = "600"
```

**The verdicts feel too strict / too loose**
Tune the thresholds (defaults in brackets):

```powershell
$env:SITESCOUT_REACH_OUT_THRESHOLD = "0.55"   # default 0.60
$env:SITESCOUT_MAYBE_THRESHOLD = "0.35"       # default 0.40
```

**A site is blocked by bot protection**
It will show `UNSCORED` or `SITE_DOWN` with the reason. Check it manually.

---

## Files

| File              | Purpose                                                     |
|-------------------|-------------------------------------------------------------|
| `sitescout.py`    | Start here - thin launcher.                                 |
| `cli.py`          | Command line, batch/interactive runs, calibration.          |
| `capture.py`      | Firecrawl scrape + screenshot cache.                        |
| `decisions.py`    | Gemini questions, screenshot shrinking, answer cache.       |
| `scoring.py`      | Verdict, need score, confidence, talking points.            |
| `htmlchecks.py`   | Technical checks on the HTML and contact details.           |
| `reporting.py`    | One-line output, full report, `report.json`.                |
| `config.py`       | Settings and environment variables.                         |
| `httpio.py`       | HTTP retries and API-key rotation.                          |
| `keypool.py`      | Key health (cooldowns, retired keys).                       |
| `urls.py`         | URL cleaning and HTTP sessions.                             |
| `api/`            | TypeScript HTTP API for Vercel (see `api/README.md`).        |
| `AGENTS.md`       | Short project context for AI coding agents.                  |
| `.env`            | Your API keys (secrets, not shared).                        |
| `.env.example`    | Template showing which settings you can put in `.env`.      |
