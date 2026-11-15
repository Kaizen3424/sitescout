"""Scoring: turn the model's answers plus the HTML signals into a verdict,
talking points and a draft opening line."""
from __future__ import annotations

import statistics

SCORE_KEYS = ["visual_modernity", "layout_hierarchy", "typography_readability",
              "imagery_quality", "conversion_clarity", "trust_professionalism"]
SCORE_WEIGHTS = {"visual_modernity": 0.30, "layout_hierarchy": 0.20, "typography_readability": 0.15,
                 "imagery_quality": 0.15, "conversion_clarity": 0.10, "trust_professionalism": 0.10}
SCORE_LABELS = {"visual_modernity": "Visual modernity", "layout_hierarchy": "Layout & hierarchy",
                "typography_readability": "Typography", "imagery_quality": "Imagery",
                "conversion_clarity": "Offer & call-to-action", "trust_professionalism": "Professional / trust"}
DIM_ISSUES = {
    "visual_modernity": ("the overall design looks dated", "the design looks a few years behind current standards"),
    "layout_hierarchy": ("the layout is cluttered or hard to scan", "the layout is hard to scan, so visitors may not find what they need"),
    "typography_readability": ("text styling hurts readability", "the text styling makes the content harder to read than it should be"),
    "imagery_quality": ("images are low quality or poorly used", "the imagery looks low-quality, which weakens first impressions"),
    "conversion_clarity": ("the offer / next step is unclear", "it isn't immediately clear what to do next (call, book, order)"),
    "trust_professionalism": ("the site doesn't project a professional image", "the site may not be projecting the professional image the business deserves"),
}


