"""Scoring: turn the model's answers plus the HTML signals into a verdict,
talking points and a draft opening line.

The design judgement is three graded choices (visual / navigation /
credibility) and a fixed 60/20/20 formula. The model picks the grade; Python
does the arithmetic, so two sites with the same grades always get the same
score.
"""
from __future__ import annotations

import statistics

GRADE_KEYS = ["visual", "navigation", "credibility"]
GRADE_WEIGHTS = {"visual": 0.60, "navigation": 0.20, "credibility": 0.20}
GRADE_LABELS = {"visual": "Visual appeal", "navigation": "Navigation",
                "credibility": "Professional look"}

# How far each grade is from a current best-practice website:
# 0.0 = already there, 1.0 = completely off.
GRADE_GAPS = {
    "visual": {"premium": 0.0, "contemporary": 0.2, "dated_tidy": 0.5, "dated": 0.8, "poor": 1.0},
    "navigation": {"effortless": 0.0, "clear": 0.2, "workable": 0.5, "confusing": 0.8, "lost": 1.0},
    "credibility": {"excellent": 0.0, "good": 0.2, "ordinary": 0.5, "weak": 0.8, "amateur": 1.0},
}
GRADE_NAMES = {
    "visual": {"premium": "Premium", "contemporary": "Contemporary template",
               "dated_tidy": "Tidy but dated", "dated": "Clearly dated", "poor": "Poor / off-putting"},
    "navigation": {"effortless": "Effortless", "clear": "Clear", "workable": "Workable",
                   "confusing": "Confusing", "lost": "Lost"},
    "credibility": {"excellent": "Excellent", "good": "Good", "ordinary": "Ordinary",
                    "weak": "Weak", "amateur": "Amateur"},
}
GRADE_ISSUES = {
    "visual": ("the design looks dated or unappealing at first glance",
               "the site doesn't look as good as the business deserves"),
    "navigation": ("visitors have to hunt for key information",
                   "it isn't obvious where to find the properties, services or contact details"),
    "credibility": ("the site doesn't project a professional image",
                    "the site may not be projecting the professional image the business deserves"),
}

# Kept as aliases so reporting and the future API port share one vocabulary.
SCORE_KEYS = GRADE_KEYS
SCORE_LABELS = GRADE_LABELS

SIGNAL_SHARE = 0.10  # technical HTML flags are a small bonus, not a reweighting


def choice_key(grade: str) -> str:
    """The Decisions API question key for a grade ('visual' -> 'visual_grade')."""
    return f"{grade}_grade"


def expected_gap(answer: dict, gaps: dict[str, float]) -> float:
    """Probability-weighted distance from a current best-practice website."""
    probs = {k: float(v) for k, v in (answer.get("probabilities") or {}).items()}
    mass = sum(probs.values())
    if mass > 0:
        total = sum(probs.get(level, 0.0) * gaps.get(level, 0.0) for level in probs)
        total /= mass
    else:
        total = gaps.get(str(answer.get("choice")), 0.5)
    return min(1.0, max(0.0, total))


def score_from_grades(choices: dict) -> dict:
    """Pure function: the three grade answers -> gaps, weighted parts, need."""
    gaps = {k: expected_gap(choices[choice_key(k)], GRADE_GAPS[k]) for k in GRADE_KEYS}
    parts = {k: GRADE_WEIGHTS[k] * gaps[k] for k in GRADE_KEYS}
    return {"gaps": gaps, "parts": parts, "need_model": sum(parts.values())}


