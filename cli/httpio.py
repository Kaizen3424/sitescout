"""HTTP helpers: retries with backoff, and retry-with-key-rotation on top."""
from __future__ import annotations

import logging
import random
import time
from typing import Any, Callable, Optional

import requests

from errors import FatalAPIError, NetworkError
from keypool import KeyPool

log = logging.getLogger("sitescout")

RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}


def _retry_after_seconds(resp: requests.Response) -> Optional[float]:
    raw = resp.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, min(float(raw), 60.0))
    except ValueError:
        return None


def http_request(
    session: requests.Session,
    method: str,
    url: str,
    *,
    retries: int,
    backoff: float,
    timeout: Any,
    label: str,
    **kwargs: Any,
) -> requests.Response:
    """Single-key request with retries. Used for non-authenticated downloads."""
    last_exc: Optional[Exception] = None
    resp: Optional[requests.Response] = None
    for attempt in range(1, retries + 2):
        retry_after = None
        try:
            resp = session.request(method, url, timeout=timeout, **kwargs)
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_exc, resp = exc, None
            reason = type(exc).__name__
        else:
            if resp.status_code not in RETRY_STATUSES:
                return resp
            last_exc = None
            reason = f"HTTP {resp.status_code}"
            retry_after = _retry_after_seconds(resp)
        if attempt > retries:
            break
        delay = retry_after if retry_after is not None else min(30.0, backoff * 2 ** (attempt - 1))
        delay += random.uniform(0, 0.5 * backoff)
        log.warning("%s: %s (attempt %d/%d) - retrying in %.1fs", label, reason, attempt, retries + 1, delay)
        time.sleep(delay)
    if resp is not None:
        return resp
    raise NetworkError(f"{label}: network failure after {retries + 1} attempts ({last_exc})")


def http_request_with_keys(
    session: requests.Session,
    method: str,
    url: str,
    key_pool: KeyPool,
    headers_fn: Callable[[str], dict[str, str]],
    *,
    retries: int,
    backoff: float,
    timeout: Any,
    label: str,
    max_key_wait: float = 180.0,
    max_key_attempts: Optional[int] = None,
    **kwargs: Any,
) -> requests.Response:
    """Like `http_request` but rotates API keys on auth/rate-limit failures.

    Rotation policy:
      * 401 / 402 / 403 -> key retired (`dead=True`), switch immediately.
      * 429             -> key cooled down ~60s, switch immediately; if EVERY
                           key is cooling down, wait for the soonest one
                           (bounded by `max_key_wait` seconds) instead of
                           failing the request.
      * 5xx / network   -> same-key retry with exponential backoff first;
                           only switches once this key has been exhausted.
      * anything else   -> returned to the caller.

    If *every* key has been tried (and no response was returned), the last
    received response is handed back so callers can surface the real error.
    """
    tried: set[str] = set()
    last_resp: Optional[requests.Response] = None
    last_exc: Optional[Exception] = None
    waited = 0.0

    while True:
        if max_key_attempts is not None and len(tried) >= max_key_attempts:
            log.warning("%s: %d keys rejected without success - giving up", label, len(tried))
            if last_resp is not None:
                return last_resp
            raise NetworkError(f"{label}: no API key worked after {len(tried)} attempts")
        try:
            key = key_pool.pick(exclude=tried)
        except FatalAPIError:
            # Either every key is dead, or every key was just tried and is
            # cooling down. In the latter case, wait for the soonest key.
            wait = key_pool.seconds_until_ready()
            if wait is None:
                if last_resp is not None:
                    return last_resp
                if last_exc is not None:
                    raise NetworkError(f"{label}: all API keys failed ({last_exc})") from last_exc
                raise
            if waited + wait > max_key_wait:
                log.warning("%s: all keys are rate-limited and the quota wait exceeds %.0fs - giving up",
                            label, max_key_wait)
                if last_resp is not None:
                    return last_resp
                raise NetworkError(f"{label}: all API keys are rate-limited")
            if wait > 0:
                log.warning("%s: all keys cooling down - waiting %.0fs for quota", label, wait)
                time.sleep(wait + 1.0)
                waited += wait + 1.0
            tried.clear()
            last_resp = None
            continue
        tried.add(key)
        tag = f"{label}[\u2026{key[-4:]}]" if len(key) >= 4 else label

        for attempt in range(1, retries + 2):
            try:
                resp = session.request(method, url, timeout=timeout, headers=headers_fn(key), **kwargs)
            except (requests.Timeout, requests.ConnectionError) as exc:
                last_exc, resp = exc, None
                if attempt > retries:
                    key_pool.report_failure(key, fatal=False, cooldown=30.0)
                    break
                delay = min(30.0, backoff * 2 ** (attempt - 1)) + random.uniform(0, 0.5 * backoff)
                log.warning("%s: %s (attempt %d/%d) - retrying in %.1fs",
                            tag, type(exc).__name__, attempt, retries + 1, delay)
                time.sleep(delay)
                continue

            status = resp.status_code
            last_resp = resp

            if status in (401, 402, 403):
                key_pool.report_failure(key, fatal=True)
                log.warning("%s: key rejected (%d) - retiring and switching keys", tag, status)
                break

            if status == 429:
                key_pool.report_rate_limited(key)
                log.info("%s: rate-limited (429) - switching keys", tag)
                break

            if status not in RETRY_STATUSES:
                key_pool.report_success(key)
                return resp

            if attempt > retries:
                key_pool.report_failure(key, fatal=False, cooldown=30.0)
                break

            delay = _retry_after_seconds(resp) or min(30.0, backoff * 2 ** (attempt - 1))
            delay += random.uniform(0, 0.5 * backoff)
            log.warning("%s: HTTP %d (attempt %d/%d) - retrying in %.1fs",
                        tag, status, attempt, retries + 1, delay)
            time.sleep(delay)

        # Inner loop done without returning -> switch keys and try again.


def _safe_json(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _error_message(payload: Any, resp: requests.Response) -> str:
    msg = None
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("status")
        elif err:
            msg = err
        msg = msg or payload.get("message")
    return str(msg or resp.text[:200] or f"HTTP {resp.status_code}").strip()
