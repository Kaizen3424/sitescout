/**
 * Runs exactly one URL of a job and stores its report.
 *
 * One URL per invocation keeps every run far below Vercel's 300 s limit and
 * means a failure or retry only affects that single page.
 */
import type { AnalyzeDeps } from "./pipeline.js";
import { analyzeUrl, failedReport } from "./pipeline.js";
import { hasReport, loadJobConfig, readMeta, resultCount, saveReport } from "./jobs.js";
import type { Report } from "./types.js";

export interface JobItemResult {
  done: number;
  total: number;
  complete: boolean;
  /** True when there was nothing to do (job gone, index already finished). */
  skipped: boolean;
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

  const deadline = Date.now() + deps.settings.requestDeadlineMs;
  let report: Report;
  try {
    report = await analyzeUrl(url, deps, { fresh: meta.fresh, deadline });
  } catch (err) {
    // Never let one page stall the batch: keep the failure as a report.
    report = failedReport(url, err);
    console.warn(`job ${jobId} item ${index} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ...(await saveReport(jobId, index, report, config)), skipped: false };
}
