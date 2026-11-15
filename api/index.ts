/**
 * The single Vercel function: routing, bearer-token auth and a small amount of
 * concurrency. All logic lives in `_lib/` (the leading underscore keeps Vercel
 * from deploying those files as separate functions).
 */
import { timingSafeEqual } from "node:crypto";
import { API_VERSION } from "./_lib/env.js";
import { ConfigError, FatalApiError, SiteScoutError } from "./_lib/errors.js";
import { analyzeUrl, failedReport } from "./_lib/pipeline.js";
import { baseReport, verdictTotals } from "./_lib/report.js";
import { getRuntime } from "./_lib/runtime.js";
import type { Report } from "./_lib/types.js";

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

export default {
  async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    // vercel.json rewrites carry the intended route in `__route`, so routing
    // works whether Vercel exposes the original path or the destination path.
    const forced = url.searchParams.get("__route");
    const pathname =
      forced === "health"
        ? "/health"
        : forced === "analyze"
          ? "/v1/analyze"
          : forced === "root"
            ? "/"
            : url.pathname;

    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return failure("Use GET /health.", 405);
      }
      return health();
    }

    if (pathname === "/") {
      return json({
        name: "SiteScout API",
        version: API_VERSION,
        endpoints: {
          "POST /v1/analyze": "Analyse 1-5 websites. Bearer token required.",
          "GET /health": "Key and configuration status.",
        },
      });
    }

    if (pathname !== "/v1/analyze") {
      return failure(`Unknown path ${pathname}.`, 404);
    }
    if (request.method !== "POST") {
      return failure("Use POST /v1/analyze.", 405, { allow: "POST" });
    }

    let runtime;
    try {
      runtime = getRuntime();
    } catch (err) {
      if (err instanceof ConfigError) return failure(err.message, 500);
      throw err;
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

    const deps = {
      settings: runtime.settings,
      firecrawl: runtime.firecrawl,
      gemini: runtime.gemini,
    };

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
  },
};
