"""Capture: scrape a site with Firecrawl (rawHtml + three 1440x900 frames of the
page), plus a small on-disk cache so re-runs don't burn credits.

Firecrawl's full-page screenshot mode runs the browser with a 100,000 px tall
viewport. Sites built with viewport-based layout or scroll animation react to
that: sections stretch, panels get pasted over the hero, and the saved page can
be three times taller than the real one. Gemini then shrinks that strip to about
1,100 vision tokens, so body text ends up unreadable - which is what made the
scores inconsistent.

Instead we take three real 1440x900 screenshots in one scrape: the first screen,
the middle of the page and the bottom. The page is shifted with a CSS transform
whose percentage resolves against the page's own height at render time, so the
same recipe works for a one-screen page and a 12,000 px page. Animations are
switched off and scroll-reveal elements forced visible first. One scrape, one
Firecrawl credit.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import requests

from config import USER_AGENT, Config
from errors import CaptureError, FatalAPIError, NetworkError, SiteScoutError
from httpio import _error_message, _safe_json, http_request, http_request_with_keys

try:  # Pillow is optional: used to spot a blank frame and to shrink the upload.
    from PIL import Image

    HAVE_PIL = True
except ImportError:  # pragma: no cover
    HAVE_PIL = False

log = logging.getLogger("sitescout")

FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"

# How many frames one capture tries to take: first screen, middle, bottom.
FRAME_COUNT = 3
# A frame below this many bytes is almost certainly a blank band (used only when
# Pillow is unavailable; with Pillow the pixels themselves are checked).
MIN_FRAME_BYTES = 12_000


@dataclass
class Capture:
    url: str
    final_url: str
    status_code: Optional[int]
    html: str
    title: str
    site_name: str
    frames: list[bytes]
    fetched_at: float
    from_cache: bool = False

    @property
    def image_bytes(self) -> bytes:
        """The first screen: the image the report describes."""
        return self.frames[0]


def _as_int(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _classify_failure(message: str) -> str:
    m = (message or "").lower()
    if any(k in m for k in ("dns", "resolve", "name_not_resolved", "ssl", "certificate", "cert_",
                            "err_connection", "connection refused", "unreachable", "no such host")):
        return "down"
    if any(k in m for k in ("captcha", "blocked", "forbidden", "access denied", "bot")):
        return "blocked"
    return "failed"


def _classify_status(status: int, html: str) -> str:
    head = (html or "")[:4000].lower()
    if status in (401, 403, 429, 451) or any(
        k in head for k in ("captcha", "cf-chl", "just a moment", "access denied", "attention required",
                            "verify you are human", "bot detection")
    ):
        return "blocked"
    if status in (404, 410) or status >= 500:
        return "down"
    return "blocked"


# ---- the in-page scripts that prepare the three frames ---------------------
# Animations are frozen and scroll-reveal elements are made visible; transforms
# of individual elements are left alone (sliders rely on them).
_PREPARE_JS = (
    "(() => {"
    "const s = document.createElement('style');"
    "s.setAttribute('data-sitescout', 'capture');"
    "s.textContent = ["
    "'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',"
    "'html{scroll-behavior:auto!important}',"
    "'[class*=reveal],[class*=fade],[data-aos],[data-scroll],[data-animate]"
    "{opacity:1!important;visibility:visible!important}'"
    "].join('');"
    "document.head.appendChild(s);"
    "return 'prepared';"
    "})()"
)

_RESET_JS = (
    "(() => {"
    "document.body.style.transform = '';"
    "const s = document.querySelector('style[data-sitescout=\"capture\"]');"
    "if (s) s.remove();"
    "return 'reset';"
    "})()"
)


def frame_transforms(viewport_h: int) -> list[str]:
    """CSS transforms that bring the top, middle and bottom of the page into view.

    Percentages resolve against the body's own height at render time, so they
    stay correct even though the page is laid out in a 100,000 px viewport while
    the actions run. `min(0px, ...)` keeps a one-screen page at the top instead
    of pushing it down into a blank frame.
    """
    half = max(1, viewport_h // 2)
    return [
        "translateY(0px)",
        f"translateY(min(0px, calc(-50% + {half}px)))",
        f"translateY(min(0px, calc(-100% + {viewport_h}px)))",
    ]


def _set_transform_script(transform: str) -> str:
    return ("(() => { document.body.style.transform = '" + transform + "'; return 'moved'; })()")


def _capture_actions(cfg: Config) -> list[dict]:
    actions: list[dict] = [
        {"type": "wait", "milliseconds": cfg.wait_for_ms},
        {"type": "executeJavascript", "script": _PREPARE_JS},
        {"type": "wait", "milliseconds": 300},
    ]
    for transform in frame_transforms(cfg.viewport_h):
        actions.append({"type": "executeJavascript", "script": _set_transform_script(transform)})
        actions.append({"type": "wait", "milliseconds": 250})
        actions.append({"type": "screenshot", "fullPage": False, "quality": cfg.shot_quality,
                        "viewport": {"width": cfg.viewport_w, "height": cfg.viewport_h}})
    actions.append({"type": "executeJavascript", "script": _RESET_JS})
    return actions


def firecrawl_scrape(session: requests.Session, cfg: Config, url: str, wait_ms: int, fresh: bool,
                     frames: bool = True) -> dict:
    """One /v2/scrape request returning rawHtml plus screenshots.

    With `frames` the screenshots come from actions (three real viewport-sized
    frames); without it, one plain first-screen screenshot, which is the most
    reliable Firecrawl path and the fallback when actions misbehave.
    """
    body: dict[str, Any] = {
        "url": url,
        "formats": ["rawHtml"],
        "onlyMainContent": False,
        "timeout": cfg.scrape_timeout_ms,
    }
    if frames:
        body["waitFor"] = 0  # the first action waits instead
        body["actions"] = _capture_actions(cfg)
    else:
        body["waitFor"] = wait_ms
        body["formats"] = [
            "rawHtml",
            {
                "type": "screenshot",
                "fullPage": False,  # a real 1440x900 screen, never a 100,000 px strip
                "quality": cfg.shot_quality,
                "viewport": {"width": cfg.viewport_w, "height": cfg.viewport_h},
            },
        ]
    if fresh:
        body["maxAge"] = 0  # bypass Firecrawl's own cache too

    def headers(key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": USER_AGENT}

    try:
        resp = http_request_with_keys(
            session, "POST", FIRECRAWL_SCRAPE_URL, cfg.firecrawl_keys, headers,
            json=body, timeout=(10, cfg.scrape_timeout_ms / 1000 + 30),
            retries=cfg.http_retries, backoff=cfg.backoff_base, label="Firecrawl",
        )
    except NetworkError as exc:
        raise CaptureError(str(exc)) from exc

    payload = _safe_json(resp)
    msg = _error_message(payload, resp)
    if resp.status_code == 401:
        raise FatalAPIError("All Firecrawl API keys were rejected (401). Check FIRECRAWL_API_KEYS in .env.")
    if resp.status_code == 402:
        raise FatalAPIError("All Firecrawl API keys are out of credits (402). Add keys or top up.")
    if resp.status_code == 429:
        raise CaptureError("All Firecrawl API keys are rate-limited (429).")
    if resp.status_code >= 400:
        raise CaptureError(f"Firecrawl HTTP {resp.status_code}: {msg}", kind=_classify_failure(msg))
    if not isinstance(payload, dict) or payload.get("success") is False:
        raise CaptureError(f"Firecrawl scrape failed: {msg}", kind=_classify_failure(msg))
    data = payload.get("data")
    if not isinstance(data, dict):
        raise CaptureError("Firecrawl response had no 'data' object")
    return data


def fetch_screenshot_bytes(session: requests.Session, cfg: Config, ref: str) -> bytes:
    """Firecrawl returns a (24h-expiring) URL; some clients return base64. Handle both."""
    ref = ref.strip()
    try:
        if ref.startswith("data:"):
            return base64.b64decode(ref.split(",", 1)[1])
        if ref.startswith(("http://", "https://")):
            # No Authorization header here: this is a storage URL, not the Firecrawl API.
            resp = http_request(session, "GET", ref, timeout=(10, 60), retries=cfg.http_retries,
                                backoff=cfg.backoff_base, label="screenshot download",
                                headers={"User-Agent": USER_AGENT})
            if resp.status_code != 200 or not resp.content:
                raise CaptureError(f"screenshot download failed (HTTP {resp.status_code})")
            return resp.content
        return base64.b64decode(ref, validate=True)
    except NetworkError as exc:
        raise CaptureError(str(exc)) from exc
    except (ValueError, IndexError) as exc:
        raise CaptureError("screenshot reference was not a URL or valid base64") from exc


def screenshot_refs(data: dict) -> list[str]:
    """The screenshot URLs of one scrape, in page order."""
    refs: list[str] = []
    actions = data.get("actions")
    if isinstance(actions, dict) and isinstance(actions.get("screenshots"), list):
        refs = [s for s in actions["screenshots"] if isinstance(s, str) and s.strip()]
    single = data.get("screenshot")
    if not refs and isinstance(single, str) and single.strip():
        refs = [single]
    return refs[:FRAME_COUNT]


def is_near_blank(raw: bytes) -> bool:
    """True for a frame with no visible content (a blank band, not a design)."""
    if not HAVE_PIL:
        return len(raw) < MIN_FRAME_BYTES
    try:
        with Image.open(io.BytesIO(raw)) as im:
            small = im.convert("L")
            small.thumbnail((48, 48))
            pixels = list(small.getdata())
    except Exception:  # noqa: BLE001 - unreadable image: fall back to size
        return len(raw) < MIN_FRAME_BYTES
    if not pixels:
        return True
    mean = sum(pixels) / len(pixels)
    spread = (sum((p - mean) ** 2 for p in pixels) / len(pixels)) ** 0.5
    return spread < 3.0


def download_frames(session: requests.Session, cfg: Config, refs: list[str]) -> list[bytes]:
    """Download the frames, drop exact duplicates and near-blank ones.

    A blank frame is usually a loading state or an animation that had not fired
    yet; it must never decide the verdict on its own. If *every* frame is blank,
    the first one is kept so the page check can still report a broken page.
    """
    downloaded: list[bytes] = []
    for ref in refs:
        try:
            raw = fetch_screenshot_bytes(session, cfg, ref)
        except CaptureError as exc:
            log.warning("could not download a frame: %s", exc)
            continue
        if raw:
            downloaded.append(raw)
    if not downloaded:
        raise CaptureError("screenshot download failed")

    frames: list[bytes] = []
    seen: set[str] = set()
    for raw in downloaded:
        digest = hashlib.sha1(raw).hexdigest()
        if digest in seen:
            log.info("dropping a duplicate frame")
            continue
        seen.add(digest)
        frames.append(raw)
    kept = [raw for raw in frames if not is_near_blank(raw)]
    if not kept:
        log.info("all frames look blank; keeping the first for the page check")
        return [frames[0]]
    if len(kept) < len(frames):
        log.info("dropped %d near-blank frame(s)", len(frames) - len(kept))
    return kept


def _build_capture(session: requests.Session, cfg: Config, url: str, data: dict,
                   frames_expected: int) -> Capture:
    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    status = _as_int(meta.get("statusCode"))
    html = data.get("rawHtml") or data.get("html") or ""
    if status and status >= 400:
        raise CaptureError(f"target site returned HTTP {status}", kind=_classify_status(status, html))
    refs = screenshot_refs(data)
    if not refs:
        raise CaptureError("Firecrawl returned no screenshot")
    frames = download_frames(session, cfg, refs)
    if len(frames) < frames_expected:
        log.info("capture returned %d of %d frames", len(frames), frames_expected)
    return Capture(
        url=url,
        final_url=str(meta.get("url") or meta.get("sourceURL") or url),
        status_code=status,
        html=html,
        title=str(meta.get("title") or ""),
        site_name=str(meta.get("ogSiteName") or meta.get("og:site_name") or ""),
        frames=frames,
        fetched_at=time.time(),
    )


def capture_site(session: requests.Session, cfg: Config, url: str, fresh: bool) -> Capture:
    attempts = max(1, cfg.capture_attempts)
    last_err: Optional[SiteScoutError] = None
    for attempt in range(1, attempts + 1):
        wait_ms = cfg.wait_for_ms * attempt  # give slow pages more time on a retry
        try:
            data = firecrawl_scrape(session, cfg, url, wait_ms, fresh, frames=True)
            return _build_capture(session, cfg, url, data, frames_expected=FRAME_COUNT)
        except CaptureError as exc:
            if exc.kind in ("down", "blocked"):
                raise  # retrying will not help
            last_err = exc
            log.warning("multi-frame capture attempt %d/%d failed: %s", attempt, attempts, exc)
    # Last resort: one plain first-screen screenshot, the path that never failed.
    log.warning("falling back to a single first-screen capture for %s", url)
    try:
        data = firecrawl_scrape(session, cfg, url, cfg.wait_for_ms * attempts, fresh, frames=False)
        return _build_capture(session, cfg, url, data, frames_expected=1)
    except CaptureError as exc:
        if exc.kind in ("down", "blocked"):
            raise
        raise last_err or exc


# ---- tiny on-disk cache so tuning thresholds does not burn Firecrawl credits ----
def _cache_dir_for(cfg: Config, url: str) -> Path:
    return cfg.cache_dir / hashlib.sha1(url.encode()).hexdigest()[:16]


def _frame_path(d: Path, index: int) -> Path:
    return d / f"frame_{index}.bin"


def load_cache(cfg: Config, url: str) -> Optional[Capture]:
    d = _cache_dir_for(cfg, url)
    try:
        meta = json.loads((d / "capture.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        fetched_at = float(meta.get("fetched_at", 0))
    except (TypeError, ValueError):
        return None
    if time.time() - fetched_at > cfg.cache_ttl_hours * 3600:
        return None

    frames: list[bytes] = []
    count = min(max(0, _as_int(meta.get("frame_count")) or 0), FRAME_COUNT)
    for index in range(count):
        try:
            raw = _frame_path(d, index).read_bytes()
        except OSError:
            break
        if raw:
            frames.append(raw)
    # Deliberately no fallback to the old shot.bin: a single frame saved by the
    # previous full-page capture is exactly the screenshot we are replacing.
    if not frames:
        return None
    return Capture(url=url, final_url=meta.get("final_url", url), status_code=meta.get("status_code"),
                   html=meta.get("html", ""), title=meta.get("title", ""), site_name=meta.get("site_name", ""),
                   frames=frames, fetched_at=fetched_at, from_cache=True)


def save_cache(cfg: Config, cap: Capture) -> None:
    d = _cache_dir_for(cfg, cap.url)
    try:
        d.mkdir(parents=True, exist_ok=True)
        for index, raw in enumerate(cap.frames):
            _frame_path(d, index).write_bytes(raw)
        for index in range(len(cap.frames), FRAME_COUNT):  # drop stale frames from an older capture
            _frame_path(d, index).unlink(missing_ok=True)
        (d / "capture.json").write_text(json.dumps({
            "final_url": cap.final_url, "status_code": cap.status_code, "html": cap.html,
            "title": cap.title, "site_name": cap.site_name, "fetched_at": cap.fetched_at,
            "frame_count": len(cap.frames),
        }), encoding="utf-8")
    except OSError as exc:
        log.warning("could not write cache: %s", exc)


def get_capture(session: requests.Session, cfg: Config, url: str, fresh: bool) -> Capture:
    if not fresh:
        cached = load_cache(cfg, url)
        if cached:
            log.info("using cached capture (%.1f h old, %d frames)",
                     (time.time() - cached.fetched_at) / 3600, len(cached.frames))
            return cached
    cap = capture_site(session, cfg, url, fresh)
    save_cache(cfg, cap)
    return cap
