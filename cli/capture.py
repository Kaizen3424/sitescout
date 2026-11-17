"""Capture: scrape a site with Firecrawl (rawHtml + one full-page screenshot),
plus a small on-disk cache so re-runs don't burn credits."""
from __future__ import annotations

import base64
import hashlib
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

log = logging.getLogger("sitescout")

FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"


@dataclass
class Capture:
    url: str
    final_url: str
    status_code: Optional[int]
    html: str
    title: str
    site_name: str
    image_bytes: bytes
    fetched_at: float
    from_cache: bool = False


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


def firecrawl_scrape(session: requests.Session, cfg: Config, url: str, wait_ms: int, fresh: bool) -> dict:
    """One /v2/scrape request returning rawHtml AND a full-page screenshot together."""
    body: dict[str, Any] = {
        "url": url,
        "formats": [
            "rawHtml",
            {
                "type": "screenshot",
                "fullPage": True,
                "quality": cfg.shot_quality,
                "viewport": {"width": cfg.viewport_w, "height": cfg.viewport_h},
            },
        ],
        "onlyMainContent": False,
        "waitFor": wait_ms,
        "timeout": cfg.scrape_timeout_ms,
    }
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


def capture_site(session: requests.Session, cfg: Config, url: str, fresh: bool) -> Capture:
    last_err: Optional[SiteScoutError] = None
    for attempt in range(1, cfg.capture_attempts + 1):
        wait_ms = cfg.wait_for_ms * attempt  # give slow pages more time on a retry
        try:
            data = firecrawl_scrape(session, cfg, url, wait_ms, fresh)
            meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
            status = _as_int(meta.get("statusCode"))
            html = data.get("rawHtml") or data.get("html") or ""
            if status and status >= 400:
                raise CaptureError(f"target site returned HTTP {status}", kind=_classify_status(status, html))
            shot_ref = data.get("screenshot")
            if not shot_ref or not isinstance(shot_ref, str):
                raise CaptureError("Firecrawl returned no screenshot")
            raw = fetch_screenshot_bytes(session, cfg, shot_ref)
        except CaptureError as exc:
            if exc.kind in ("down", "blocked"):
                raise  # retrying will not help
            last_err = exc
            log.warning("capture attempt %d/%d failed: %s", attempt, cfg.capture_attempts, exc)
            continue
        return Capture(
            url=url,
            final_url=str(meta.get("url") or meta.get("sourceURL") or url),
            status_code=status,
            html=html,
            title=str(meta.get("title") or ""),
            site_name=str(meta.get("ogSiteName") or meta.get("og:site_name") or ""),
            image_bytes=raw,
            fetched_at=time.time(),
        )
    raise last_err or CaptureError("capture failed")


# ---- tiny on-disk cache so tuning thresholds does not burn Firecrawl credits ----
def _cache_dir_for(cfg: Config, url: str) -> Path:
    return cfg.cache_dir / hashlib.sha1(url.encode()).hexdigest()[:16]


def load_cache(cfg: Config, url: str) -> Optional[Capture]:
    d = _cache_dir_for(cfg, url)
    try:
        meta = json.loads((d / "capture.json").read_text(encoding="utf-8"))
        raw = (d / "shot.bin").read_bytes()
    except (OSError, ValueError):
        return None
    if time.time() - float(meta.get("fetched_at", 0)) > cfg.cache_ttl_hours * 3600 or not raw:
        return None
    return Capture(url=url, final_url=meta.get("final_url", url), status_code=meta.get("status_code"),
                   html=meta.get("html", ""), title=meta.get("title", ""), site_name=meta.get("site_name", ""),
                   image_bytes=raw, fetched_at=float(meta["fetched_at"]), from_cache=True)


def save_cache(cfg: Config, cap: Capture) -> None:
    d = _cache_dir_for(cfg, cap.url)
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / "shot.bin").write_bytes(cap.image_bytes)
        (d / "capture.json").write_text(json.dumps({
            "final_url": cap.final_url, "status_code": cap.status_code, "html": cap.html,
            "title": cap.title, "site_name": cap.site_name, "fetched_at": cap.fetched_at,
        }), encoding="utf-8")
    except OSError as exc:
        log.warning("could not write cache: %s", exc)


def get_capture(session: requests.Session, cfg: Config, url: str, fresh: bool) -> Capture:
    if not fresh:
        cached = load_cache(cfg, url)
        if cached:
            log.info("using cached capture (%.1f h old)", (time.time() - cached.fetched_at) / 3600)
            return cached
    cap = capture_site(session, cfg, url, fresh)
    save_cache(cfg, cap)
    return cap