def evaluate(cfg, m: dict, signals: dict) -> dict:
    yn, ch = m["yesno"], m["choices"]
    scored = score_from_grades(ch)
    gaps, parts, need_model = scored["gaps"], scored["parts"], scored["need_model"]

    flags = signals.get("flags", [])
    need_signals = min(1.0, sum(f["weight"] for f in flags))
    # Technical flags add a small amount; a site with no flags is not penalised
    # for the missing signal (the old 80/20 blend silently shrank every score).
    need = min(1.0, need_model + (SIGNAL_SHARE * need_signals if signals.get("available") else 0.0))
    design_quality = 1 - need_model

    # Confidence of the verdict comes from the DECISIVE gate questions. The
    # design grade gets its own confidence: a confident "small business" answer
    # says nothing about how sure the model is of its visual judgement.
    conf_items = [yn["looks_outdated"]["confidence"],
                  yn["looks_unprofessional"]["confidence"],
                  yn["page_is_broken_or_blank"]["confidence"],
                  yn["is_placeholder_page"]["confidence"],
                  yn["is_small_local_business"]["confidence"],
                  yn["obscured_by_overlay"]["confidence"],
                  ch["design_era"]["confidence"],
                  ch["business_category"]["confidence"]]
    confidence = statistics.median(conf_items)
    design_confidence = sum(GRADE_WEIGHTS[k] * ch[choice_key(k)]["confidence"] for k in GRADE_KEYS)

    p_broken, p_place = yn["page_is_broken_or_blank"]["p"], yn["is_placeholder_page"]["p"]
    p_local, p_overlay = yn["is_small_local_business"]["p"], yn["obscured_by_overlay"]["p"]
    p_out, p_unp = yn["looks_outdated"]["p"], yn["looks_unprofessional"]["p"]
    era = ch["design_era"]["probabilities"]
    p_old_era = era.get("before_2012", 0.0) + era.get("2012_2017", 0.0)
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
    if design_confidence < 0.50 and verdict != "UNSCORED":
        warnings.append(f"The design grade is uncertain (weighted confidence {design_confidence:.2f}); "
                        "look at the saved screenshot before acting on it.")
    if signals.get("available") and not signals["contact"].get("best"):
        warnings.append("No contact route found on the homepage: check the contact page, Google Business Profile "
                        "or social profiles.")
    if not signals.get("available"):
        warnings.append(signals.get("note", "HTML signals unavailable"))

    # talking points: weakest design grades + technical flags, strongest first
    issues = []
    for k in GRADE_KEYS:
        gap = gaps[k]
        if gap >= 0.40:
            issues.append({"label": GRADE_ISSUES[k][0], "phrase": GRADE_ISSUES[k][1], "severity": round(gap, 2)})
    scale = {"no_https": 0.85, "no_viewport": 0.90, "legacy_tech": 0.70, "table_layout": 0.65,
             "legacy_generator": 0.55, "stale_copyright": 0.50, "old_libs": 0.45, "legacy_doctype": 0.30}
    for f in flags:
        issues.append({"label": f["label"], "phrase": f["phrase"], "severity": scale.get(f["id"], 0.4)})
    issues.sort(key=lambda i: i["severity"], reverse=True)

    scores = {}
    for k in GRADE_KEYS:
        grade = ch[choice_key(k)]
        choice = grade["choice"]
        scores[k] = {"score_0_to_10": round((1 - gaps[k]) * 10, 1),
                     "confidence": round(grade["confidence"], 3),
                     "grade": choice, "label": GRADE_NAMES[k].get(choice, choice),
                     "probabilities": {level: round(float(p), 3)
                                       for level, p in (grade.get("probabilities") or {}).items()}}

    cat = ch["business_category"]
    return {
        "verdict": verdict,
        "need_score": round(need, 3),
        "need_model": round(need_model, 3),
        "need_signals": round(need_signals, 3),
        "need_parts": {
            "visual": round(parts["visual"], 3),
            "navigation": round(parts["navigation"], 3),
            "credibility": round(parts["credibility"], 3),
            "signals": round(SIGNAL_SHARE * need_signals, 3) if signals.get("available") else 0.0,
        },
        "design_quality": round(design_quality, 3),
        "model_confidence": round(confidence, 3),
        "design_confidence": round(design_confidence, 3),
        "probabilities": {"outdated": round(p_out, 3), "unprofessional": round(p_unp, 3),
                          "old_era": round(p_old_era, 3), "small_local_business": round(p_local, 3),
                          "placeholder": round(p_place, 3), "overlay": round(p_overlay, 3),
                          "broken_or_blank": round(p_broken, 3)},
        "reasons": reasons,
        "warnings": warnings,
        "issues": issues,
        "category": {"name": cat["choice"], "confidence": round(cat["confidence"], 3)},
        "design_era": {"name": ch["design_era"]["choice"], "confidence": round(ch["design_era"]["confidence"], 3)},
        "scores": scores,
    }


def outreach_opening(name: str, host: str, issues: list[dict]) -> str | None:
    if not issues:
        return None
    phrases = [i["phrase"] for i in issues[:2]]
    who = name if name and len(name) <= 40 else "there"
    joined = " and ".join(phrases)
    return (f"Hi {who}, I had a quick look at {host} and noticed {joined}. I design websites for local "
            "businesses and put together a quick redesign concept for yours - happy to send it over, no obligation.")
