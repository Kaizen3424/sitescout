/**
 * The analyse pipeline: capture -> HTML checks -> Gemini -> verdict.
 * Mirrors the Python CLI's `analyze()`, without any image resizing.
 */
import { createHash } from "node:crypto";
import { runDecisions } from "./decisions.js";
import type { Settings } from "./env.js";
import { CaptureError, DecisionError, InvalidUrlError, SiteScoutError } from "./errors.js";
import { captureSite } from "./firecrawl.js";
import { analyzeHtml, guessBusinessName } from "./htmlchecks.js";
import { describeImage } from "./imagesize.js";
import type { KeyPool } from "./keys.js";
import { baseReport } from "./report.js";
import { evaluate, outreachOpening } from "./scoring.js";
import type { Capture, Report } from "./types.js";
import { normalizeUrl } from "./urls.js";

export interface AnalyzeOptions {
  fresh: boolean;
  signal?: AbortSignal;
  /** Absolute Date.now() timestamp for the whole HTTP request. */
  deadline: number;
}

export interface AnalyzeDeps {
  settings: Settings;
  firecrawl: KeyPool;
  gemini: KeyPool;
}

export async function analyzeUrl(
  input: string,
  deps: AnalyzeDeps,
  opts: AnalyzeOptions,
): Promise<Report> {
  const { settings } = deps;
  const url = normalizeUrl(input);
  const host = new URL(url).hostname;
  const report = baseReport(url);
  const started = Date.now();

  let capture: Capture;
  try {
    capture = await captureSite(url, settings, deps.firecrawl, opts.fresh, {
      signal: opts.signal,
      deadline: opts.deadline,
    });
  } catch (err) {
    if (!(err instanceof CaptureError)) throw err;
    if (err.kind === "down") {
      report.verdict = "SITE_DOWN";
      report.reasons.push(
        `The site appears non-functional: ${err.message}. If it stays down when you retry later, ` +
          "the business may have a dead website, which is a strong lead.",
      );
    } else if (err.kind === "blocked") {
      report.reasons.push(`Capture blocked by the site or its bot protection: ${err.message}. Review manually.`);
    } else {
      report.reasons.push(`Capture failed: ${err.message}`);
    }
    report.capture_error = { kind: err.kind, message: err.message };
    return report;
  }

  report.final_url = capture.finalUrl;
  report.from_cache = false;
  report.business = { name: guessBusinessName(capture), title: capture.title };

  const signals = analyzeHtml(capture);
  report.signals = signals;
  report.contact = signals.contact;

  const imageInfo = describeImage(capture.image);
  report.image = { ...imageInfo, resize: "none", crop: "none" };

  const pageKey = `${capture.finalUrl}\n${createHash("sha1").update(capture.html).digest("hex")}`;
  let modelOut;
  try {
    modelOut = await runDecisions({
      settings,
      pool: deps.gemini,
      image: capture.image,
      mime: imageInfo.mime,
      pageKey,
      fresh: opts.fresh,
      signal: opts.signal,
      deadline: opts.deadline,
    });
  } catch (err) {
    if (!(err instanceof CaptureError) && !(err instanceof DecisionError)) throw err;
    report.reasons.push(`Could not score the design: ${err.message}`);
    if (err instanceof DecisionError && err.kind === "safety") {
      report.reasons.push("Gemini's safety filter blocked the screenshot.");
    } else if (err instanceof DecisionError && err.kind === "quota") {
      report.reasons.push(
        "The free Gemini quota is used up for now. Retry this URL later (in an hour or tomorrow): " +
          "the question groups already answered are cached, so the retry only pays for what is missing.",
      );
    }
    report.elapsed_s = Math.round((Date.now() - started) / 100) / 10;
    return report;
  }

  const evaluation = evaluate(settings, modelOut, signals);
  Object.assign(report, evaluation);
  report.scores = Object.fromEntries(
    Object.entries(modelOut.scores).map(([key, value]) => [
      key,
      { score_0_to_10: Math.round(value.norm * 100) / 10, confidence: Math.round(value.confidence * 1000) / 1000 },
    ]),
  );
  report.model_usage = modelOut.usage;
  report.model_cached = modelOut.fromCache;
  report.outreach = {
    best_contact: signals.contact.best ?? null,
    opening_line:
      evaluation.verdict === "REACH_OUT" || evaluation.verdict === "MAYBE"
        ? outreachOpening(guessBusinessName(capture), host, evaluation.issues)
        : null,
  };
  report.elapsed_s = Math.round((Date.now() - started) / 100) / 10;
  return report;
}

/** Turns any per-URL failure into a report instead of failing the batch. */
export function failedReport(url: string, err: unknown): Report {
  const report = baseReport(url);
  if (err instanceof InvalidUrlError) {
    report.reasons.push(err.message);
    report.input_error = true;
    return report;
  }
  if (err instanceof SiteScoutError) {
    report.reasons.push(err.message);
    return report;
  }
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  report.reasons.push(`Internal error: ${message}`);
  return report;
}
