/**
 * Runs exactly one URL of a job and stores its report.
 *
 * One URL per invocation keeps every run far below Vercel's 300 s limit and
 * means a failure or retry only affects that single page.
 *
 * A temporary Gemini quota limit is not a failure: the URL is put back in the
 * queue with a delay and the batch simply takes longer. Only after several
 * attempts does the URL become an "unscored" report, with the real reason.
 */
import { QuotaDeferredError } from "./errors.js";
import {
  bumpAttempt,
  claimItem,
  hasReport,
  loadJobConfig,
  markWaiting,
  readMeta,
  releaseClaim,
  requeueItem,
  resultCount,
  saveReport,
  type JobConfig,
  type JobMeta,
} from "./jobs.js";
import type { AnalyzeDeps } from "./pipeline.js";
import { analyzeUrl, failedReport } from "./pipeline.js";
import { millisecondsUntilPacificMidnight } from "./quota.js";
import type { Report } from "./types.js";

export interface JobItemResult {
  done: number;
  total: number;
  complete: boolean;
  /** True when there was nothing to do (job gone, index already finished). */
  skipped: boolean;
  /** Set when the URL went back in the queue to wait for Gemini quota. */
  deferred?: { retryInSeconds: number; attempt: number; reason: string };
}

/** Waits get longer with every attempt, but never longer than a quarter hour. */
const MAX_MINUTE_DELAY_MS = 15 * 60_000;

function nextDelayMs(err: QuotaDeferredError, attempt: number, baseMs: number): number {
  if (err.scope === "day") {
    // Google resets the daily limit at midnight Pacific, so waiting anything
    // less than that is pointless.
    return Math.min(23 * 3_600_000, millisecondsUntilPacificMidnight());
  }
  const backoff = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.max(15_000, Math.min(MAX_MINUTE_DELAY_MS, Math.max(err.retryAfterMs, backoff)));
}

export async function processJobItem(
  jobId: string,
  index: number,
  deps: AnalyzeDeps,
): Promise<JobItemResult> {
  const config = loadJobConfig();
  const meta = await readMeta(jobId);

  if (!meta) {
    // The job expired or was never real: acknowledge so QStash stops retrying.
    return { done: 0, total: 0, complete: true, skipped: true };
  }
  if (!Number.isInteger(index) || index < 0 || index >= meta.total) {
    return { done: 0, total: meta.total, complete: false, skipped: true };
  }
  if (await hasReport(jobId, index)) {
    const done = await resultCount(jobId);
    return { done, total: meta.total, complete: done >= meta.total, skipped: true };
  }

  const url = meta.urls[index];
  if (!url) return { done: 0, total: meta.total, complete: false, skipped: true };

  // QStash delivers at least once; a claim makes sure two deliveries of the
  // same URL cannot both call Gemini and pay twice.
  if (!(await claimItem(jobId, index))) {
    console.info(`job ${jobId} item ${index} is already being analysed - skipping this delivery`);
    const done = await resultCount(jobId);
    return { done, total: meta.total, complete: done >= meta.total, skipped: true };
  }

  try {
    const deadline = Date.now() + deps.settings.requestDeadlineMs;
    let report: Report;
    try {
      report = await analyzeUrl(url, deps, { fresh: meta.fresh, deadline });
    } catch (err) {
      if (err instanceof QuotaDeferredError) {
        return await defer(jobId, index, url, err, deps, meta, config);
      }
      // Never let one page stall the batch: keep the failure as a report.
      report = failedReport(url, err);
      console.warn(`job ${jobId} item ${index} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ...(await saveReport(jobId, index, report, config)), skipped: false };
  } finally {
    // The claim expires on its own; releasing it early lets a QStash retry
    // (after a crash) pick the item up immediately.
    await releaseClaim(jobId, index).catch(() => undefined);
  }
}

/**
 * Puts one URL back in the queue after a delay instead of writing "unscored".
 *
 * Returns normally (200 to QStash) so its own short retries do not fire; the
 * delayed message is what brings the URL back.
 */
async function defer(
  jobId: string,
  index: number,
  url: string,
  err: QuotaDeferredError,
  deps: AnalyzeDeps,
  meta: JobMeta,
  config: JobConfig,
): Promise<JobItemResult> {
  const attempt = await bumpAttempt(jobId, index, config.ttlSeconds);
  // A daily limit is worth one retry (after midnight Pacific), not five.
  const maxAttempts =
    err.scope === "day" ? Math.min(2, deps.settings.quotaMaxAttempts) : deps.settings.quotaMaxAttempts;

  if (attempt > maxAttempts) {
    const scope = err.scope === "day" ? "daily" : "per-minute";
    const report = failedReport(
      url,
      new QuotaDeferredError(
        `Gemini stayed out of ${scope} quota after ${attempt} attempts (${err.message}). ` +
          (err.scope === "day"
            ? "The daily limit resets at midnight Pacific; run this URL again afterwards."
            : "Try again in a few minutes, or add more Gemini keys from separate projects."),
        { retryAfterMs: err.retryAfterMs, scope: err.scope },
      ),
    );
    console.warn(`job ${jobId} item ${index}: giving up after ${attempt} quota deferrals`);
    return { ...(await saveReport(jobId, index, report, config)), skipped: false };
  }

  const delayMs = nextDelayMs(err, attempt, deps.settings.quotaRetryBaseMs);
  await markWaiting(jobId, index, Date.now() + delayMs, config.ttlSeconds);
  // If publishing fails the error propagates: QStash then retries this
  // delivery itself, which is better than losing the URL.
  await requeueItem(jobId, index, delayMs / 1000, attempt, config);

  const done = await resultCount(jobId);
  console.warn(
    `job ${jobId} item ${index}: waiting ${Math.round(delayMs / 1000)}s for Gemini quota ` +
      `(attempt ${attempt}/${maxAttempts})`,
  );
  return {
    done,
    total: meta.total,
    complete: false,
    skipped: false,
    deferred: { retryInSeconds: Math.round(delayMs / 1000), attempt, reason: err.message },
  };
}
