/**
 * The redesign-need formula, ported from the Python CLI's test_scoring.py.
 *
 * The model picks three grades; the arithmetic is fixed here. These tests pin
 * the 60/20/20 weights, the probability-weighted gap and the verdict gates.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../api/_lib/env.js";
import type { ChoiceAnswer, HtmlSignals, ParsedAnswers } from "../api/_lib/types.js";
import {
  GRADE_GAPS,
  GRADE_WEIGHTS,
  evaluate,
  expectedGap,
  scoreFromGrades,
  type GradeKey,
} from "../api/_lib/scoring.js";

function choice(grade: GradeKey, level: string, confidence = 0.8): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(GRADE_GAPS[grade])) probabilities[key] = 0;
  probabilities[level] = 1;
  return { choice: level, confidence, probabilities };
}

function choices(
  visual = "contemporary",
  navigation = "clear",
  credibility = "good",
  confidence = 0.8,
): ParsedAnswers["choices"] {
  return {
    visual_grade: choice("visual", visual, confidence),
    navigation_grade: choice("navigation", navigation, confidence),
    credibility_grade: choice("credibility", credibility, confidence),
    design_era: {
      choice: "2022_or_later",
      confidence: 0.8,
      probabilities: { before_2012: 0, "2012_2017": 0, "2018_2021": 0.1, "2022_or_later": 0.9 },
    },
    business_category: {
      choice: "professional_services",
      confidence: 0.9,
      probabilities: { professional_services: 0.9, other: 0.1 },
    },
  };
}

function model(choiceAnswers: ParsedAnswers["choices"] = choices(), pLocal = 0.9): ParsedAnswers {
  return {
    scores: {},
    yesno: {
      looks_outdated: { p: 0.1, confidence: 0.9 },
      looks_unprofessional: { p: 0.1, confidence: 0.9 },
      page_is_broken_or_blank: { p: 0, confidence: 0.9 },
      is_placeholder_page: { p: 0, confidence: 0.9 },
      is_small_local_business: { p: pLocal, confidence: 0.9 },
      obscured_by_overlay: { p: 0, confidence: 0.9 },
    },
    choices: choiceAnswers,
  };
}

const CFG = {
  reachOutThreshold: 0.6,
  maybeThreshold: 0.4,
  minConfidence: 0.55,
} as unknown as Settings;

const NO_SIGNALS: HtmlSignals = {
  available: false,
  flags: [],
  checks: [],
  platform: null,
  generator: null,
  copyright_year: null,
  contact: {
    emails: [],
    phones: [],
    whatsapp: null,
    contact_page: null,
    social: {},
    has_form: false,
    best: null,
  },
};

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be close to ${expected}`,
  );
}

test("weights are 60/20/20", () => {
  assert.deepEqual(GRADE_WEIGHTS, { visual: 0.6, navigation: 0.2, credibility: 0.2 });
});

test("expected gap uses the probabilities", () => {
  const answer: ChoiceAnswer = {
    choice: "dated_tidy",
    confidence: 0.7,
    probabilities: { dated_tidy: 0.5, dated: 0.5 },
  };
  close(expectedGap(answer, GRADE_GAPS.visual), 0.65);
});

test("expected gap normalises probability mass", () => {
  const answer: ChoiceAnswer = {
    choice: "dated_tidy",
    confidence: 0.7,
    probabilities: { dated_tidy: 0.25, dated: 0.25 },
  };
  close(expectedGap(answer, GRADE_GAPS.visual), 0.65);
});

test("hand-calculated score", () => {
  // 0.60*0.8 + 0.20*0.2 + 0.20*0.2 = 0.56
  const scored = scoreFromGrades(choices("dated", "clear", "good"));
  close(scored.need_model, 0.56);
});

test("visual dominates the other two grades", () => {
  const datedButUsable = scoreFromGrades(choices("dated", "effortless", "excellent"));
  const prettyButLost = scoreFromGrades(choices("premium", "lost", "amateur"));
  assert.ok(datedButUsable.need_model > prettyButLost.need_model);
});

test("need parts sum to the need score", () => {
  const result = evaluate(CFG, model(choices("dated_tidy", "workable", "ordinary")), NO_SIGNALS);
  const parts = result.need_parts;
  close(parts.visual + parts.navigation + parts.credibility + parts.signals, result.need_score, 0.001);
});

test("design quality is the inverse of the model score", () => {
  const result = evaluate(CFG, model(choices("dated")), NO_SIGNALS);
  close(result.design_quality, 1 - result.need_model, 0.001);
});

test("technical signals add at most ten percent", () => {
  const signals: HtmlSignals = {
    ...NO_SIGNALS,
    available: true,
    flags: [{ id: "no_https", label: "No HTTPS", phrase: "browsers label it unsafe", weight: 0.5 }],
    contact: { ...NO_SIGNALS.contact, best: "email hello@example.com" },
  };
  const result = evaluate(CFG, model(choices("dated", "clear", "good")), signals);
  close(result.need_score, 0.56 + 0.1 * 0.5, 0.001);
});

test("high need is a reach-out", () => {
  const result = evaluate(CFG, model(choices("dated", "workable", "ordinary")), NO_SIGNALS);
  assert.ok(result.need_score >= 0.6);
  assert.equal(result.verdict, "REACH_OUT");
});

test("middle need is a maybe", () => {
  const result = evaluate(CFG, model(choices("dated_tidy", "clear", "ordinary")), NO_SIGNALS);
  assert.ok(result.need_score >= 0.4 && result.need_score < 0.6);
  assert.equal(result.verdict, "MAYBE");
});

test("low need is a skip", () => {
  const result = evaluate(CFG, model(choices("contemporary", "clear", "good")), NO_SIGNALS);
  assert.ok(result.need_score < 0.4);
  assert.equal(result.verdict, "SKIP");
});

test("a large company is still judged on its design, with a warning", () => {
  const result = evaluate(CFG, model(choices("poor", "lost", "amateur"), 0.05), NO_SIGNALS);
  assert.equal(result.verdict, "REACH_OUT");
  assert.ok(result.warnings.some((w) => w.includes("large company")));
});

test("the report exposes all three grades", () => {
  const result = evaluate(CFG, model(choices("contemporary", "clear", "good")), NO_SIGNALS);
  assert.deepEqual(Object.keys(result.scores), ["visual", "navigation", "credibility"]);
  assert.equal(result.scores.visual!.label, "Contemporary template");
  assert.equal(result.scores.visual!.score_0_to_10, 8);
});
