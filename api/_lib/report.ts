/** Report helpers shared by the pipeline and the HTTP handler. */
import type { Report, Verdict } from "./types.js";

export const VERDICT_ORDER: Verdict[] = ["REACH_OUT", "MAYBE", "SKIP", "SITE_DOWN", "UNSCORED"];

export function baseReport(url: string): Report {
  return {
    input_url: url,
    analyzed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    verdict: "UNSCORED",
    reasons: [],
    warnings: [],
  };
}

export function verdictTotals(reports: Report[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const verdict of VERDICT_ORDER) {
    const count = reports.filter((r) => r.verdict === verdict).length;
    if (count > 0) totals[verdict] = count;
  }
  return totals;
}
