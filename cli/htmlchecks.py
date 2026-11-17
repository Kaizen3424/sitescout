"""Rule-based HTML signals (no AI): HTTPS, viewport, stale copyright, legacy
tech, platform guess and contact discovery."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from html import unescape
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

from capture import Capture

_ATTR_RE = re.compile(r"""([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_PHONE_RE = re.compile(r"(?<![\d.])(\+?\(?\d[\d\s().-]{7,18}\d)(?!\d)")
_PHONE_CTX_RE = re.compile(r"call|tel|phone|mob|whatsapp|contact|\bph\b|enquir|book", re.I)
_COPY_RE = re.compile(r"(?:\u00a9|\(c\)|copyright)\s*(?:(?:19|20)\d{2}\s*[-\u2013\u2014]\s*)?((?:19|20)\d{2})", re.I)
_EMAIL_BAD_DOMAINS = {"example.com", "domain.com", "email.com", "yoursite.com", "yourdomain.com", "sentry.io",
                      "wixpress.com", "sentry-next.wixpress.com", "test.com", "mysite.com"}
_EMAIL_BAD_LOCALS = {"your", "name", "you", "email", "user", "username", "example", "yourname", "john", "info@info"}
_EMAIL_BAD_EXT = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".woff", ".woff2", ".ico")
_SOCIAL = {"facebook.com": "facebook", "instagram.com": "instagram", "linkedin.com": "linkedin",
           "twitter.com": "x", "x.com": "x", "youtube.com": "youtube", "tiktok.com": "tiktok",
           "wa.me": "whatsapp", "whatsapp.com": "whatsapp", "t.me": "telegram"}
_PLATFORMS = [("wix", r"wixstatic\.com|parastorage\.com|wix\.com"), ("weebly", r"weebly\.com"),
              ("squarespace", r"squarespace"), ("godaddy builder", r"godaddy|secureserver\.net"),
              ("shopify", r"cdn\.shopify\.com"), ("webflow", r"webflow"), ("framer", r"framer\.(?:com|website)"),
              ("wordpress", r"wp-content|wp-includes")]


def _attrs(tag: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in _ATTR_RE.finditer(tag):
        val = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4) or "")
        out[m.group(1).lower()] = val
    return out


def _strip_noise(html: str) -> str:
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    html = re.sub(r"<script\b.*?</script>", " ", html, flags=re.S | re.I)
    return re.sub(r"<style\b.*?</style>", " ", html, flags=re.S | re.I)


def _decode_cfemail(hexstr: str) -> Optional[str]:
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return None


def _clean_email(e: str) -> Optional[str]:
    e = e.strip().strip(".,;:()<>[]\"'").lower()
    local, _, domain = e.partition("@")
    if not local or not domain or e.endswith(_EMAIL_BAD_EXT) or domain in _EMAIL_BAD_DOMAINS:
        return None
    if local in _EMAIL_BAD_LOCALS or re.search(r"@\d+x\b", e):
        return None
    return e


def guess_business_name(cap: Capture) -> str:
    title = cap.site_name or cap.title
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", cap.html, re.I | re.S)
        title = unescape(m.group(1)).strip() if m else ""
    if not cap.site_name:
        generic = {"home", "welcome", "homepage", "index", "official site", "official website", "main page"}
        segs = [s.strip() for s in re.split(r"\s*[|\u2013\u2014\u00b7\u2022:]\s*|\s+-\s+", title) if s.strip()]
        segs = [s for s in segs if s.lower() not in generic]
        title = segs[0] if segs else title
    return re.sub(r"\s+", " ", title)[:60]


