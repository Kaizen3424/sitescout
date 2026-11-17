/**
 * Scoring: turn the model's answers plus HTML signals into a verdict,
 * talking points and a draft opening line. Port of the Python `scoring.py`.
 *
 * The design judgement is three graded choices (visual / navigation /
 * credibility) and a fixed 60/20/20 formula. The model picks the grade; the
 * arithmetic happens here, so two sites with the same grades always get the
 * same score.
 */
import type { Settings } from "./env.js";
import type {
  ChoiceAnswer,
  Evaluation,
  GradeScore,
  HtmlSignals,
  Issue,
  ParsedAnswers,
  Verdict,
} from "./types.js";

export const GRADE_KEYS = ["visual", "navigation", "credibility"] as const;
export type GradeKey = (typeof GRADE_KEYS)[number];

export const GRADE_WEIGHTS: Record<GradeKey, number> = {
  visual: 0.6,
  navigation: 0.2,
  credibility: 0.2,
};

export const GRADE_LABELS: Record<GradeKey, string> = {
  visual: "Visual appeal",
  navigation: "Navigation",
  credibility: "Professional look",
};

// How far each grade is from a current best-practice website:
// 0.0 = already there, 1.0 = completely off.
export const GRADE_GAPS: Record<GradeKey, Record<string, number>> = {
  visual: { premium: 0, contemporary: 0.2, dated_tidy: 0.5, dated: 0.8, poor: 1 },
  navigation: { effortless: 0, clear: 0.2, workable: 0.5, confusing: 0.8, lost: 1 },
  credibility: { excellent: 0, good: 0.2, ordinary: 0.5, weak: 0.8, amateur: 1 },
};

export const GRADE_NAMES: Record<GradeKey, Record<string, string>> = {
  visual: {
    premium: "Premium",
    contemporary: "Contemporary template",
    dated_tidy: "Tidy but dated",
    dated: "Clearly dated",
    poor: "Poor / off-putting",
  },
  navigation: {
    effortless: "Effortless",
    clear: "Clear",
    workable: "Workable",
    confusing: "Confusing",
    lost: "Lost",
  },
  credibility: {
    excellent: "Excellent",
    good: "Good",
    ordinary: "Ordinary",
    weak: "Weak",
    amateur: "Amateur",
  },
};

export const GRADE_ISSUES: Record<GradeKey, [string, string]> = {
  visual: [
    "the design looks dated or unappealing at first glance",
    "the site doesn't look as good as the business deserves",
  ],
  navigation: [
    "visitors have to hunt for key information",
    "it isn't obvious where to find the properties, services or contact details",
  ],
  credibility: [
    "the site doesn't project a professional image",
    "the site may not be projecting the professional image the business deserves",
  ],
};

// Kept as aliases so reporting and the web interface share one vocabulary.
export const SCORE_KEYS = GRADE_KEYS;
export const SCORE_LABELS = GRADE_LABELS;

export const SIGNAL_SHARE = 0.1; // technical HTML flags are a small bonus, not a reweighting

export function choiceKey(grade: GradeKey): string {
  return `${grade}_grade`;
}

export function expectedGap(answer: ChoiceAnswer, gaps: Record<string, number>): number {
  /** Probability-weighted distance from a current best-practice website. */
  const probabilities = answer.probabilities ?? {};
  const mass = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  let total: number;
  if (mass > 0) {
    total =
      Object.entries(probabilities).reduce(
        (sum, [level, p]) => sum + p * (gaps[level] ?? 0),
        0,
      ) / mass;
  } else {
    total = gaps[answer.choice] ?? 0.5;
  }
  return Math.min(1, Math.max(0, total));
}

export interface GradeScoring {
  gaps: Record<GradeKey, number>;
  parts: Record<GradeKey, number>;
  need_model: number;
}

