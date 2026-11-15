/**
 * Scoring: turn the model's answers plus HTML signals into a verdict,
 * talking points and a draft opening line. Port of the Python `scoring.py`.
 */
import type { Settings } from "./env.js";
import type { Evaluation, HtmlSignals, Issue, ParsedAnswers, Verdict } from "./types.js";

export const SCORE_KEYS = [
  "visual_modernity",
  "layout_hierarchy",
  "typography_readability",
  "imagery_quality",
  "conversion_clarity",
  "trust_professionalism",
] as const;

export const SCORE_WEIGHTS: Record<(typeof SCORE_KEYS)[number], number> = {
  visual_modernity: 0.3,
  layout_hierarchy: 0.2,
  typography_readability: 0.15,
  imagery_quality: 0.15,
  conversion_clarity: 0.1,
  trust_professionalism: 0.1,
};

export const SCORE_LABELS: Record<(typeof SCORE_KEYS)[number], string> = {
  visual_modernity: "Visual modernity",
  layout_hierarchy: "Layout & hierarchy",
  typography_readability: "Typography",
  imagery_quality: "Imagery",
  conversion_clarity: "Offer & call-to-action",
  trust_professionalism: "Professional / trust",
};

const DIM_ISSUES: Record<(typeof SCORE_KEYS)[number], [string, string]> = {
  visual_modernity: ["the overall design looks dated", "the design looks a few years behind current standards"],
  layout_hierarchy: ["the layout is cluttered or hard to scan", "the layout is hard to scan, so visitors may not find what they need"],
  typography_readability: ["text styling hurts readability", "the text styling makes the content harder to read than it should be"],
  imagery_quality: ["images are low quality or poorly used", "the imagery looks low-quality, which weakens first impressions"],
  conversion_clarity: ["the offer / next step is unclear", "it isn't immediately clear what to do next (call, book, order)"],
  trust_professionalism: ["the site doesn't project a professional image", "the site may not be projecting the professional image the business deserves"],
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function evaluate(settings: Settings, model: ParsedAnswers, signals: HtmlSignals): Evaluation {
  const { scores, yesno: yn, choices: ch } = model;

  const quality =
    SCORE_KEYS.reduce((sum, key) => sum + SCORE_WEIGHTS[key] * scores[key]!.norm, 0) /
    SCORE_KEYS.reduce((sum, key) => sum + SCORE_WEIGHTS[key], 0);

  const pOut = yn.looks_outdated!.p;
  const pUnp = yn.looks_unprofessional!.p;
  const era = ch.design_era!.probabilities;
  const pOldEra = (era.before_2012 ?? 0) + (era["2012_2017"] ?? 0);

  // "Looks unprofessional" is the strongest human signal, so it carries a bit
  // more weight than the era guess.
  const needModel = 0.5 * (1 - quality) + 0.2 * pOut + 0.2 * pUnp + 0.1 * pOldEra;
  const needSignals = Math.min(1, signals.flags.reduce((sum, f) => sum + f.weight, 0));
  const need = signals.available ? 0.8 * needModel + 0.2 * needSignals : needModel;

  // Confidence of the verdict comes from the DECISIVE questions (yes/no +
  // choices), which the focused calls answer with high confidence. The graded
  // scores are naturally softer and are therefore not part of this number.
  const confidence = median([
    yn.looks_outdated!.confidence,
    yn.looks_unprofessional!.confidence,
    yn.page_is_broken_or_blank!.confidence,
    yn.is_placeholder_page!.confidence,
    yn.is_small_local_business!.confidence,
    yn.obscured_by_overlay!.confidence,
    ch.design_era!.confidence,
    ch.business_category!.confidence,
  ]);

  const pBroken = yn.page_is_broken_or_blank!.p;
  const pPlace = yn.is_placeholder_page!.p;
  const pLocal = yn.is_small_local_business!.p;
  const pOverlay = yn.obscured_by_overlay!.p;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let verdict: Verdict;

  if (pBroken > 0.7) {
    verdict = "UNSCORED";
    reasons.push(
      `The screenshot looks blank/blocked/failed (P=${pBroken.toFixed(2)}); the design can't be judged. ` +
        "Try fresh=true, raise SITESCOUT_WAIT_MS, or open the site manually.",
    );
  } else if (pLocal < 0.25) {
    verdict = "SKIP";
    reasons.push(
      `Looks like a large company, chain or institution rather than a small local business ` +
        `(P(small local)=${pLocal.toFixed(2)}).`,
    );
  } else {
    if (need >= settings.reachOutThreshold) {
      verdict = "REACH_OUT";
      reasons.push(
        `Redesign need ${need.toFixed(2)} is above the reach-out threshold ` +
          `(${settings.reachOutThreshold.toFixed(2)}).`,
      );
    } else if (need >= settings.maybeThreshold) {
      verdict = "MAYBE";
      reasons.push(
        `Redesign need ${need.toFixed(2)} is between the thresholds ` +
          `(${settings.maybeThreshold.toFixed(2)}-${settings.reachOutThreshold.toFixed(2)}): ` +
          "decent but improvable.",
      );
    } else {
      verdict = "SKIP";
      reasons.push(`Redesign need ${need.toFixed(2)} is low: the site looks acceptable.`);
      if (signals.available && needSignals >= 0.5) {
        verdict = "MAYBE";
        reasons.push(
          "It looks fine visually but the technical checks are poor (mobile/HTTPS/legacy code): " +
            "a possible 'technical upgrade' pitch rather than a redesign.",
        );
      }
    }

    if (verdict === "REACH_OUT") {
      if (pPlace > 0.7) {
        verdict = "MAYBE";
        reasons.push("It looks like a placeholder/'coming soon' page: pitch a new site, not a redesign.");
      }
      if (pLocal < 0.5) {
        verdict = "MAYBE";
        reasons.push(
          `Unsure it's a small local business (P=${pLocal.toFixed(2)}); check the owner is reachable ` +
            "and independent.",
        );
      }
      if (confidence < settings.minConfidence) {
        verdict = "MAYBE";
        reasons.push(
          `The model is unsure (median confidence ${confidence.toFixed(2)} < ` +
            `${settings.minConfidence.toFixed(2)}); look at the screenshot before reaching out.`,
        );
      }
      if (pOverlay > 0.6) {
        verdict = "MAYBE";
        reasons.push(
          `A popup/cookie banner covers much of the page (P=${pOverlay.toFixed(2)}); ` +
            "the score may be unreliable.",
        );
      }
    }
  }

  if (pOverlay > 0.6 && verdict !== "UNSCORED") {
    warnings.push("A popup/overlay seems to cover part of the page; scores may be less reliable.");
  }
  if (pPlace > 0.7 && verdict !== "UNSCORED") {
    warnings.push("Page looks like a placeholder / under-construction page.");
  }
  if (signals.available && !signals.contact.best) {
    warnings.push(
      "No contact route found on the homepage: check the contact page, Google Business Profile " +
        "or social profiles.",
    );
  }
  if (!signals.available) {
    warnings.push(signals.note ?? "HTML signals unavailable");
  }

  // talking points: weakest design dimensions + technical flags, strongest first
  const issues: Issue[] = [];
  for (const key of SCORE_KEYS) {
    const norm = scores[key]!.norm;
    if (norm < 0.4) {
      issues.push({ label: DIM_ISSUES[key][0], phrase: DIM_ISSUES[key][1], severity: Math.round((1 - norm) * 100) / 100 });
    }
  }
  const severityScale: Record<string, number> = {
    no_https: 0.85, no_viewport: 0.9, legacy_tech: 0.7, table_layout: 0.65,
    legacy_generator: 0.55, stale_copyright: 0.5, old_libs: 0.45, legacy_doctype: 0.3,
  };
  for (const flag of signals.flags) {
    issues.push({
      label: flag.label,
      phrase: flag.phrase,
      severity: severityScale[flag.id] ?? 0.4,
    });
  }
  issues.sort((a, b) => b.severity - a.severity);

  const category = ch.business_category!;
  const designEra = ch.design_era!;
  const round = (n: number): number => Math.round(n * 1000) / 1000;

  return {
    verdict,
    need_score: round(need),
    need_model: round(needModel),
    need_signals: round(needSignals),
    design_quality: round(quality),
    model_confidence: round(confidence),
    probabilities: {
      outdated: round(pOut),
      unprofessional: round(pUnp),
      old_era: round(pOldEra),
      small_local_business: round(pLocal),
      placeholder: round(pPlace),
      overlay: round(pOverlay),
      broken_or_blank: round(pBroken),
    },
    reasons,
    warnings,
    issues,
    category: { name: category.choice, confidence: round(category.confidence) },
    design_era: { name: designEra.choice, confidence: round(designEra.confidence) },
  };
}

export function outreachOpening(name: string, host: string, issues: Issue[]): string | null {
  if (issues.length === 0) return null;
  const phrases = issues.slice(0, 2).map((i) => i.phrase);
  const who = name && name.length <= 40 ? name : "there";
  const joined = phrases.join(" and ");
  return (
    `Hi ${who}, I had a quick look at ${host} and noticed ${joined}. I design websites for local ` +
    "businesses and put together a quick redesign concept for yours - happy to send it over, no obligation."
  );
}
