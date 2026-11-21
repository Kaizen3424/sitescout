"""Tune the two redesign thresholds against your own good/ok/bad ratings.

Usage
    python cli/calibrate.py calibration/ratings.csv
    python cli/calibrate.py calibration/ratings.csv --holdout calibration/holdout.csv

The CSV needs a header with `url` and `rating` columns (and an optional `note`):
    url,rating,note
    https://example.nl,bad,looks like 2015
    https://example2.nl,good,

Ratings: bad = I would pitch a redesign, ok = no pitch but weak, good = leave
alone. `reach_out`, `maybe` and `skip` are accepted as aliases.

For every rated URL the script runs the normal SiteScout pipeline, then tries
every sensible pair of cut-offs and prints the pair that best reproduces your
judgement, how it scores at the cut-offs you use now, and a leave-one-out score
(how well a pair chosen on 19 sites predicts the 20th). Results are saved next
to the ratings file as `results.json` so you can review the disagreements.

Ratings are opinions about named businesses: keep the calibration folder out of
Git.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
import time
from pathlib import Path
from typing import Optional

from cli import analyze
from config import Config, load_config, load_dotenv
from errors import FatalAPIError, SiteScoutError
from urls import _new_session

log = logging.getLogger("sitescout")

LABELS = {
    "bad": "bad", "pitch": "bad", "reach_out": "bad", "reach-out": "bad",
    "ok": "ok", "maybe": "ok", "weak": "ok",
    "good": "good", "skip": "good", "leave": "good", "leave_alone": "good",
}
GRID = [round(i / 100, 2) for i in range(101)]
VERDICT_LABEL = {"REACH_OUT": "bad", "MAYBE": "ok", "SKIP": "good"}


def read_ratings(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or "url" not in reader.fieldnames or "rating" not in reader.fieldnames:
            raise ValueError(f"{path} needs a header with 'url' and 'rating' columns")
        for line, row in enumerate(reader, 2):
            url = (row.get("url") or "").strip()
            rating = (row.get("rating") or "").strip().lower()
            note = (row.get("note") or "").strip()
            if not url:
                continue
            if rating not in LABELS:
                if not rating:
                    continue  # an unfilled template row
                raise ValueError(f"line {line}: unknown rating {rating!r}; use bad, ok or good")
            rows.append({"url": url, "rating": LABELS[rating], "note": note})
    return rows


def predict(need: float, low: float, high: float) -> str:
    """The same three-way split as scoring.py: good below low, bad from high up."""
    if need >= high:
        return "bad"
    if need >= low:
        return "ok"
    return "good"


def accuracy(rows: list[dict], low: float, high: float) -> int:
    return sum(predict(r["need"], low, high) == r["rating"] for r in rows)


def _margin(rows: list[dict], low: float, high: float) -> float:
    """Distance from the closest decision boundary - a wider cushion is safer."""
    smallest = 1.0
    for row in rows:
        need = row["need"]
        if need >= high:
            distance = need - high
        elif need >= low:
            distance = min(need - low, high - need)
        else:
            distance = low - need
        smallest = min(smallest, distance)
    return smallest


def best_pair(rows: list[dict]) -> tuple[float, float, int, float]:
    best: Optional[tuple] = None
    result = (0.40, 0.60, 0, 0.0)
    for low in GRID:
        for high in GRID:
            if high < low:
                continue
            hits = accuracy(rows, low, high)
            cushion = _margin(rows, low, high)
            key = (hits, round(cushion, 4))
            if best is None or key > best:
                best = key
                result = (low, high, hits, cushion)
    return result


def nice_pair(low: float, high: float, rows: list[dict]) -> tuple[float, float]:
    """Prefer a memorable 0.05 step if it fits exactly as well."""
    rounded = (round(low / 0.05) * 0.05, round(high / 0.05) * 0.05)
    if rounded[0] <= rounded[1] and accuracy(rows, *rounded) == accuracy(rows, low, high):
        return round(rounded[0], 2), round(rounded[1], 2)
    return low, high


def run_rows(rows: list[dict], cfg: Config, fresh: bool) -> list[dict]:
    session = _new_session()
    out: list[dict] = []
    for index, row in enumerate(rows, 1):
        print(f"[{index}/{len(rows)}] {row['url']}", file=sys.stderr, flush=True)
        try:
            report = analyze(row["url"], cfg, session, fresh=fresh)
        except FatalAPIError as exc:
            print(f"Fatal: {exc}", file=sys.stderr)
            return []
        except SiteScoutError as exc:
            print(f"  skipped: {exc}", file=sys.stderr)
            row = {**row, "need": None, "verdict": "ERROR", "error": str(exc)}
            out.append(row)
            continue
        need = report.get("need_score")
        scores = report.get("scores") or {}
        row = {
            **row,
            "need": need if isinstance(need, (int, float)) else None,
            "verdict": report.get("verdict"),
            "visual": (scores.get("visual") or {}).get("score_0_to_10"),
            "navigation": (scores.get("navigation") or {}).get("score_0_to_10"),
            "credibility": (scores.get("credibility") or {}).get("score_0_to_10"),
            "parts": report.get("need_parts"),
            "probabilities": report.get("probabilities"),
            "design_confidence": report.get("design_confidence"),
            "final_url": report.get("final_url"),
        }
        out.append(row)
        time.sleep(cfg.batch_delay)
    return out


def show_table(rows: list[dict]) -> None:
    print(f"\n{'want':<6} {'need':>5}  {'now':<9} {'vis':>4}  url")
    ordered = sorted(rows, key=lambda r: (r["need"] is None, r["need"] if r["need"] is not None else 0))
    for row in ordered:
        need = f"{row['need']:.3f}" if isinstance(row["need"], (int, float)) else "   -"
        visual = f"{row['visual']:>4.1f}" if isinstance(row["visual"], (int, float)) else "   -"
        verdict = str(row.get("verdict") or "-")
        now = VERDICT_LABEL.get(verdict, "-")
        print(f"{row['rating']:<6} {need:>5}  {now:<9} {visual}  {row['url']}")
        if row.get("note"):
            print(f"       {'':>5}  {'':<9} {'':>4}  note: {row['note']}")


def save_results(path: Path, rows: list[dict], low: float, high: float, loo: Optional[float]) -> Path:
    out = path.with_name("results.json")
    payload = {
        "ratings_file": path.name,
        "thresholds": {"maybe": low, "reach_out": high},
        "leave_one_out": loo,
        "rows": [{k: v for k, v in row.items() if k != "error"} for row in rows],
    }
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return out


def run_calibration(path: Path, cfg: Config, fresh: bool) -> int:
    try:
        rows = read_ratings(path)
    except (OSError, ValueError) as exc:
        print(f"Cannot use {path}: {exc}", file=sys.stderr)
        return 2
    if not rows:
        print(f"No ratings yet. Open {path} and fill in the 'rating' column with bad, ok or good.",
              file=sys.stderr)
        return 2

    scored = run_rows(rows, cfg, fresh)
    if not scored:
        return 3
    usable = [r for r in scored if isinstance(r["need"], (int, float))]
    if len(usable) < 4:
        print("Fewer than 4 usable scores; not enough to fit thresholds.", file=sys.stderr)
        return 2
    show_table(scored)

    low, high, hits, cushion = best_pair(usable)
    low, high = nice_pair(low, high, usable)
    hits = accuracy(usable, low, high)
    current = accuracy(usable, cfg.maybe_threshold, cfg.reach_out_threshold)

    correct = 0
    for index in range(len(usable)):
        train = usable[:index] + usable[index + 1:]
        t_low, t_high, _, _ = best_pair(train)
        if predict(usable[index]["need"], t_low, t_high) == usable[index]["rating"]:
            correct += 1
    loo = correct / len(usable)

    print("\nFit on your ratings")
    print(f"  your best pair     : maybe {low:.2f} / reach_out {high:.2f}  ->  {hits}/{len(usable)} exact")
    print(f"  current pair       : maybe {cfg.maybe_threshold:.2f} / reach_out "
          f"{cfg.reach_out_threshold:.2f}  ->  {current}/{len(usable)} exact")
    print(f"  leave-one-out      : {correct}/{len(usable)} ({loo:.0%}) - a pair chosen on 19 sites "
          f"predicts the 20th")
    print(f"  smallest cushion   : {cushion:.3f} need points to the nearest boundary")

    wrong = [r for r in usable if predict(r["need"], low, high) != r["rating"]]
    if wrong:
        print("\nStill disagrees (score sorted, highest need first)")
        for row in sorted(wrong, key=lambda r: r["need"], reverse=True):
            print(f"  {row['rating']:<4} called {predict(row['need'], low, high):<4} "
                  f"at need {row['need']:.3f}  {row['url']}"
                  + (f"  ({row['note']})" if row.get("note") else ""))

    print("\nPut this in .env / Vercel Environment Variables and redeploy:")
    print(f"  SITESCOUT_MAYBE_THRESHOLD={low:.2f}")
    print(f"  SITESCOUT_REACH_OUT_THRESHOLD={high:.2f}")
    print("\n20 sites catch a badly placed cut-off, not a perfect one. Rate 5 more as a hold-out "
          "before trusting it.")

    saved = save_results(path, scored, low, high, loo)
    print(f"Saved the per-site scores to {saved}")
    return 0


def run_holdout(path: Path, low: float, high: float, cfg: Config, fresh: bool) -> int:
    try:
        rows = read_ratings(path)
    except (OSError, ValueError) as exc:
        print(f"Cannot use {path}: {exc}", file=sys.stderr)
        return 2
    if not rows:
        print(f"No ratings yet in {path}.", file=sys.stderr)
        return 2
    scored = [r for r in run_rows(rows, cfg, fresh) if isinstance(r["need"], (int, float))]
    if not scored:
        return 3
    hits = accuracy(scored, low, high)
    print(f"\nHold-out at maybe {low:.2f} / reach_out {high:.2f}: {hits}/{len(scored)} exact")
    for row in scored:
        got = predict(row["need"], low, high)
        print(f"  {'ok' if got == row['rating'] else 'MISS'}  want {row['rating']:<4} got {got:<4} "
              f"need {row['need']:.3f}  {row['url']}")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("ratings", help="CSV with url,rating[,note]")
    p.add_argument("--holdout", metavar="CSV", help="second rated CSV, checked against the fitted thresholds")
    p.add_argument("--fresh", action="store_true", help="ignore capture and decision caches")
    p.add_argument("--out", default="report.json", help=argparse.SUPPRESS)
    p.add_argument("--no-save", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(message)s", stream=sys.stderr)
    load_dotenv([Path.cwd() / ".env", Path(__file__).resolve().parent / ".env"])
    try:
        cfg = load_config(args)
    except Exception as exc:  # ConfigError from keypool/config
        print(f"Config error: {exc}", file=sys.stderr)
        return 2

    try:
        code = run_calibration(Path(args.ratings), cfg, args.fresh)
        if code or not args.holdout:
            return code
        low = cfg.maybe_threshold
        high = cfg.reach_out_threshold
        result = Path(args.ratings).with_name("results.json")
        if result.exists():
            saved = json.loads(result.read_text(encoding="utf-8")).get("thresholds", {})
            low, high = float(saved.get("maybe", low)), float(saved.get("reach_out", high))
        return run_holdout(Path(args.holdout), low, high, cfg, args.fresh)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
