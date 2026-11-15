/**
 * The single Vercel function: routing, bearer-token auth for /v1/analyze and
 * the durable batch endpoints under /v1/jobs. All logic lives in `_lib/` (the
 * leading underscore keeps Vercel from deploying those files as functions).
 */
import { timingSafeEqual } from "node:crypto";
import { API_VERSION } from "./_lib/env.js";
import { ConfigError, FatalApiError, InvalidUrlError, SiteScoutError } from "./_lib/errors.js";
import {
  consumeQuota,
  createJob,
  dispatchJob,
  isValidJobId,
  loadJobConfig,
  readJob,
  verifyCallback,
  type JobView,
} from "./_lib/jobs.js";
import { processJobItem } from "./_lib/jobrunner.js";
import { analyzeUrl, failedReport, type AnalyzeDeps } from "./_lib/pipeline.js";
import { baseReport, verdictTotals } from "./_lib/report.js";
import { getRuntime, type Runtime } from "./_lib/runtime.js";
import type { Report } from "./_lib/types.js";
import { normalizeUrl } from "./_lib/urls.js";

const MAX_BODY_URLS = 10;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failure(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error, ...extra }, status);
}

function serverError(err: unknown): Response {
  if (err instanceof ConfigError) return failure(err.message, 500);
  console.error("unhandled error", err);
  return failure("Internal error. Try again in a moment.", 500);
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request, expected: string): boolean {
  const header = (request.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && tokenMatches(match[1]!.trim(), expected);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Placeholder report for a URL the request budget did not reach. */
function budgetReport(url: string): Report {
  const report = baseReport(url);
  report.reasons.push(
    "The request time budget was exhausted before this URL could be analysed. " +
      "Send it in its own request (a screenshot of a very tall page can take longer).",
  );
  report.deadline_exceeded = true;
  return report;
}

function health(): Response {
  try {
    const runtime = getRuntime();
    return json({
      ok: true,
      version: API_VERSION,
      // Which commit is actually serving this request, so a deploy can be verified.
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      model: runtime.settings.decisionModel,
      keys: {
        firecrawl: runtime.firecrawl.summary(),
        gemini: runtime.gemini.summary(),
      },
      limits: {
        max_urls: runtime.settings.maxUrls,
        concurrency: runtime.settings.concurrency,
        request_deadline_s: Math.round(runtime.settings.requestDeadlineMs / 1000),
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) return json({ ok: false, error: err.message }, 503);
    throw err;
  }
}

interface AnalyzeRequest {
  urls: string[];
  fresh: boolean;
}

function parseAnalyzeBody(body: unknown): AnalyzeRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  let urls: unknown[];
  if (Array.isArray(record.urls)) {
    urls = record.urls;
  } else if (typeof record.url === "string") {
    urls = [record.url];
  } else {
    return { error: "Send { \"urls\": [\"example.com\"] } or { \"url\": \"example.com\" }." };
  }

  if (urls.length === 0) return { error: "No URLs given." };
  if (urls.length > MAX_BODY_URLS) return { error: `At most ${MAX_BODY_URLS} URLs per request.` };
  if (!urls.every((u): u is string => typeof u === "string" && u.trim() !== "")) {
    return { error: "Every entry in 'urls' must be a non-empty string." };
  }
  if (record.fresh !== undefined && typeof record.fresh !== "boolean") {
    return { error: "'fresh' must be true or false." };
  }
  return { urls: urls.map((u) => u.trim()), fresh: record.fresh === true };
}

function analyzeDeps(runtime: Runtime): AnalyzeDeps {
  return { settings: runtime.settings, firecrawl: runtime.firecrawl, gemini: runtime.gemini };
}

/* ------------------------------------------------------- /v1/analyze (sync) */

async function handleAnalyze(request: Request): Promise<Response> {
  const started = Date.now();
  let runtime: Runtime;
  try {
    runtime = getRuntime();
  } catch (err) {
    return serverError(err);
  }

  if (!authorized(request, runtime.settings.apiToken)) {
    return failure("Missing or invalid bearer token.", 401, {
      hint: "Send: Authorization: Bearer <SITESCOUT_API_TOKEN>",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("Body is not valid JSON.", 400);
  }

  const parsed = parseAnalyzeBody(body);
  if ("error" in parsed) return failure(parsed.error, 400);
  if (parsed.urls.length > runtime.settings.maxUrls) {
    return failure(
      `This deployment accepts at most ${runtime.settings.maxUrls} URLs per request ` +
        `(got ${parsed.urls.length}). Split the list into smaller batches.`,
      400,
    );
  }

  const deadline = started + runtime.settings.requestDeadlineMs;
  // Abort everything still in flight when the budget runs out, so the batch
  // unwinds and answers with partial results instead of being killed by the
  // platform (which would return an HTML 504, not JSON).
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), runtime.settings.requestDeadlineMs);
  const signal = AbortSignal.any([request.signal, budget.signal]);

  const deps = analyzeDeps(runtime);

  // Prefilled placeholders: whatever is still unfinished when the hard stop
  // fires keeps its "budget exhausted" report.
  const results: Report[] = parsed.urls.map((raw) => budgetReport(raw));
  let fatal: string | null = null;

  const work = mapLimit(parsed.urls, runtime.settings.concurrency, async (raw, index) => {
    if (Date.now() >= deadline) return;
    try {
      results[index] = await analyzeUrl(raw, deps, {
        fresh: parsed.fresh,
        signal,
        deadline,
      });
    } catch (err) {
      if (err instanceof FatalApiError) fatal ??= err.message;
      if (err instanceof SiteScoutError && !(err instanceof FatalApiError)) {
        console.warn(`analyse failed for ${raw}: ${err.message}`);
      } else if (!(err instanceof FatalApiError)) {
        console.error(`unexpected error for ${raw}`, err);
      }
      results[index] = failedReport(raw, err);
    }
  }).catch((err: unknown) => {
    // A worker crashed in a way the per-URL handler did not see: keep the
    // placeholders rather than failing the whole batch.
    console.error("analyse worker crashed", err);
  });

  // Belt and braces: if a worker somehow ignores the abort, answer anyway
  // while there is still time left before Vercel's 300 s limit.
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<void>((resolve) => {
    hardTimer = setTimeout(
      resolve,
      Math.min(runtime.settings.requestDeadlineMs + 15_000, 292_000),
    );
  });
  try {
    await Promise.race([work, hardStop]);
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(budgetTimer);
  }

  return json({
    ok: true,
    count: results.length,
    results,
    totals: verdictTotals(results),
    elapsed_s: Math.round((Date.now() - started) / 100) / 10,
    model: runtime.settings.decisionModel,
    ...(fatal ? { fatal } : {}),
  });
}

/* ------------------------------------------------------------ /v1/jobs (durable) */

interface JobRequest {
  urls: string[];
  fresh: boolean;
}

function parseJobBody(body: unknown): JobRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  let urls: unknown[];
  if (Array.isArray(record.urls)) {
    urls = record.urls;
  } else if (typeof record.url === "string") {
    urls = [record.url];
  } else {
    return { error: "Send { \"urls\": [\"example.com\", ...] }." };
  }
  if (urls.length === 0) return { error: "No URLs given." };
  if (!urls.every((u): u is string => typeof u === "string" && u.trim() !== "")) {
    return { error: "Every entry in 'urls' must be a non-empty string." };
  }
  if (record.fresh !== undefined && typeof record.fresh !== "boolean") {
    return { error: "'fresh' must be true or false." };
  }
  return { urls: urls.map((u) => u.trim()), fresh: record.fresh === true };
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function jobPayload(view: JobView): Record<string, unknown> {
  return { ...view, totals: verdictTotals(view.results) };
}

async function handleCreateJob(request: Request): Promise<Response> {
  let runtime: Runtime;
  try {
    runtime = getRuntime();
    // Validate storage/QStash configuration before doing any work.
    loadJobConfig();
  } catch (err) {
    return serverError(err);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("Body is not valid JSON.", 400);
  }

  const parsed = parseJobBody(body);
  if ("error" in parsed) return failure(parsed.error, 400);

  const config = loadJobConfig();
  if (parsed.urls.length > config.maxUrls) {
    return failure(
      `At most ${config.maxUrls} websites per batch (got ${parsed.urls.length}).`,
      400,
    );
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  const rejected: string[] = [];
  for (const raw of parsed.urls) {
    try {
      const normalized = normalizeUrl(raw);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch (err) {
      if (err instanceof InvalidUrlError) rejected.push(raw);
      else throw err;
    }
  }
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).join(", ");
    const more = rejected.length > 5 ? ` and ${rejected.length - 5} more` : "";
    return failure(`Not usable as a website address: ${shown}${more}.`, 400, {
      rejected,
    });
  }
  if (urls.length === 0) return failure("No usable URLs given.", 400);

  let quota;
  try {
    quota = await consumeQuota(clientIp(request), urls.length, config);
  } catch (err) {
    return serverError(err);
  }
  if (!quota.ok) {
    return failure(quota.message ?? "Too many requests.", 429, {
      retry_after_s: quota.retryAfterSeconds ?? 600,
    });
  }

  let job: JobView;
  try {
    const meta = await createJob(urls, parsed.fresh, config);
    if (config.inline) {
      // Development convenience: no public URL is reachable by QStash, so run
      // the batch inside the request. Keep batches small when you use this.
      await Promise.allSettled(
        urls.map((_, index) => processJobItem(meta.id, index, analyzeDeps(runtime))),
      );
    } else {
      try {
        await dispatchJob(meta.id, config);
      } catch (err) {
        console.error("job dispatch failed", err);
        const view = await readJob(meta.id, config);
        return json(
          {
            ok: true,
            dispatched: false,
            warning:
              "The batch was saved but the background queue could not be reached. " +
              "Open the batch and press Start analysis to try again.",
            job: view ? jobPayload(view) : { id: meta.id, total: meta.total },
          },
          201,
        );
      }
    }
    const view = await readJob(meta.id, config);
    if (!view) return failure("The batch could not be read back after saving.", 500);
    job = view;
  } catch (err) {
    return serverError(err);
  }

  return json({ ok: true, dispatched: true, job: jobPayload(job) }, 201);
}

async function handleRunJobItem(request: Request): Promise<Response> {
  let runtime: Runtime;
  let config;
  try {
    runtime = getRuntime();
    config = loadJobConfig();
  } catch (err) {
    return serverError(err);
  }

  const raw = await request.text();
  if (!(await verifyCallback(raw, request.headers.get("upstash-signature"), config))) {
    return failure("Missing or invalid QStash signature.", 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure("Body is not valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return failure("Body must be a JSON object.", 400);
  }
  const record = body as Record<string, unknown>;
  const jobId = typeof record.jobId === "string" ? record.jobId : "";
  const index = typeof record.index === "number" ? record.index : Number(record.index);
  if (!isValidJobId(jobId) || !Number.isInteger(index) || index < 0) {
    return failure("Expected { \"jobId\": \"...\", \"index\": 0 }.", 400);
  }

  try {
    const result = await processJobItem(jobId, index, analyzeDeps(runtime));
    return json({ ok: true, ...result });
  } catch (err) {
    // A 5xx makes QStash retry, which is what we want for a transient failure.
    return serverError(err);
  }
}

async function handleGetJob(jobId: string): Promise<Response> {
  try {
    const config = loadJobConfig();
    if (!isValidJobId(jobId)) return failure("Unknown batch.", 404);
    const view = await readJob(jobId, config);
    if (!view) return failure("This batch has expired or does not exist.", 404);
    return json({ ok: true, job: jobPayload(view) });
  } catch (err) {
    return serverError(err);
  }
}

async function handleRetryJob(jobId: string): Promise<Response> {
  try {
    const config = loadJobConfig();
    if (!isValidJobId(jobId)) return failure("Unknown batch.", 404);
    const view = await readJob(jobId, config);
    if (!view) return failure("This batch has expired or does not exist.", 404);
    if (view.status === "completed") {
      return json({ ok: true, dispatched: 0, job: jobPayload(view) });
    }
    if (!view.canRetry) {
      return failure(
        "This batch cannot be restarted any more. Start a new batch instead.",
        429,
      );
    }
    const queued = await dispatchJob(jobId, config);
    const after = await readJob(jobId, config);
    return json({ ok: true, dispatched: queued, job: jobPayload(after ?? view) });
  } catch (err) {
    return serverError(err);
  }
}

async function handleJobReport(jobId: string): Promise<Response> {
  try {
    const config = loadJobConfig();
    if (!isValidJobId(jobId)) return failure("Unknown batch.", 404);
    const view = await readJob(jobId, config);
    if (!view) return failure("This batch has expired or does not exist.", 404);
    // Same shape as the CLI's report.json: a plain array of reports.
    return new Response(JSON.stringify(view.results, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="sitescout-${jobId}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

/* ------------------------------------------------------------------ routing */

function routeOf(url: URL): { pathname: string; jobId: string } {
  const forced = url.searchParams.get("__route");
  const jobId = (url.searchParams.get("jobId") ?? "").trim();
  switch (forced) {
    case "health":
      return { pathname: "/health", jobId };
    case "analyze":
      return { pathname: "/v1/analyze", jobId };
    case "api":
      return { pathname: "/v1", jobId };
    case "jobs":
      return { pathname: "/v1/jobs", jobId };
    case "job_run":
      return { pathname: "/v1/jobs/run", jobId };
    case "job":
      return { pathname: `/v1/jobs/${jobId}`, jobId };
    case "job_retry":
      return { pathname: `/v1/jobs/${jobId}/retry`, jobId };
    case "job_report":
      return { pathname: `/v1/jobs/${jobId}/report.json`, jobId };
    default:
      return { pathname: url.pathname, jobId };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = routeOf(new URL(request.url));
    const method = request.method;

    if (pathname === "/health") {
      if (method !== "GET" && method !== "HEAD") return failure("Use GET /health.", 405);
      return health();
    }

    if (pathname === "/v1" || pathname === "/api" || pathname === "/") {
      return json({
        name: "SiteScout API",
        version: API_VERSION,
        web: "The batch interface is served at /.",
        endpoints: {
          "POST /v1/analyze": "Analyse 1-5 websites now. Bearer token required.",
          "POST /v1/jobs": "Queue 1-50 websites and collect the reports later.",
          "GET /v1/jobs/:id": "Progress and reports for one batch.",
          "POST /v1/jobs/:id/retry": "Queue the websites that are still missing.",
          "GET /v1/jobs/:id/report.json": "Download the batch as report.json.",
          "GET /health": "Key and configuration status.",
        },
      });
    }

    if (pathname === "/v1/analyze") {
      if (method !== "POST") return failure("Use POST /v1/analyze.", 405, { allow: "POST" });
      return handleAnalyze(request);
    }

    if (pathname === "/v1/jobs") {
      if (method !== "POST") {
        return failure("Use POST /v1/jobs to create a batch.", 405, { allow: "POST" });
      }
      return handleCreateJob(request);
    }

    if (pathname === "/v1/jobs/run") {
      if (method !== "POST") return failure("Use POST /v1/jobs/run.", 405, { allow: "POST" });
      return handleRunJobItem(request);
    }

    const match = /^\/v1\/jobs\/([^/]+)(\/retry|\/report\.json)?$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const suffix = match[2] ?? "";
      if (suffix === "/retry") {
        if (method !== "POST") return failure("Use POST /v1/jobs/:id/retry.", 405, { allow: "POST" });
        return handleRetryJob(id);
      }
      if (suffix === "/report.json") {
        if (method !== "GET" && method !== "HEAD") {
          return failure("Use GET /v1/jobs/:id/report.json.", 405);
        }
        return handleJobReport(id);
      }
      if (method !== "GET" && method !== "HEAD") {
        return failure("Use GET /v1/jobs/:id.", 405);
      }
      return handleGetJob(id);
    }

    return failure(`Unknown path ${pathname}.`, 404);
  },
};
