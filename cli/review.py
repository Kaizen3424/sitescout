"""Local screenshot-rating app for threshold calibration.

Shows the three Firecrawl frames for each URL in calibration/ratings.csv and
lets you rate what you see: bad / ok / good. No scores are shown, so your
judgement stays independent. Ratings are written straight back to that CSV,
which `cli/calibrate.py` then uses to fit the thresholds.

    python cli/review.py                 # open http://127.0.0.1:8765
    python cli/review.py --port 9000     # different port
    python cli/review.py --fresh         # re-capture every site

Only screenshots are captured - no Gemini calls - so this costs one Firecrawl
credit per new site. Already-rated sites keep their rating and are skipped at
startup. Press Ctrl+C in the terminal to stop the server.

The app binds to 127.0.0.1 only: it never leaves your computer.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

from capture import get_capture
from config import load_config, load_dotenv
from errors import CaptureError, FatalAPIError, SiteScoutError
from urls import _new_session, normalize_url

log = logging.getLogger("sitescout")

ROOT = Path(__file__).resolve().parent.parent
RATINGS = ROOT / "calibration" / "ratings.csv"
REVIEW_DIR = ROOT / "calibration" / "review"

FRAME_LABELS = ["First screen", "Middle of page", "Bottom of page"]

# One file: no build step, no framework, nothing to install.
PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SiteScout - rate the screenshots</title>
<style>
  :root { --ink:#191713; --muted:#6b665e; --line:#ded8cc; --paper:#faf8f3;
          --bad:#a4402a; --ok:#9a7118; --good:#2e6b4f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { position:sticky; top:0; z-index:10; background:rgba(250,248,243,.96);
           backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:14px 24px; }
  .row { max-width:1180px; margin:0 auto; display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; letter-spacing:.01em; white-space:nowrap; }
  #progress { color:var(--muted); font-size:14px; white-space:nowrap; }
  #url { flex:1 1 260px; min-width:0; font-size:14px; color:var(--muted);
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #url a { color:var(--ink); text-underline-offset:3px; }
  .spacer { flex:1; }
  main { max-width:1180px; margin:0 auto; padding:20px 24px 160px; }
  #frames { display:flex; flex-direction:column; gap:20px; }
  figure { margin:0; background:#fff; border:1px solid var(--line); border-radius:10px;
           overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.04); }
  figcaption { padding:8px 12px; font-size:12px; font-weight:600; letter-spacing:.08em;
               text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--line); }
  figure img { display:block; width:100%; height:auto; }
  figure a { display:block; }
  .bar { position:fixed; left:0; right:0; bottom:0; z-index:10; border-top:1px solid var(--line);
         background:rgba(250,248,243,.97); backdrop-filter:blur(8px); }
  .bar-inner { max-width:1180px; margin:0 auto; padding:14px 24px; display:flex; gap:10px;
               align-items:center; flex-wrap:wrap; }
  button { font:inherit; cursor:pointer; border:1px solid var(--line); background:#fff;
           color:var(--ink); padding:11px 16px; border-radius:8px; }
  button:hover { border-color:var(--ink); }
  button:disabled { opacity:.4; cursor:default; }
  .rate { font-weight:600; }
  .rate small { display:block; font-weight:400; font-size:11px; opacity:.75; }
  .rate[data-rate=bad].selected { background:var(--bad); color:#fff; border-color:var(--bad); }
  .rate[data-rate=ok].selected { background:var(--ok); color:#fff; border-color:var(--ok); }
  .rate[data-rate=good].selected { background:var(--good); color:#fff; border-color:var(--good); }
  #note { flex:1 1 200px; min-width:140px; padding:11px 12px; border:1px solid var(--line);
          border-radius:8px; background:#fff; font:inherit; color:var(--ink); }
  #done { display:none; max-width:1180px; margin:40px auto; padding:28px; background:#fff;
          border:1px solid var(--line); border-radius:10px; }
  #done h2 { margin:0 0 8px; }
  code { background:#eee9df; padding:3px 6px; border-radius:5px; }
  @media (max-width:700px) { header,main,.bar-inner { padding-left:12px; padding-right:12px; } }
</style>
</head>
<body>
<header><div class="row">
  <h1>Sites to rate</h1>
  <span id="progress"></span>
  <span id="url"></span>
  <button id="prev" title="Previous site">&#8592; Prev</button>
  <button id="next" title="Next site">Next &#8594;</button>
</div></header>

<main>
  <div id="frames"></div>
  <div id="done">
    <h2>All rated.</h2>
    <p>Your ratings are saved in <code>calibration/ratings.csv</code>. I can now fit the thresholds.</p>
  </div>
</main>

<div class="bar"><div class="bar-inner">
  <button class="rate" data-rate="bad">Bad <small>I'd pitch a redesign &nbsp;(1)</small></button>
  <button class="rate" data-rate="ok">OK <small>Weak, but no pitch &nbsp;(2)</small></button>
  <button class="rate" data-rate="good">Good <small>Leave it alone &nbsp;(3)</small></button>
  <input id="note" maxlength="160" placeholder="Optional note (press Enter to save)">
</div></div>

<script>
let sites = [], idx = 0;
const $ = (id) => document.getElementById(id);

async function load() {
  const state = await (await fetch('/api/state')).json();
  sites = state.sites;
  const first = sites.findIndex(s => !s.rating);
  idx = first >= 0 ? first : 0;
  render();
}

function render() {
  const s = sites[idx];
  if (!s) return;
  const rated = sites.filter(x => x.rating).length;
  $('progress').textContent = `${rated} / ${sites.length} rated`;
  $('url').innerHTML = `Site ${idx + 1} of ${sites.length} &nbsp;&middot;&nbsp; ` +
    `<a href="${s.url}" target="_blank" rel="noopener">${s.url.replace(/^https?:\/\//,'')}</a>`;
  $('frames').style.display = rated === sites.length && sites.every(x => x.rating) ? 'none' : 'flex';
  $('done').style.display = sites.every(x => x.rating) ? 'block' : 'none';
  $('frames').innerHTML = s.frames.length ? s.frames.map((f, i) =>
    `<figure><figcaption>${FRAME_LABELS[i] || `Frame ${i + 1}`}</figcaption>` +
    `<a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="Screenshot ${i + 1} of ${s.url}"></a></figure>`
  ).join('') : '<p style="padding:20px;background:#fff;border:1px solid var(--line);border-radius:10px">' +
    'No screenshots for this site. Restart with <code>--fresh</code> to try again.</p>';
  document.querySelectorAll('[data-rate]').forEach(b =>
    b.classList.toggle('selected', b.dataset.rate === s.rating));
  $('note').value = s.note || '';
  $('prev').disabled = idx === 0;
  $('next').disabled = idx === sites.length - 1;
}

async function rate(value) {
  const s = sites[idx];
  if (!s) return;
  const res = await fetch('/api/rate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({url: s.url, rating: value, note: $('note').value.trim()})
  });
  const saved = await res.json();
  s.rating = saved.rating; s.note = saved.note;
  if (sites.every(x => x.rating)) { render(); return; }
  let next = sites.findIndex((x, i) => i > idx && !x.rating);
  if (next < 0) next = sites.findIndex(x => !x.rating);
  idx = next;
  render();
}

function move(delta) {
  const n = idx + delta;
  if (n >= 0 && n < sites.length) { idx = n; render(); }
}

document.querySelectorAll('[data-rate]').forEach(b =>
  b.addEventListener('click', () => rate(b.dataset.rate)));
$('prev').addEventListener('click', () => move(-1));
$('next').addEventListener('click', () => move(1));
$('note').addEventListener('keydown', e => { if (e.key === 'Enter') {
  const selected = sites[idx].rating; if (selected) rate(selected);
} });
document.addEventListener('keydown', e => {
  if (e.target === $('note')) return;
  if (e.key === '1') rate('bad');
  if (e.key === '2') rate('ok');
  if (e.key === '3') rate('good');
  if (e.key === 'ArrowLeft') move(-1);
  if (e.key === 'ArrowRight') move(1);
});
load();
</script>
</body>
</html>
"""

