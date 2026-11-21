# SiteScout

Judges whether a business website is worth pitching a redesign to.

For every URL you get one of five verdicts:

| Verdict      | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `REACH_OUT`  | Clear redesign opportunity - worth contacting.                          |
| `MAYBE`      | Borderline: decent but improvable, or one signal is uncertain.          |
| `SKIP`       | Looks fine: redesign need is below the low threshold.                  |
| `SITE_DOWN`  | The site does not load / is unreachable.                                |
| `UNSCORED`   | No result this time (quota, blocked capture, broken screenshot).        |

---

## How to run

Open PowerShell in the `cli` folder.

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

## Web interface (no install)

Open **<https://sitescout-dusky.vercel.app>**, paste up to **50** addresses and
press **Check websites**.

- You can close the tab, the browser or your laptop: the batch runs on the server
  and picks up where it left off when you come back.
- The same page lists your recent batches (kept in this browser only).
- Every batch has its own link (`/j/…`), so you can open it on your phone or send
  it to yourself.
- Results stay available for **30 days**, and **Download JSON** gives you the same
  shape as the CLI's `report.json`.
- No login. To protect the free Firecrawl and Gemini quota there is a limit of
  8 batches per hour per address and 500 websites per day in total.

The batch form needs two free Upstash services (Redis for storage, QStash for the
background queue). Setup is in [`api/README.md`](api/README.md#deploy).

---

## Lists: what you keep

A batch is one run. It disappears after 30 days, which is fine for a quick check
but useless for outreach: you need to remember that you emailed a bakery in March
and that their site got worse in May.

**Lists** are that memory. They live on the same free Redis, have no expiry, and
hold one row per domain:

- the latest full report, plus the last 15 checks as a small history;
- an outreach status per site (`new`, `contacted`, `follow up`, `won`, `no`);
- notes and up to 10 tags per site;
- filter and sort over the whole list, and a CSV download for a spreadsheet.

Nothing enters a list by itself. Open a finished batch, press **Add to list**,
pick one or more lists. A report file from the command line tool can be imported
the same way, and **Backup** writes the whole list to one JSON file that
**Import** can restore.

There is still **no login**. A list is readable by anyone who has its link; the
lists page itself is not indexed by search engines. If you want more than that,
set `SITESCOUT_LIST_KEY` and private lists ask for it before they open. Without
that variable the whole thing stays open, which is the intended mode for a
personal tool.

The free-tier caps are 20 lists, 2,000 sites per list and 5,000 entries in total.
Each site costs one Redis hash field; the JSON backup is the safety net if a list
is ever deleted by mistake.

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

Unlike the CLI, the API sends the screenshots untouched: no crop, no resize, no
upload budget. The CLI compresses each of the three frames a little so the
upload stays small. See [`api/README.md`](api/README.md) for the endpoint
contract, environment variables and deploy steps.

The API has two doors:

- **`POST /v1/jobs`** — the one the web page uses. Up to 50 URLs, no token, the
  work is queued and you collect the reports later from `/v1/jobs/<id>`.
- **`POST /v1/analyze`** — up to 5 URLs, waits for the answer, needs the bearer
  token. Handy for scripts.

`GET /v1` lists them all; `/` is the web page now, not the JSON index.

---

## Reading the one-line output

```
REACH_OUT need 0.85  vis  1.1/10  https://arngren.net/  - the design looks dated or unappealing at first glance
```

- **need** = redesign need, 0 to 1. `0.20` and above is `REACH_OUT`, `0.10-0.20` is `MAYBE`. Fitted to the owner's own ratings; see `calibration/results.json`.
- **vis** = visual appeal, 0 to 10. It is the first of the three grades and drives 60% of the score.
- Everything after the `-` is the main reason or the strongest talking point.

Useful flags:

| Flag            | What it does                                                     |
|-----------------|------------------------------------------------------------------|
| `--full`        | Print the full report for every URL in a batch.                  |
| `--json`        | Print JSON instead.                                              |
| `-w 1`          | One site at a time (best on slow / mobile internet).             |
| `--fresh`       | Ignore the cache: re-scrape the site and ask Gemini again.       |
| `--rank`        | After a batch, sort the results by redesign need (highest first). |
| `--out FILE`    | Write the report somewhere else (default `report.json`).         |
| `--no-save`     | Do not write a report file.                                      |
| `--calibrate CSV` | Score a CSV of `url,rating` (`bad`/`ok`/`good`) and fit the thresholds. |
| `-v`            | Show what is happening (cache hits, key rotation, waits).        |

---

## How a verdict is made

1. **Firecrawl** returns the HTML plus three 1440×900 screenshots (first screen,
   middle and bottom) in one scrape.
2. **Gemini Decisions** answers three small, focused sets of questions about the screenshot:
   - the three design grades (visual appeal, navigation, professional look),
   - the design verdict (outdated? unprofessional? which era?),
   - page checks (broken/blank, placeholder, company size as a warning, popup, category).
3. **HTML checks** add hard technical signals: no HTTPS, no mobile viewport, old
   jQuery/Bootstrap, table layout, stale copyright year, etc.
4. The redesign need is **60% visual appeal + 20% navigation + 20% professional
   look**, plus at most **0.10** for the technical signals. The model picks the
   three grades; the numbers are calculated in code, so the same grades always
   produce the same score. The reported confidence comes from the decisive
   yes/no and choice answers, not from the grades.

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
$env:SITESCOUT_REACH_OUT_THRESHOLD = "0.25"   # default 0.20
$env:SITESCOUT_MAYBE_THRESHOLD = "0.15"       # default 0.10
```

**A site is blocked by bot protection**
It will show `UNSCORED` or `SITE_DOWN` with the reason. Check it manually.

---

## Files

The Python code lives in the `cli/` folder. Use it to test and iterate; once a
change is final, port it to `api/` and deploy.

| File                  | Purpose                                                     |
|-----------------------|-------------------------------------------------------------|
| `cli/sitescout.py`    | Start here - thin launcher.                                 |
| `cli/cli.py`          | Command line, batch/interactive runs, calibration.          |
| `cli/capture.py`      | Firecrawl scrape (three frames) + capture cache.             |
| `cli/decisions.py`    | Gemini questions, frame shrinking, answer cache.             |
| `cli/review.py`       | Local web app: view the screenshots and rate 20 sites.        |
| `cli/calibrate.py`    | Fit the two thresholds to your own bad/ok/good ratings.      |
| `cli/scoring.py`      | Three grades, need score, confidence, talking points.       |
| `cli/htmlchecks.py`   | Technical checks on the HTML and contact details.           |
| `cli/reporting.py`    | One-line output, full report, `report.json`.                |
| `cli/config.py`       | Settings and environment variables.                         |
| `cli/httpio.py`       | HTTP retries and API-key rotation.                          |
| `cli/keypool.py`      | Key health (cooldowns, retired keys).                       |
| `cli/urls.py`         | URL cleaning and HTTP sessions.                             |
| `api/`                | TypeScript HTTP API for Vercel (see `api/README.md`).        |
| `web/`                | The public page: paste URLs, come back for the reports.     |
| `AGENTS.md`           | Short project context for AI coding agents.                  |
| `cli/.env`            | Your API keys (secrets, not shared).                        |
| `cli/.env.example`    | Template showing which settings you can put in `.env`.      |