export function scoreFromGrades(choices: ParsedAnswers["choices"]): GradeScoring {
  /** Pure function: the three grade answers -> gaps, weighted parts, need. */
  const gaps: Record<GradeKey, number> = { visual: 0, navigation: 0, credibility: 0 };
  const parts: Record<GradeKey, number> = { visual: 0, navigation: 0, credibility: 0 };
  for (const key of GRADE_KEYS) {
    const answer = choices[choiceKey(key)];
    if (!answer) throw new Error(`missing answer '${choiceKey(key)}'`);
    gaps[key] = expectedGap(answer, GRADE_GAPS[key]);
    parts[key] = GRADE_WEIGHTS[key] * gaps[key];
  }
  const needModel = GRADE_KEYS.reduce((sum, key) => sum + parts[key], 0);
  return { gaps, parts, need_model: needModel };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function evaluate(settings: Settings, model: ParsedAnswers, signals: HtmlSignals): Evaluation {
  const { yesno: yn, choices: ch } = model;
  const { gaps, parts, need_model: needModel } = scoreFromGrades(ch);

  const flags = signals.flags;
  const needSignals = Math.min(1, flags.reduce((sum, flag) => sum + flag.weight, 0));
  // Technical flags add a small amount; a site with no flags is not penalised
  // for the missing signal (the old 80/20 blend silently shrank every score).
  const need = Math.min(1, needModel + (signals.available ? SIGNAL_SHARE * needSignals : 0));
  const designQuality = 1 - needModel;

  // Confidence of the verdict comes from the DECISIVE gate questions. The
  // design grade gets its own confidence: a confident "small business" answer
  // says nothing about how sure the model is of its visual judgement.
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
  const designConfidence = GRADE_KEYS.reduce(
    (sum, key) => sum + GRADE_WEIGHTS[key] * ch[choiceKey(key)]!.confidence,
    0,
  );

  const pBroken = yn.page_is_broken_or_blank!.p;
  const pPlace = yn.is_placeholder_page!.p;
  const pLocal = yn.is_small_local_business!.p;
  const pOverlay = yn.obscured_by_overlay!.p;
  const pOut = yn.looks_outdated!.p;
  const pUnp = yn.looks_unprofessional!.p;
  const era = ch.design_era!.probabilities;
  const pOldEra = (era.before_2012 ?? 0) + (era["2012_2017"] ?? 0);

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
  if (designConfidence < 0.5 && verdict !== "UNSCORED") {
    warnings.push(
      `The design grade is uncertain (weighted confidence ${designConfidence.toFixed(2)}); ` +
        "look at the saved screenshot before acting on it.",
    );
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

  // talking points: weakest design grades + technical flags, strongest first
  const issues: Issue[] = [];
  for (const key of GRADE_KEYS) {
    const gap = gaps[key];
    if (gap >= 0.4) {
      issues.push({ label: GRADE_ISSUES[key][0], phrase: GRADE_ISSUES[key][1], severity: round2(gap) });
    }
  }
  const severityScale: Record<string, number> = {
    no_https: 0.85, no_viewport: 0.9, legacy_tech: 0.7, table_layout: 0.65,
    legacy_generator: 0.55, stale_copyright: 0.5, old_libs: 0.45, legacy_doctype: 0.3,
  };
  for (const flag of flags) {
    issues.push({
      label: flag.label,
      phrase: flag.phrase,
      severity: severityScale[flag.id] ?? 0.4,
    });
  }
  issues.sort((a, b) => b.severity - a.severity);

  const scores: Record<string, GradeScore> = {};
  for (const key of GRADE_KEYS) {
    const grade = ch[choiceKey(key)]!;
    const choice = grade.choice;
    scores[key] = {
      score_0_to_10: round1((1 - gaps[key]) * 10),
      confidence: round3(grade.confidence),
      grade: choice,
      label: GRADE_NAMES[key][choice] ?? choice,
      probabilities: Object.fromEntries(
        Object.entries(grade.probabilities ?? {}).map(([level, p]) => [level, round3(p)]),
      ),
    };
  }

  const category = ch.business_category!;
  const designEra = ch.design_era!;

  return {
    verdict,
    need_score: round3(need),
    need_model: round3(needModel),
    need_signals: round3(needSignals),
    need_parts: {
      visual: round3(parts.visual),
      navigation: round3(parts.navigation),
      credibility: round3(parts.credibility),
      signals: signals.available ? round3(SIGNAL_SHARE * needSignals) : 0,
    },
    design_quality: round3(designQuality),
    model_confidence: round3(confidence),
    design_confidence: round3(designConfidence),
    probabilities: {
      outdated: round3(pOut),
      unprofessional: round3(pUnp),
      old_era: round3(pOldEra),
      small_local_business: round3(pLocal),
      placeholder: round3(pPlace),
      overlay: round3(pOverlay),
      broken_or_blank: round3(pBroken),
    },
    reasons,
    warnings,
    issues,
    category: { name: category.choice, confidence: round3(category.confidence) },
    design_era: { name: designEra.choice, confidence: round3(designEra.confidence) },
    scores,
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