# Injected separately so Python does not have to escape JS template braces.
PAGE = PAGE.replace("FRAME_LABELS[i]", json.dumps(FRAME_LABELS) + "[i]")

SITES: list[dict] = []
RATINGS_PATH = RATINGS


def _mime(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def _read_ratings() -> tuple[list[str], list[dict]]:
    with RATINGS_PATH.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        fields = list(reader.fieldnames or ["url", "rating", "note"])
        rows = list(reader)
    for field in ("url", "rating", "note"):
        if field not in fields:
            fields.append(field)
    return fields, rows


def _write_ratings(fields: list[str], rows: list[dict]) -> None:
    tmp = RATINGS_PATH.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(RATINGS_PATH)


def prepare(cfg, session, fresh: bool) -> None:
    """Capture screenshots only, then build the in-memory site list."""
    global SITES
    fields, rows = _read_ratings()
    urls = [(r.get("url") or "").strip() for r in rows]
    urls = [u for u in urls if u]
    if not urls:
        raise SystemExit(f"No URLs in {RATINGS_PATH}. Put one URL per row in the 'url' column first.")

    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    pairs = [(r.get("url", "").strip(), r) for r in rows if (r.get("url") or "").strip()]
    sites: list[dict] = []
    for i, (url, row) in enumerate(pairs, 1):
        normalized = normalize_url(url)
        key = hashlib.sha1(normalized.encode()).hexdigest()[:14]
        folder = REVIEW_DIR / key
        by_number = lambda p: int(p.name.split("_")[1].split(".")[0])
        stored = sorted(folder.glob("frame_*"), key=by_number) if folder.exists() else []
        if fresh or not stored:
            print(f"[{i}/{len(urls)}] capturing {url} ...", flush=True)
            try:
                cap = get_capture(session, cfg, normalized, fresh=fresh)
            except (CaptureError, FatalAPIError) as exc:
                print(f"  skipped: {exc}", file=sys.stderr, flush=True)
                stored = []
            else:
                folder.mkdir(parents=True, exist_ok=True)
                for old in folder.glob("frame_*"):
                    old.unlink()
                for n, raw in enumerate(cap.frames):
                    (folder / f"frame_{n}").write_bytes(raw)
                stored = sorted(folder.glob("frame_*"), key=by_number)
        else:
            print(f"[{i}/{len(urls)}] {url} (screenshots already saved)", flush=True)
        sites.append({
            "id": key,
            "url": url,
            "frames": [f"/frame/{key}/{p.name}" for p in stored],
            "rating": (row.get("rating") or "").strip().lower(),
            "note": (row.get("note") or "").strip(),
        })
    SITES = sites


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the terminal readable
        return

    def _send(self, status: int, body: bytes, mimetype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mimetype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/api/state":
            self._json({"sites": SITES})
        elif path.startswith("/frame/"):
            parts = path.split("/")
            if len(parts) != 4 or parts[2] not in {s["id"] for s in SITES}:
                self._json({"error": "not found"}, 404)
                return
            target = REVIEW_DIR / parts[2] / Path(unquote(parts[3])).name
            try:
                raw = target.read_bytes()
            except OSError:
                self._json({"error": "not found"}, 404)
                return
            self._send(200, raw, _mime(raw))
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/rate":
            self._json({"error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
            url = str(data.get("url", "")).strip()
            rating = str(data.get("rating", "")).strip().lower()
            note = str(data.get("note", "")).strip()
        except (ValueError, TypeError):
            self._json({"error": "bad request"}, 400)
            return
        if rating not in ("bad", "ok", "good"):
            self._json({"error": "rating must be bad, ok or good"}, 400)
            return

        fields, rows = _read_ratings()
        matched = False
        for row in rows:
            if (row.get("url") or "").strip() == url:
                row["rating"] = rating
                row["note"] = note
                matched = True
                break
        if not matched:
            self._json({"error": "URL not in ratings.csv"}, 404)
            return
        _write_ratings(fields, rows)
        for site in SITES:
            if site["url"] == url:
                site["rating"], site["note"] = rating, note
        print(f"rated {rating:<4} {url}", flush=True)
        self._json({"ok": True, "rating": rating, "note": note})


def main(argv: Optional[list[str]] = None) -> int:
    global RATINGS_PATH
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--ratings", type=Path, default=RATINGS, help=argparse.SUPPRESS)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--fresh", action="store_true", help="re-capture every site")
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--out", default="report.json", help=argparse.SUPPRESS)
    p.add_argument("--no-save", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(message)s", stream=sys.stderr)
    RATINGS_PATH = args.ratings
    load_dotenv([Path.cwd() / ".env", Path(__file__).resolve().parent / ".env"])
    try:
        cfg = load_config(args)
    except Exception as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 2

    try:
        prepare(cfg, _new_session(), args.fresh)
    except (FatalAPIError, SiteScoutError) as exc:
        print(f"Capture failed: {exc}", file=sys.stderr)
        return 3
    if not SITES or not any(s["frames"] for s in SITES):
        print("No screenshots available; nothing to review.", file=sys.stderr)
        return 2

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"\nOpen {url} in your browser. Press Ctrl+C here to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\nStopped. Ratings are saved in {RATINGS_PATH}")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
