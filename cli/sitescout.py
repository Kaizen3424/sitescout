#!/usr/bin/env python3
"""
SiteScout - paste a business website URL, get a verdict on whether it is worth
pitching a redesign to the owner.

Pipeline
  1. Firecrawl  POST /v2/scrape  -> rawHtml + ONE full-page screenshot
  2. Rule-based HTML checks     -> HTTPS, mobile viewport tag, stale (c) year,
                                   legacy tech, contact details
  3. Decision model             -> calibrated yes/no and choice answers
                                   (Google, OpenRouter or Morph Decisions API)
  4. Verdict                    -> three design grades (visual appeal 60%,
                                   navigation 20%, professional look 20%) plus
                                   technical signals -> REACH_OUT / MAYBE / SKIP /
                                   SITE_DOWN / UNSCORED, talking points and a
                                   draft opening line

The code lives in the modules next to this file:
  .env          your API keys          capture.py     Firecrawl scrape + cache
  htmlchecks.py rule-based checks      decisions.py   Gemini questions + API
  scoring.py    grades + verdict       reporting.py   output + report.json
  config.py     settings               cli.py         command line

Setup
  pip install requests pillow

  Create a .env file next to this script (copy .env.example) and put your
  keys in it. Multiple keys are comma-separated:
    FIRECRAWL_API_KEYS=fc-key1,fc-key2
    GEMINI_API_KEYS=AIza-key1,AIza-key2

Usage
  python sitescout.py                                 # interactive: paste URLs one by one
  python sitescout.py https://example.com             # one or more URLs
  python sitescout.py -f urls.txt                     # one URL per line (batch: one line per result)
  python sitescout.py -f urls.txt --rank              # batch, sorted by redesign need
  python sitescout.py URL1 URL2 URL3 -w 4             # 4 parallel workers (default 2)
  python sitescout.py URL --full                      # batch mode with the full report per URL
  python sitescout.py --calibrate labels.csv          # CSV with columns: url,label (reach_out|skip)
  python sitescout.py URL --json                      # machine-readable output
  python sitescout.py URL --fresh                     # ignore all caches and start over
  python sitescout.py URL --out myresults.json        # where to save the report

All results are saved to one report.json (default), containing every URL.

Exit codes: 0 ok | 1 some URLs failed | 2 config/usage error | 3 fatal API error
"""
import sys

try:
    import requests  # noqa: F401  (fail fast with a friendly message)
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency. Run: pip install requests pillow")

from cli import main

if __name__ == "__main__":
    sys.exit(main())
