"""Unit tests for the redesign-need formula. Run from cli/: python -m unittest test_scoring -v"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

import scoring


def _choice(grade: str, level: str, confidence: float = 0.8) -> dict:
    probs = {k: 0.0 for k in scoring.GRADE_GAPS[grade]}
    probs[level] = 1.0
    return {"choice": level, "confidence": confidence, "probabilities": probs}


def _choices(visual: str = "contemporary", navigation: str = "clear",
             credibility: str = "good", confidence: float = 0.8) -> dict:
    return {
        "visual_grade": _choice("visual", visual, confidence),
        "navigation_grade": _choice("navigation", navigation, confidence),
        "credibility_grade": _choice("credibility", credibility, confidence),
        "design_era": {"choice": "2022_or_later", "confidence": 0.8,
                       "probabilities": {"before_2012": 0.0, "2012_2017": 0.0,
                                         "2018_2021": 0.1, "2022_or_later": 0.9}},
        "business_category": {"choice": "professional_services", "confidence": 0.9,
                              "probabilities": {"professional_services": 0.9, "other": 0.1}},
    }


def _yn(p: float = 0.0, confidence: float = 0.9) -> dict:
    return {"p": p, "confidence": confidence}


def _model(choices: dict | None = None, p_local: float = 0.9) -> dict:
    return {
        "scores": {},
        "yesno": {
            "looks_outdated": _yn(0.1),
            "looks_unprofessional": _yn(0.1),
            "page_is_broken_or_blank": _yn(0.0),
            "is_placeholder_page": _yn(0.0),
            "is_small_local_business": _yn(p_local),
            "obscured_by_overlay": _yn(0.0),
        },
        "choices": choices or _choices(),
    }


CFG = SimpleNamespace(reach_out_threshold=0.60, maybe_threshold=0.40, min_confidence=0.55)
NO_SIGNALS = {"available": False}


class FormulaTests(unittest.TestCase):
    def test_weights_are_60_20_20(self) -> None:
        self.assertEqual(scoring.GRADE_WEIGHTS, {"visual": 0.60, "navigation": 0.20, "credibility": 0.20})

    def test_expected_gap_uses_probabilities(self) -> None:
        answer = {"choice": "dated_tidy", "confidence": 0.7,
                  "probabilities": {"dated_tidy": 0.5, "dated": 0.5}}
        self.assertAlmostEqual(scoring.expected_gap(answer, scoring.GRADE_GAPS["visual"]), 0.65)

    def test_expected_gap_normalises_mass(self) -> None:
        answer = {"choice": "dated_tidy", "confidence": 0.7,
                  "probabilities": {"dated_tidy": 0.25, "dated": 0.25}}
        self.assertAlmostEqual(scoring.expected_gap(answer, scoring.GRADE_GAPS["visual"]), 0.65)

    def test_hand_calculated_score(self) -> None:
        scored = scoring.score_from_grades(_choices(visual="dated", navigation="clear", credibility="good"))
        # 0.60*0.8 + 0.20*0.2 + 0.20*0.2 = 0.56
        self.assertAlmostEqual(scored["need_model"], 0.56, places=6)

    def test_visual_dominates_the_other_two(self) -> None:
        dated_but_usable = scoring.score_from_grades(
            _choices(visual="dated", navigation="effortless", credibility="excellent"))
        pretty_but_lost = scoring.score_from_grades(
            _choices(visual="premium", navigation="lost", credibility="amateur"))
        self.assertGreater(dated_but_usable["need_model"], pretty_but_lost["need_model"])

    def test_need_parts_sum_to_need(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="dated_tidy", navigation="workable",
                                                       credibility="ordinary")), NO_SIGNALS)
        self.assertAlmostEqual(sum(result["need_parts"].values()), result["need_score"], places=3)

    def test_design_quality_is_inverse_of_model(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="dated")), NO_SIGNALS)
        self.assertAlmostEqual(result["design_quality"], 1 - result["need_model"], places=3)

    def test_signals_are_ten_percent(self) -> None:
        choices = _choices(visual="dated", navigation="clear", credibility="good")
        signals = {"available": True,
                   "flags": [{"id": "no_https", "label": "No HTTPS", "phrase": "browsers label it unsafe",
                              "weight": 0.5}],
                   "contact": {"best": "email hello@example.com"}}
        result = scoring.evaluate(CFG, _model(choices), signals)
        self.assertAlmostEqual(result["need_score"], 0.56 + 0.1 * 0.5, places=3)


class VerdictTests(unittest.TestCase):
    def test_high_need_reaches_out(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="dated", navigation="workable",
                                                       credibility="ordinary")), NO_SIGNALS)
        self.assertGreaterEqual(result["need_score"], 0.60)
        self.assertEqual(result["verdict"], "REACH_OUT")

    def test_middle_need_is_maybe(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="dated_tidy", navigation="clear",
                                                       credibility="ordinary")), NO_SIGNALS)
        self.assertGreaterEqual(result["need_score"], 0.40)
        self.assertLess(result["need_score"], 0.60)
        self.assertEqual(result["verdict"], "MAYBE")

    def test_low_need_is_skip(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="contemporary", navigation="clear",
                                                       credibility="good")), NO_SIGNALS)
        self.assertLess(result["need_score"], 0.40)
        self.assertEqual(result["verdict"], "SKIP")

    def test_large_company_gate_beats_score(self) -> None:
        result = scoring.evaluate(CFG, _model(_choices(visual="poor", navigation="lost",
                                                       credibility="amateur"), p_local=0.05), NO_SIGNALS)
        self.assertEqual(result["verdict"], "SKIP")


if __name__ == "__main__":
    unittest.main()
