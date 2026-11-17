"""Command line: argument parsing, the analyse pipeline, batch/interactive
runs and calibration."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests

from capture import CaptureError, get_capture
from config import Config, load_config, load_dotenv
from decisions import DecisionError, run_decisions
from errors import FatalAPIError, InvalidURL, SiteScoutError
from htmlchecks import analyze_html, guess_business_name
from reporting import (_base_report, public_report, render_one_line, render_rank,
                       render_report, save_reports)
from scoring import evaluate, outreach_opening
from urls import _new_session, _worker_session, normalize_url

log = logging.getLogger("sitescout")

VERDICT_ORDER = ["REACH_OUT", "MAYBE", "SKIP", "SITE_DOWN", "UNSCORED"]


# ============================================================================
# The analyse pipeline: capture -> HTML checks -> Gemini -> verdict
# ============================================================================
def analyze(url_in: str, cfg: Config, session: requests.Session, fresh: bool = False) -> dict:
    url = normalize_url(url_in)
    host = urlparse(url).hostname or url
    report = _base_report(url)
    t0 = time.time()
    try:
        cap = get_capture(session, cfg, url, fresh)
    except CaptureError as exc:
        if exc.kind == "down":
            report.update(verdict="SITE_DOWN")
            report["reasons"].append(f"The site appears non-functional: {exc}. If it stays down when you retry "
                                     "later, the business may have a dead website, which is a strong lead.")
        elif exc.kind == "blocked":
            report["reasons"].append(f"Capture blocked by the site or its bot protection: {exc}. Review manually.")
        else:
            report["reasons"].append(f"Capture failed: {exc}")
        report["capture_error"] = {"kind": exc.kind, "message": str(exc)}
        return report

    report.update(final_url=cap.final_url, from_cache=cap.from_cache,
                  business={"name": guess_business_name(cap), "title": cap.title})
    signals = analyze_html(cap)
    report["signals"] = signals
    report["contact"] = signals.get("contact", {})

    try:
        model_out = run_decisions(session, cfg, cap.image_bytes, fresh=fresh)
        report["image"] = model_out.get("image")
    except (CaptureError, DecisionError) as exc:
        report["reasons"].append(f"Could not score the design: {exc}")
        if isinstance(exc, DecisionError) and exc.kind == "safety":
            report["reasons"].append("The model's safety filter blocked the screenshot.")
        elif isinstance(exc, DecisionError) and exc.kind == "quota":
            report["reasons"].append("The decision provider's quota is used up for now. Re-run this URL later "
                                     "(in an hour or tomorrow): the question groups already answered are cached, "
                                     "so the retry only pays for what is missing.")
        return report

    ev = evaluate(cfg, model_out, signals)
    report.update(ev)
    report["model_usage"] = model_out.get("usage")
    report["outreach"] = {"best_contact": signals.get("contact", {}).get("best"),
                          "opening_line": outreach_opening(report["business"]["name"], host, ev["issues"])
                          if ev["verdict"] in ("REACH_OUT", "MAYBE") else None}
    report["elapsed_s"] = round(time.time() - t0, 1)
    return report


def process(url: str, cfg: Config, session: requests.Session, args: argparse.Namespace) -> dict:
    try:
        return analyze(url, cfg, session, fresh=args.fresh)
    except InvalidURL as exc:
        return {**_base_report(url), "reasons": [str(exc)], "input_error": True}
    except FatalAPIError:
        raise
    except Exception as exc:  # noqa: BLE001 - one bad URL must never kill a batch
        log.exception("unexpected error while analysing %s", url)
        return {**_base_report(url), "reasons": [f"Internal error: {type(exc).__name__}: {exc}"]}


def _process_one(url: str, cfg: Config, args: argparse.Namespace) -> dict:
    return process(url, cfg, _worker_session(), args)


# ============================================================================
# Calibration against your own labels
# ============================================================================
def run_calibration(path: Path, cfg: Config, fresh: bool) -> int:
    try:
        with path.open(newline="", encoding="utf-8-sig") as fh:
            rows = [(r.get("url", "").strip(), r.get("label", "").strip().lower()) for r in csv.DictReader(fh)]
    except OSError as exc:
        print(f"Cannot read {path}: {exc}", file=sys.stderr)
        return 2
    rows = [(u, l) for u, l in rows if u and l in ("reach_out", "skip")]
    if not rows:
        print("No usable rows. CSV needs columns: url,label (label = reach_out or skip).", file=sys.stderr)
        return 2
    session = _new_session()
    exact = soft = wrong = failed = 0
    print(f"{'label':<10} {'verdict':<10} {'need':>5}  url")
    for url, label in rows:
        try:
            r = analyze(url, cfg, session, fresh)
        except FatalAPIError as exc:
            print(f"Fatal: {exc}", file=sys.stderr)
            return 3
        except SiteScoutError as exc:
            print(f"{label:<10} {'ERROR':<10} {'':>5}  {url}  ({exc})")
            failed += 1
            continue
        v = r["verdict"]
        want = "REACH_OUT" if label == "reach_out" else "SKIP"
        if v == want:
            exact += 1
        elif v == "MAYBE":
            soft += 1
        elif v in ("UNSCORED", "SITE_DOWN"):
            failed += 1
        else:
            wrong += 1
        print(f"{label:<10} {v:<10} {r.get('need_score', float('nan')):>5.2f}  {url}")
        time.sleep(cfg.batch_delay)
    total = len(rows)
    print(f"\nExact agreement: {exact}/{total} | borderline (MAYBE): {soft} | disagreements: {wrong} | "
          f"unscored/errors: {failed}")
    print("Tune SITESCOUT_REACH_OUT_THRESHOLD / SITESCOUT_MAYBE_THRESHOLD until the disagreements disappear.")
    return 0


# ============================================================================
# CLI
# ============================================================================
def read_url_file(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return [ln.strip() for ln in fh if ln.strip() and not ln.strip().startswith("#")]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sitescout", description="Judge whether a business website is worth "
                                "pitching a redesign to.")
    p.add_argument("urls", nargs="*", help="website URL(s); omit to paste them interactively")
    p.add_argument("-f", "--file", help="text file with one URL per line")
    p.add_argument("-w", "--workers", type=int, default=2,
                   help="number of URLs to process in parallel (default: 2; use 1 for sequential)")
    p.add_argument("--json", action="store_true", help="print JSON instead of the readable report")
    p.add_argument("--full", action="store_true",
                   help="batch mode: print the full report for each URL instead of one line")
    p.add_argument("--rank", action="store_true",
                   help="after a batch, print the results sorted by redesign need (highest first)")
    p.add_argument("--fresh", action="store_true",
                   help="ignore all caches (screenshot and Gemini answers) and start over")
    p.add_argument("--no-save", action="store_true", help="don't write the report.json file")
    p.add_argument("--out", default="report.json",
                   help="file to save all results to, as JSON (default: report.json)")
    p.add_argument("--calibrate", metavar="CSV", help="CSV (url,label) of sites you've labelled reach_out/skip")
    p.add_argument("--no-color", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _emit_result(rep: dict, args: argparse.Namespace, color: bool) -> None:
    """Print a finished report: one line by default, full report with --full."""
    if args.json:
        return
    pub = public_report(rep)
    if args.full:
        print(render_report(pub, color))
    else:
        print(render_one_line(pub, color), flush=True)


def _run_interactive(cfg: Config, args: argparse.Namespace, color: bool) -> int:
    print("SiteScout - paste a website URL (or 'q' to quit).")
    session = _new_session()
    while True:
        try:
            u = input("\nURL> ").strip()
        except EOFError:
            break
        if u.lower() in ("q", "quit", "exit"):
            break
        if not u:
            continue
        if not args.json:
            print(f"\nAnalysing {u} ...", file=sys.stderr)
        rep = process(u, cfg, session, args)
        if args.json:
            print(json.dumps(public_report(rep), indent=2, ensure_ascii=False))
        else:
            print(render_report(public_report(rep), color))
    return 0


def _totals_line(reports: list[dict]) -> str:
    counts = Counter(r["verdict"] for r in reports)
    return ", ".join(f"{counts[k]} {k.lower()}" for k in VERDICT_ORDER if counts.get(k))


def _run_batch(urls: list[str], cfg: Config, args: argparse.Namespace, color: bool) -> int:
    workers = max(1, min(args.workers, len(urls)))
    single = len(urls) == 1
    if single and not args.json:
        args.full = True  # a lone URL deserves the detailed report
    reports: list[Optional[dict]] = [None] * len(urls)
    if not args.json and not args.full:
        print("(one line per site: verdict | need = redesign need 0-1 | vis = visual appeal 0-10)",
              file=sys.stderr)

    if workers == 1:
        session = _new_session()
        for i, u in enumerate(urls):
            if i:
                time.sleep(cfg.batch_delay)
            if not args.json:
                print(f"[{i + 1}/{len(urls)}] analysing {u} ...", file=sys.stderr)
            reports[i] = process(u, cfg, session, args)
            _emit_result(reports[i], args, color)
    else:
        if not args.json:
            print(f"Analysing {len(urls)} URL(s) with {workers} workers ...", file=sys.stderr)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_process_one, u, cfg, args): i for i, u in enumerate(urls)}
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    rep = fut.result()
                except FatalAPIError:
                    # All keys are dead for everyone - abort the batch.
                    for f in futures:
                        f.cancel()
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.exception("worker error for %s", urls[idx])
                    rep = {**_base_report(urls[idx]),
                           "reasons": [f"Internal error: {type(exc).__name__}: {exc}"]}
                reports[idx] = rep
                _emit_result(rep, args, color)

    for i in range(len(reports)):
        if reports[i] is None:
            reports[i] = {**_base_report(urls[i]), "reasons": ["Not processed (batch aborted)"]}

    saved = save_reports(cfg, reports)

    if args.json:
        out = [public_report(r) for r in reports]
        print(json.dumps(out[0] if len(out) == 1 else out, indent=2, ensure_ascii=False))
    else:
        if args.rank and not single:
            print()
            print(render_rank([public_report(r) for r in reports]))
        if not single:
            print(f"\nTotals: {_totals_line(reports)}")
        if saved:
            print(f"Saved all {len(reports)} result(s) to {saved}")

    bad = sum(1 for r in reports if r["verdict"] == "UNSCORED")
    return 1 if bad else 0


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(message)s", stream=sys.stderr)
    logging.getLogger("PIL").setLevel(logging.INFO)  # don't dump pixel-stream debug lines
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    load_dotenv([Path.cwd() / ".env", Path(__file__).resolve().parent / ".env"])
    try:
        cfg = load_config(args)
    except Exception as exc:  # ConfigError from keypool/config
        print(f"Config error: {exc}", file=sys.stderr)
        return 2
    color = sys.stdout.isatty() and not args.no_color and not os.getenv("NO_COLOR")

    try:
        if args.calibrate:
            return run_calibration(Path(args.calibrate), cfg, args.fresh)

        urls = list(args.urls)
        if args.file:
            try:
                urls += read_url_file(args.file)
            except OSError as exc:
                print(f"Cannot read {args.file}: {exc}", file=sys.stderr)
                return 2

        interactive = not urls and sys.stdin.isatty()
        if not urls and not interactive:
            urls = [ln.strip() for ln in sys.stdin if ln.strip()]

        if interactive:
            return _run_interactive(cfg, args, color)

        if not urls:
            print("No URLs given.", file=sys.stderr)
            return 2

        return _run_batch(urls, cfg, args, color)
    except FatalAPIError as exc:
        print(f"\nFatal: {exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