def evaluate(cfg, m: dict, signals: dict) -> dict:
    scores, yn, ch = m["scores"], m["yesno"], m["choices"]
    quality = sum(SCORE_WEIGHTS[k] * scores[k]["norm"] for k in SCORE_KEYS) / sum(SCORE_WEIGHTS.values())
    p_out, p_unp = yn["looks_outdated"]["p"], yn["looks_unprofessional"]["p"]
    era = ch["design_era"]["probabilities"]
    p_old_era = era.get("before_2012", 0.0) + era.get("2012_2017", 0.0)
    # "Looks unprofessional" is the strongest human signal, so it carries a bit
    # more weight than the era guess.
    need_model = 0.50 * (1 - quality) + 0.20 * p_out + 0.20 * p_unp + 0.10 * p_old_era
    flags = signals.get("flags", [])
    need_signals = min(1.0, sum(f["weight"] for f in flags))
    need = 0.8 * need_model + 0.2 * need_signals if signals.get("available") else need_model
    # Confidence of the verdict comes from the DECISIVE questions (yes/no +
    # choices), which the focused calls answer with high confidence. The graded
    # scores are naturally softer and are therefore not part of this number.
    conf_items = [yn["looks_outdated"]["confidence"],
                  yn["looks_unprofessional"]["confidence"],
                  yn["page_is_broken_or_blank"]["confidence"],
                  yn["is_placeholder_page"]["confidence"],
                  yn["is_small_local_business"]["confidence"],
                  yn["obscured_by_overlay"]["confidence"],
                  ch["design_era"]["confidence"],
                  ch["business_category"]["confidence"]]
    confidence = statistics.median(conf_items)

    p_broken, p_place = yn["page_is_broken_or_blank"]["p"], yn["is_placeholder_page"]["p"]
    p_local, p_overlay = yn["is_small_local_business"]["p"], yn["obscured_by_overlay"]["p"]
    reasons: list[str] = []
    warnings: list[str] = []

    if p_broken > 0.70:
        verdict = "UNSCORED"
        reasons.append(f"The screenshot looks blank/blocked/failed (P={p_broken:.2f}); the design can't be judged. "
                       "Try --fresh, raise SITESCOUT_WAIT_MS, or open the site manually.")
    elif p_local < 0.25:
        verdict = "SKIP"
        reasons.append(f"Looks like a large company, chain or institution rather than a small local business "
                       f"(P(small local)={p_local:.2f}).")
    else:
        if need >= cfg.reach_out_threshold:
            verdict = "REACH_OUT"
            reasons.append(f"Redesign need {need:.2f} is above the reach-out threshold ({cfg.reach_out_threshold:.2f}).")
        elif need >= cfg.maybe_threshold:
            verdict = "MAYBE"
            reasons.append(f"Redesign need {need:.2f} is between the thresholds ({cfg.maybe_threshold:.2f}-"
                           f"{cfg.reach_out_threshold:.2f}): decent but improvable.")
        else:
            verdict = "SKIP"
            reasons.append(f"Redesign need {need:.2f} is low: the site looks acceptable.")
            if signals.get("available") and need_signals >= 0.5:
                verdict = "MAYBE"
                reasons.append("It looks fine visually but the technical checks are poor (mobile/HTTPS/legacy code): "
                               "a possible 'technical upgrade' pitch rather than a redesign.")
        if verdict == "REACH_OUT":
            if p_place > 0.70:
                verdict = "MAYBE"
                reasons.append("It looks like a placeholder/'coming soon' page: pitch a new site, not a redesign.")
            if p_local < 0.50:
                verdict = "MAYBE"
                reasons.append(f"Unsure it's a small local business (P={p_local:.2f}); check the owner is reachable "
                               "and independent.")
            if confidence < cfg.min_confidence:
                verdict = "MAYBE"
                reasons.append(f"The model is unsure (median confidence {confidence:.2f} < {cfg.min_confidence:.2f}); "
                               "look at the saved screenshot before reaching out.")
            if p_overlay > 0.60:
                verdict = "MAYBE"
                reasons.append(f"A popup/cookie banner covers much of the page (P={p_overlay:.2f}); the score may be "
                               "unreliable.")
    if p_overlay > 0.60 and verdict != "UNSCORED":
        warnings.append("A popup/overlay seems to cover part of the page; scores may be less reliable.")
    if p_place > 0.70 and verdict != "UNSCORED":
        warnings.append("Page looks like a placeholder / under-construction page.")
    if signals.get("available") and not signals["contact"].get("best"):
        warnings.append("No contact route found on the homepage: check the contact page, Google Business Profile "
                        "or social profiles.")
    if not signals.get("available"):
        warnings.append(signals.get("note", "HTML signals unavailable"))

    # talking points: weakest design dimensions + technical flags, strongest first
    issues = []
    for k in SCORE_KEYS:
        norm = scores[k]["norm"]
        if norm < 0.40:
            issues.append({"label": DIM_ISSUES[k][0], "phrase": DIM_ISSUES[k][1], "severity": round(1 - norm, 2)})
    scale = {"no_https": 0.85, "no_viewport": 0.90, "legacy_tech": 0.70, "table_layout": 0.65,
             "legacy_generator": 0.55, "stale_copyright": 0.50, "old_libs": 0.45, "legacy_doctype": 0.30}
    for f in flags:
        issues.append({"label": f["label"], "phrase": f["phrase"], "severity": scale.get(f["id"], 0.4)})
    issues.sort(key=lambda i: i["severity"], reverse=True)

    cat = ch["business_category"]
    return {
        "verdict": verdict,
        "need_score": round(need, 3),
        "need_model": round(need_model, 3),
        "need_signals": round(need_signals, 3),
        "design_quality": round(quality, 3),
        "model_confidence": round(confidence, 3),
        "probabilities": {"outdated": round(p_out, 3), "unprofessional": round(p_unp, 3),
                          "old_era": round(p_old_era, 3), "small_local_business": round(p_local, 3),
                          "placeholder": round(p_place, 3), "overlay": round(p_overlay, 3),
                          "broken_or_blank": round(p_broken, 3)},
        "reasons": reasons,
        "warnings": warnings,
        "issues": issues,
        "category": {"name": cat["choice"], "confidence": round(cat["confidence"], 3)},
        "design_era": {"name": ch["design_era"]["choice"], "confidence": round(ch["design_era"]["confidence"], 3)},
    }


def outreach_opening(name: str, host: str, issues: list[dict]) -> str | None:
    if not issues:
        return None
    phrases = [i["phrase"] for i in issues[:2]]
    who = name if name and len(name) <= 40 else "there"
    joined = " and ".join(phrases)
    return (f"Hi {who}, I had a quick look at {host} and noticed {joined}. I design websites for local "
            "businesses and put together a quick redesign concept for yours - happy to send it over, no obligation.")
