/**
 * The rules that decide what a list row means, without Redis.
 *
 * These are the parts that are easy to get subtly wrong: one row per domain,
 * a failed re-check never wiping a good score, an older report never replacing
 * a newer one, and a bounded history that still counts every run.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeReport,
  publicHistory,
  publicReport,
  publicSummary,
  siteKeyOf,
  summariesToCsv,
  validateKeyList,
  validateNotes,
  validateStatus,
  validateTags,
  type MergeContext,
  type RunRecord,
  type SiteSummary,
} from "../api/_lib/lists.js";
import type { Report } from "../api/_lib/types.js";

interface Overrides {
  input_url?: string;
  final_url?: string;
  analyzed_at?: string;
  verdict?: Report["verdict"];
  need_score?: number | null;
  design_quality?: number;
  scores?: Record<string, { score_0_to_10: number }>;
  category?: { name: string };
  design_era?: { name: string };
  platform?: string;
  emails?: string[];
  reasons?: string[];
}

function report(overrides: Overrides = {}): Report {
  return {
    input_url: overrides.input_url ?? "https://www.example-bakery.nl",
    final_url: overrides.final_url ?? "https://www.example-bakery.nl/",
    analyzed_at: overrides.analyzed_at ?? "2026-11-18T10:00:00Z",
    verdict: overrides.verdict ?? "REACH_OUT",
    reasons: overrides.reasons ?? ["The design looks dated and hard to use."],
    warnings: [],
    need_score: overrides.need_score === undefined ? 0.8 : overrides.need_score,
    design_quality: overrides.design_quality ?? 0.2,
    scores: overrides.scores ?? {
      visual: { score_0_to_10: 2.1 },
      navigation: { score_0_to_10: 4.2 },
      credibility: { score_0_to_10: 3.3 },
    },
    category: overrides.category ?? { name: "bakery" },
    design_era: overrides.design_era ?? { name: "2010s" },
    signals: { platform: overrides.platform ?? "wordpress" },
    contact: {
      emails: overrides.emails ?? ["hello@example-bakery.nl"],
      phones: ["+31201234567"],
      whatsapp: null,
      contact_page: null,
      social: {},
      has_form: false,
    },
  } as unknown as Report;
}

function ctx(runId: string, overrides: Partial<MergeContext> = {}): MergeContext {
  return {
    runId,
    batch: "batch-one",
    index: 0,
    source: "web",
    historyRuns: 15,
    ...overrides,
  };
}

function empty(): { summary: SiteSummary | null; history: RunRecord[] } {
  return { summary: null, history: [] };
}

test("siteKeyOf: one domain, whatever the input shape", () => {
  assert.equal(siteKeyOf(report({ input_url: "https://www.Example-Bakery.nl/about" })), "example-bakery.nl");
  assert.equal(siteKeyOf(report({ input_url: "http://example-bakery.nl", final_url: "" })), "example-bakery.nl");
  assert.equal(siteKeyOf(report({ input_url: "example-bakery.nl", final_url: "" })), "example-bakery.nl");
  assert.equal(
    siteKeyOf(report({ input_url: "https://blog.example-bakery.nl/", final_url: "" })),
    "blog.example-bakery.nl",
    "subdomains are separate sites",
  );
  assert.equal(
    siteKeyOf(report({ input_url: "https://xn--bcher-kva.example/", final_url: "" })),
    "xn--bcher-kva.example",
  );
});

test("siteKeyOf: an unusable address has no key", () => {
  assert.equal(siteKeyOf(report({ input_url: "not a url", final_url: "" })), null);
  assert.equal(siteKeyOf(report({ input_url: "", final_url: "" })), null);
});

test("merge: a first report creates the row", () => {
  const merged = mergeReport(empty(), report(), ctx("batch-one:0"));
  assert.ok(merged);
  assert.equal(merged.added, true);
  assert.equal(merged.changed, true);
  assert.equal(merged.summary.key, "example-bakery.nl");
  assert.equal(merged.summary.verdict, "REACH_OUT");
  assert.equal(merged.summary.profileVerdict, "REACH_OUT");
  assert.equal(merged.summary.need, 0.8);
  assert.equal(merged.summary.visual, 2.1);
  assert.equal(merged.summary.platform, "wordpress");
  assert.equal(merged.summary.email, "hello@example-bakery.nl");
  assert.equal(merged.summary.contactable, true);
  assert.equal(merged.summary.runs, 1);
  assert.equal(merged.summary.status, "new");
  assert.equal(merged.history.length, 1);
  assert.equal(merged.summary.batches[0], "batch-one");
});

test("merge: a newer scored run updates the profile and the delta", () => {
  const first = mergeReport(empty(), report({ need_score: 0.5 }), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const second = mergeReport(
    { summary: first.summary, history: first.history },
    report({ analyzed_at: "2026-11-19T10:00:00Z", need_score: 0.8 }),
    ctx("batch-two:3", { runId: "batch-two:3", batch: "batch-two", index: 3 }),
  );
  assert.ok(second);
  assert.equal(second.added, false);
  assert.equal(second.changed, true);
  assert.equal(second.summary.need, 0.8);
  assert.equal(second.summary.needDelta, 0.3);
  assert.equal(second.summary.runs, 2);
  assert.equal(second.summary.lastBatch, "batch-two");
  assert.equal(second.summary.profileBatch, "batch-two");
  assert.equal(second.history[0]?.batch, "batch-two");
  assert.equal(second.summary.firstAddedAt, first.summary.firstAddedAt);
});

test("merge: an older report only adds history", () => {
  const first = mergeReport(empty(), report({ need_score: 0.8 }), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const older = mergeReport(
    { summary: first.summary, history: first.history },
    report({ analyzed_at: "2026-01-01T10:00:00Z", need_score: 0.1 }),
    ctx("batch-old:0", { runId: "batch-old:0", batch: "batch-old" }),
  );
  assert.ok(older);
  assert.equal(older.summary.need, 0.8, "the profile never goes backwards");
  assert.equal(older.summary.needDelta, first.summary.needDelta);
  assert.equal(older.summary.runs, 2);
  assert.equal(older.history.length, 2);
  assert.equal(older.summary.profileAt, first.summary.profileAt);
});

test("merge: UNSCORED keeps the profile and raises attention", () => {
  const first = mergeReport(empty(), report({ need_score: 0.82 }), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const failed = mergeReport(
    { summary: first.summary, history: first.history },
    report({
      analyzed_at: "2026-11-20T10:00:00Z",
      verdict: "UNSCORED",
      need_score: null,
      reasons: ["The free Gemini quota is used up for now."],
    }),
    ctx("batch-three:0", { runId: "batch-three:0", batch: "batch-three" }),
  );
  assert.ok(failed);
  assert.equal(failed.summary.verdict, "REACH_OUT", "a quota failure does not lose the verdict");
  assert.equal(failed.summary.profileVerdict, "REACH_OUT");
  assert.equal(failed.summary.need, 0.82);
  assert.equal(failed.summary.attention, true);
  assert.equal(failed.summary.lastAttemptVerdict, "UNSCORED");
  assert.equal(failed.writeReport, false, "the last good report is kept");
});

test("merge: SITE_DOWN shows on the row but keeps the grades", () => {
  const first = mergeReport(empty(), report({ need_score: 0.7 }), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const down = mergeReport(
    { summary: first.summary, history: first.history },
    report({
      analyzed_at: "2026-11-21T10:00:00Z",
      verdict: "SITE_DOWN",
      need_score: null,
    }),
    ctx("batch-four:0", { runId: "batch-four:0", batch: "batch-four" }),
  );
  assert.ok(down);
  assert.equal(down.summary.verdict, "SITE_DOWN");
  assert.equal(down.summary.profileVerdict, "REACH_OUT");
  assert.equal(down.summary.need, 0.7);
  assert.equal(down.summary.attention, false);
});

test("merge: importing the same run twice changes nothing", () => {
  const first = mergeReport(empty(), report(), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const again = mergeReport({ summary: first.summary, history: first.history }, report(), ctx("batch-one:0"));
  assert.ok(again);
  assert.equal(again.changed, false);
  assert.equal(again.summary.runs, 1);
  assert.equal(again.history.length, 1);
});

test("merge: history is capped but every run is counted", () => {
  let state = empty();
  for (let index = 0; index < 6; index += 1) {
    const merged = mergeReport(
      state,
      report({ analyzed_at: `2026-11-${10 + index}T10:00:00Z`, need_score: 0.5 + index / 100 }),
      ctx(`batch-one:${index}`, { runId: `batch-one:${index}`, index, historyRuns: 3 }),
    );
    assert.ok(merged);
    state = { summary: merged.summary, history: merged.history };
  }
  assert.equal(state.summary?.runs, 6);
  assert.equal(state.history.length, 3);
  assert.equal(state.history[0]?.runId, "batch-one:5");
});

test("merge: status and notes survive a new run", () => {
  const first = mergeReport(empty(), report(), ctx("batch-one:0"));
  assert.ok(first?.summary);
  const edited: SiteSummary = {
    ...first.summary,
    status: "contacted",
    notes: "Emailed 18 Nov.",
    tags: ["bakery"],
  };
  const next = mergeReport(
    { summary: edited, history: first.history },
    report({ analyzed_at: "2026-12-01T10:00:00Z", need_score: 0.9 }),
    ctx("batch-two:0", { runId: "batch-two:0", batch: "batch-two" }),
  );
  assert.equal(next?.summary.status, "contacted");
  assert.equal(next?.summary.notes, "Emailed 18 Nov.");
  assert.deepEqual(next?.summary.tags, ["bakery"]);
});

test("validation: names, statuses, notes and tags", () => {
  assert.equal(validateStatus("follow_up"), "follow_up");
  assert.throws(() => validateStatus("maybe"), /Status must be/);
  assert.equal(validateNotes("  hello  "), "  hello  ");
  assert.throws(() => validateNotes("x".repeat(2_001)), /2,000/);
  assert.deepEqual(validateTags([" Bakery ", "bakery", "Amsterdam"]), ["Bakery", "Amsterdam"]);
  assert.throws(() => validateTags(Array.from({ length: 11 }, () => "tag")), /10 tags/);
  assert.deepEqual(validateKeyList(["A.NL", "a.nl", "b.nl"], 10), ["a.nl", "b.nl"]);
  assert.throws(() => validateKeyList(["../etc/passwd"], 10), /not valid/);
});

test("public projections hide the owner's working data", () => {
  const merged = mergeReport(empty(), report(), ctx("batch-one:0"));
  assert.ok(merged?.summary);
  const summary = { ...merged.summary, notes: "private", tags: ["private"] };
  const shown = publicSummary(summary);
  assert.equal(shown["notes"], undefined);
  assert.equal(shown["status"], undefined);
  assert.equal(shown["email"], undefined);
  assert.equal(shown["tags"], undefined);
  assert.equal(shown["batches"], undefined);
  assert.equal(shown["host"], "example-bakery.nl");
  assert.equal(shown["contactable"], true);

  const history = publicHistory(merged.history);
  assert.equal(history[0]?.["batch"], undefined);
  assert.equal(history[0]?.["index"], undefined);
  assert.equal(history[0]?.["verdict"], "REACH_OUT");

  const full = report();
  const hidden = publicReport(full);
  assert.equal(hidden?.["contact"], undefined);
  assert.equal((hidden?.["signals"] as Record<string, unknown>)["contact"], undefined);
  assert.equal(hidden?.["verdict"], "REACH_OUT");
});

test("csv: BOM, CRLF and escaped fields", () => {
  const merged = mergeReport(empty(), report(), ctx("batch-one:0"));
  assert.ok(merged?.summary);
  const csv = summariesToCsv([
    { ...merged.summary, notes: 'Said "maybe", then\nnothing', tags: ["bakery", "ams"] },
  ]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes('"Said ""maybe"", then nothing"'));
  assert.ok(csv.includes('"bakery; ams"'));
  assert.ok(csv.includes('"example-bakery.nl"'));
});
