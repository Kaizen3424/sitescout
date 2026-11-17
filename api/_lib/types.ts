/** Shared types for captures, model answers and reports. */

export type Verdict = "REACH_OUT" | "MAYBE" | "SKIP" | "SITE_DOWN" | "UNSCORED";

export interface ScoreAnswer {
  score: number;
  levels: number;
  norm: number;
  confidence: number;
}

export interface YesNoAnswer {
  p: number;
  confidence: number;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ParsedAnswers {
  scores: Record<string, ScoreAnswer>;
  yesno: Record<string, YesNoAnswer>;
  choices: Record<string, ChoiceAnswer>;
}

export interface Capture {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  html: string;
  title: string;
  siteName: string;
  image: Buffer;
  fetchedAt: number;
}

export interface HtmlFlag {
  id: string;
  label: string;
  phrase: string;
  weight: number;
}

export interface HtmlCheck {
  ok: boolean;
  text: string;
}

export interface ContactInfo {
  emails: string[];
  phones: string[];
  whatsapp: string | null;
  contact_page: string | null;
  social: Record<string, string>;
  has_form: boolean;
  best?: string | null;
}

export interface HtmlSignals {
  available: boolean;
  flags: HtmlFlag[];
  checks: HtmlCheck[];
  platform: string | null;
  generator: string | null;
  copyright_year: number | null;
  contact: ContactInfo;
  note?: string;
}

export interface Issue {
  label: string;
  phrase: string;
  severity: number;
}

export interface GradeScore {
  score_0_to_10: number;
  confidence: number;
  grade: string;
  label: string;
  probabilities: Record<string, number>;
}

export interface NeedParts {
  visual: number;
  navigation: number;
  credibility: number;
  signals: number;
}

export interface Evaluation {
  verdict: Verdict;
  need_score: number;
  need_model: number;
  need_signals: number;
  need_parts: NeedParts;
  design_quality: number;
  model_confidence: number;
  design_confidence: number;
  scores: Record<string, GradeScore>;
  probabilities: {
    outdated: number;
    unprofessional: number;
    old_era: number;
    small_local_business: number;
    placeholder: number;
    overlay: number;
    broken_or_blank: number;
  };
  reasons: string[];
  warnings: string[];
  issues: Issue[];
  category: { name: string; confidence: number };
  design_era: { name: string; confidence: number };
}

/**
 * A report uses the same field names as the Python CLI's `report.json`.
 * Extra module-specific fields are allowed so both tools can evolve.
 */
export interface Report {
  input_url: string;
  analyzed_at: string;
  verdict: Verdict;
  reasons: string[];
  warnings: string[];
  [key: string]: unknown;
}
