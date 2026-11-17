"""Output: one-line batch results, the full readable report, and the single
report.json that stores every URL's result."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from scoring import SCORE_KEYS, SCORE_LABELS

log = logging.getLogger("sitescout")

_COLORS = {"REACH_OUT": "32", "MAYBE": "33", "SKIP": "90", "SITE_DOWN": "35", "UNSCORED": "31"}


def _c(text: str, code: str, on: bool) -> str:
    return f"\033[{code}m{text}\033[0m" if on else text


def _bar(norm: float, width: int = 10) -> str:
    n = max(0, min(width, round(norm * width)))
    return "#" * n + "." * (width - n)


def _base_report(url: str) -> dict:
    return {"input_url": url, "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "verdict": "UNSCORED", "reasons": [], "warnings": []}


def public_report(report: dict) -> dict:
    return {k: v for k, v in report.items() if not k.startswith("_")}


def render_one_line(r: dict, color: bool) -> str:
    """Compact single line: VERDICT  need  vis  url  - top issue(s) or reason."""
    v = r["verdict"]
    url = r.get("final_url") or r["input_url"]
    head = _c(f"{v:<9}", _COLORS.get(v, "0") + ";1", color)
    if "need_score" in r:
        issues = [i["label"] for i in (r.get("issues") or [])[:2]]
        visual = (r.get("scores") or {}).get("visual", {}).get("score_0_to_10")
        shown = f"{visual:4.1f}/10" if isinstance(visual, (int, float)) else f"{r['design_quality'] * 10:4.1f}/10"
        line = f"{head} need {r['need_score']:.2f}  vis {shown}  {url}"
        if issues:
            line += "  - " + "; ".join(issues)
    else:
        reason = str((r.get("reasons") or [""])[0]).strip()
        if len(reason) > 100:
            reason = reason[:97] + "..."
        line = f"{head} {url}"
        if reason:
            line += f"  - {reason}"
    return line


def render_report(r: dict, color: bool) -> str:
    L: list[str] = []
    v = r["verdict"]
    L.append("=" * 64)
    L.append(f"URL       : {r.get('final_url') or r['input_url']}")
    if r.get("business", {}).get("name"):
        cat = r.get("category")
        extra = f"  (looks like: {cat['name']}, {cat['confidence']:.0%} sure)" if cat else ""
        L.append(f"Business  : {r['business']['name']}{extra}")
    head = _c(v, _COLORS.get(v, "0") + ";1", color)
    if "need_score" in r:
        L.append(f"VERDICT   : {head}   (redesign need {r['need_score']:.2f} | design quality "
                 f"{r['design_quality']:.2f} | model confidence {r['model_confidence']:.2f})")
        parts = r.get("need_parts") or {}
        if parts:
            bits = " + ".join(f"{k} {val:.2f}" for k, val in parts.items() if val)
            L.append(f"NEED      : {r['need_score']:.2f}  =  {bits}")
    else:
        L.append(f"VERDICT   : {head}")
    L.append("")
    L.append("Why")
    for s in r.get("reasons", []):
        L.append(f"  - {s}")
    if r.get("scores"):
        L.append("")
        L.append("Design grades (0-10, higher = better)")
        for k in SCORE_KEYS:
            s = r["scores"][k]
            label = s.get("label") or s.get("grade") or ""
            L.append(f"  {SCORE_LABELS[k]:<18} {_bar(s['score_0_to_10'] / 10)} {s['score_0_to_10']:>4.1f}"
                     f"   {label} (conf {s['confidence']:.2f})")
        p = r["probabilities"]
        L.append(f"  P(outdated)={p['outdated']:.2f}  P(unprofessional)={p['unprofessional']:.2f}  "
                 f"design era ~ {r['design_era']['name']}")
    sig = r.get("signals") or {}
    if sig.get("checks"):
        L.append("")
        L.append("Technical checks")
        for c in sig["checks"]:
            L.append(f"  [{'ok' if c['ok'] else '!!'}] {c['text']}")
        if sig.get("platform"):
            L.append(f"  [..] Platform guess: {sig['platform']}")
    ct = r.get("contact") or {}
    if ct:
        L.append("")
        L.append("Contact options found")
        bits = []
        if ct.get("emails"):
            bits.append("email: " + ", ".join(ct["emails"]))
        if ct.get("phones"):
            bits.append("phone: " + ", ".join(ct["phones"]))
        if ct.get("whatsapp"):
            bits.append("whatsapp: " + ct["whatsapp"])
        if ct.get("contact_page"):
            bits.append("contact page: " + ct["contact_page"])
        if ct.get("has_form"):
            bits.append("has a contact form")
        for k, u in (ct.get("social") or {}).items():
            bits.append(f"{k}: {u}")
        L.extend(f"  - {b}" for b in bits) if bits else L.append("  (none found on the homepage)")
    if r.get("issues") and v in ("REACH_OUT", "MAYBE"):
        L.append("")
        L.append("Talking points (strongest first)")
        for i, iss in enumerate(r["issues"][:5], 1):
            L.append(f"  {i}. {iss['label']}")
    op = (r.get("outreach") or {}).get("opening_line")
    if op:
        L.append("")
        L.append("Draft opening line (template - edit before sending)")
        L.append(f'  "{op}"')
        if r["outreach"].get("best_contact"):
            L.append(f"  Best contact route: {r['outreach']['best_contact']}")
    if r.get("warnings"):
        L.append("")
        L.append("Warnings")
        L.extend(f"  ! {w}" for w in r["warnings"])
    L.append("=" * 64)
    return "\n".join(L)


def render_rank(reports: list[dict]) -> str:
    """Sorted table for batch runs: highest redesign need first."""
    scored = [r for r in reports if isinstance(r.get("need_score"), (int, float))]
    scored.sort(key=lambda r: r["need_score"], reverse=True)
    if not scored:
        return "No scored URLs to rank."

    def grade(r: dict, key: str) -> str:
        value = (r.get("scores") or {}).get(key, {}).get("score_0_to_10")
        return f"{value:>4.1f}" if isinstance(value, (int, float)) else "   -"

    lines = [f"{'need':>5}  {'vis':>4}  {'nav':>4}  {'cred':>4}  {'verdict':<9}  url"]
    for r in scored:
        url = r.get("final_url") or r["input_url"]
        lines.append(f"{r['need_score']:>5.2f}  {grade(r, 'visual')}  {grade(r, 'navigation')}  "
                     f"{grade(r, 'credibility')}  {r['verdict']:<9}  {url}")
    return "\n".join(lines)


def save_reports(cfg, reports: list[dict]) -> Optional[Path]:
    """Write ONE report.json containing every URL's result (overwrites each run)."""
    if not cfg.save:
        return None
    path = cfg.report_path
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = [public_report(r) for r in reports if r is not None]
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return path
    except OSError as exc:
        log.warning("could not save report: %s", exc)
        return None
