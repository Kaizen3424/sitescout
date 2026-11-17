"""URL validation/cleanup and per-thread HTTP sessions."""
from __future__ import annotations

import ipaddress
import re
import threading
from typing import Optional
from urllib.parse import urlparse

import requests

from errors import InvalidURL
from config import USER_AGENT


def normalize_url(raw: str) -> str:
    s = (raw or "").strip().strip("<>\"'\u201c\u201d\u2018\u2019").strip().rstrip(".,;")
    if not s or any(ch.isspace() for ch in s):
        raise InvalidURL(f"'{raw}' is not a valid website address")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", s):
        s = "https://" + s
    p = urlparse(s)
    if p.scheme not in ("http", "https"):
        raise InvalidURL(f"Unsupported URL scheme '{p.scheme}' (use http/https)")
    host = (p.hostname or "").lower()
    if not host or "." not in host or host.endswith((".local", ".internal", ".localhost")):
        raise InvalidURL(f"'{raw}' doesn't look like a public website address")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            raise InvalidURL(f"'{host}' is a private address; Firecrawl can't reach it")
    except ValueError:
        pass  # not an IP literal
    return p.geturl()


def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    return s


_thread_local = threading.local()


def _worker_session() -> requests.Session:
    """One Session per worker thread (requests.Session is not thread-safe)."""
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = _new_session()
        _thread_local.session = s
    return s