def analyze_html(cap: Capture) -> dict:
    """Cheap, deterministic checks. Each flag has a weight (0..1) used in the need score."""
    html = cap.html or ""
    now_year = datetime.now(timezone.utc).year
    result: dict[str, Any] = {"available": len(html) >= 300, "flags": [], "checks": [],
                              "platform": None, "generator": None, "copyright_year": None,
                              "contact": {}}
    if not result["available"]:
        result["note"] = "HTML too short to analyse (JS-only page or blocked?)"
        return result

    def flag(fid: str, label: str, phrase: str, weight: float) -> None:
        result["flags"].append({"id": fid, "label": label, "phrase": phrase, "weight": weight})
        result["checks"].append({"ok": False, "text": label})

    def ok(text: str) -> None:
        result["checks"].append({"ok": True, "text": text})

    # --- HTTPS (use the final URL after redirects) ---
    if urlparse(cap.final_url).scheme == "http":
        flag("no_https", "Served over plain HTTP (browsers show 'Not secure')",
             "browsers label the site 'Not secure'", 0.25)
    else:
        ok("HTTPS")

    # --- meta tags ---
    metas = [_attrs(t) for t in re.findall(r"<meta\b[^>]*>", html, re.I)]
    if any(m.get("name", "").lower() == "viewport" for m in metas):
        ok("Mobile viewport tag present")
    else:
        flag("no_viewport", "No mobile viewport tag (probably not mobile-friendly)",
             "it doesn't appear to be optimised for mobile phones", 0.30)
    gen = next((m.get("content", "") for m in metas if m.get("name", "").lower() == "generator"), "")
    result["generator"] = gen or None
    if re.search(r"frontpage|dreamweaver|microsoft word|joomla!? ?1\.|wordpress [1-4]\.", gen, re.I):
        flag("legacy_generator", f"Built with outdated tooling ({gen})",
             "it was built with outdated website tooling", 0.15)

    # --- legacy tech, libraries ---
    asset_urls = " ".join(a.get("src", "") + " " + a.get("href", "")
                          for a in (_attrs(t) for t in re.findall(r"<(?:script|link)\b[^>]*>", html, re.I)))
    clean = _strip_noise(html)
    legacy_tags = sorted({m.lower() for m in re.findall(r"<(marquee|blink|frameset|applet|bgsound|font|center)\b",
                                                       clean, re.I)})
    if re.search(r"\.swf\b|shockwave", html, re.I):
        legacy_tags.append("flash")
    if legacy_tags:
        flag("legacy_tech", f"Legacy HTML/tech found: {', '.join(legacy_tags)}",
             "it relies on legacy web technology", 0.25)
    if re.search(r"jquery(?:[-./@]|/)?v?(?:1|2)\.\d+", asset_urls, re.I) or \
            re.search(r"bootstrap(?:\.min)?[-./@]*v?(?:2|3)\.\d", asset_urls, re.I):
        flag("old_libs", "Old jQuery (1.x/2.x) or Bootstrap (2/3) detected",
             "it runs on old front-end libraries", 0.15)
    tables, divs = len(re.findall(r"<table\b", clean, re.I)), len(re.findall(r"<div\b", clean, re.I))
    if tables >= 4 and divs <= 2 * tables:
        flag("table_layout", "Likely table-based page layout", "its page layout is built the way sites were in the 2000s", 0.20)
    if not re.search(r"<!doctype\s+html\s*>", html[:1500], re.I) and re.search(
            r"xhtml|html 4|transitional|^\s*<html", html[:1500], re.I | re.M):
        flag("legacy_doctype", "Old or missing HTML5 doctype", "its underlying code is outdated", 0.10)

    # --- stale copyright year ---
    text = unescape(re.sub(r"<[^>]+>", " ", clean))
    years = [int(y) for y in _COPY_RE.findall(text) if 1995 <= int(y) <= now_year + 1]
    if years:
        year = max(years)
        result["copyright_year"] = year
        age = now_year - year
        if age >= 4:
            flag("stale_copyright", f"Footer copyright is {year} ({age} years old)",
                 f"the footer still says \u00a9 {year}, which makes it look unmaintained", 0.20)
        elif age >= 2:
            flag("stale_copyright", f"Footer copyright is {year}",
                 f"the footer still says \u00a9 {year}", 0.10)
        else:
            ok(f"Footer copyright is recent ({year})")

    # --- platform ---
    for name, pat in _PLATFORMS:
        if re.search(pat, html, re.I):
            result["platform"] = name
            break

    # --- contact discovery ---
    emails: list[str] = []
    phones: list[str] = []
    social: dict[str, str] = {}
    contact_page = whatsapp = None
    for tag in re.findall(r"<a\b[^>]*>", html, re.I):
        href = _attrs(tag).get("href", "").strip()
        low = href.lower()
        if low.startswith("mailto:"):
            e = _clean_email(unescape(href[7:].split("?")[0]))
            if e and e not in emails:
                emails.append(e)
        elif low.startswith("tel:"):
            p = re.sub(r"[^\d+]", "", href[4:])
            if 8 <= len(re.sub(r"\D", "", p)) <= 15 and p not in phones:
                phones.append(p)
        elif low.startswith("http") or low.startswith("//"):
            host = (urlparse(href if low.startswith("http") else "https:" + href).hostname or "").lower()
            host = host[4:] if host.startswith("www.") else host
            if host in _SOCIAL and not re.search(r"sharer|/share|intent/|dialog/", low):
                social.setdefault(_SOCIAL[host], href)
                if _SOCIAL[host] == "whatsapp":
                    whatsapp = whatsapp or href
        if contact_page is None and re.search(r"contact|reach-us|get-in-touch|enquir", low):
            contact_page = urljoin(cap.final_url, href) if href and not low.startswith(("mailto:", "tel:", "#", "javascript:")) else None
    for cf in re.findall(r'data-cfemail=["\']([0-9a-fA-F]+)["\']', html):
        e = _clean_email(_decode_cfemail(cf) or "")
        if e and e not in emails:
            emails.append(e)
    for m in _EMAIL_RE.findall(text):
        e = _clean_email(m)
        if e and e not in emails:
            emails.append(e)
    for m in _PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(1))
        ctx = text[max(0, m.start() - 30):m.start()]
        if 9 <= len(digits) <= 14 and (m.group(1).startswith("+") or _PHONE_CTX_RE.search(ctx)):
            norm = ("+" if m.group(1).startswith("+") else "") + digits
            if norm not in phones and not any(norm.lstrip("+").endswith(p.lstrip("+")) or
                                              p.lstrip("+").endswith(norm.lstrip("+")) for p in phones):
                phones.append(norm)
    has_form = bool(re.search(r"<form\b", clean, re.I))
    contact = {"emails": emails[:5], "phones": phones[:5], "whatsapp": whatsapp, "contact_page": contact_page,
               "social": social, "has_form": has_form}
    best = None
    if emails:
        best = f"email {emails[0]}"
    elif whatsapp:
        best = f"WhatsApp {whatsapp}"
    elif phones:
        best = f"phone {phones[0]}"
    elif contact_page or has_form:
        best = f"contact form/page {contact_page or cap.final_url}"
    elif social:
        k, v = next(iter(social.items()))
        best = f"{k} {v}"
    contact["best"] = best
    result["contact"] = contact
    return result
