/**
 * The single Vercel function: routing, bearer-token auth for /v1/analyze and
 * the durable batch endpoints under /v1/jobs. All logic lives in `_lib/` (the
 * leading underscore keeps Vercel from deploying those files as functions).
 */
import { timingSafeEqual } from "node:crypto";
import { API_VERSION } from "./_lib/env.js";
import { ConfigError, FatalApiError, InvalidUrlError, ListError, SiteScoutError } from "./_lib/errors.js";
import {
  consumeQuota,
  createJob,
  dispatchJob,
  isValidJobId,
  loadJobConfig,
  readJob,
  readJobEntries,
  readMeta,
  verifyCallback,
  type JobView,
} from "./_lib/jobs.js";
import {
  MAX_BULK_KEYS,
  MAX_DETAIL_KEYS,
  MAX_REPORT_IMPORTS,
  getListStore,
  isValidListId,
  listSettings,
  publicHistory,
  publicReport,
  publicSummary,
  validateKeyList,
  validateStatus,
  type ListMeta,
  type ListSettings,
  type ManagementMode,
} from "./_lib/lists.js";
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

async function health(): Promise<Response> {
  try {
    const runtime = getRuntime();
    let quota: Record<string, unknown> | null = null;
    try {
      const snapshot = await runtime.quota.report(runtime.settings.geminiKeys);
      quota = {
        window_s: 60,
        tokens_per_minute: runtime.settings.geminiTokensPerMinute,
        requests_per_minute: runtime.settings.geminiRequestsPerMinute,
        global: {
          tokens_used: snapshot.global.tokensUsed,
          requests_used: snapshot.global.requestsUsed,
          cooldown_s: Math.max(0, Math.round((snapshot.global.cooldownUntil - Date.now()) / 1000)),
        },
        // Only hashes: never the key itself.
        keys: snapshot.keys.map((entry) => ({
          hash: entry.hash,
          tokens_used: entry.tokensUsed,
          requests_used: entry.requestsUsed,
          cooldown_s: Math.round(entry.cooldownMs / 1000),
        })),
      };
    } catch (err) {
      console.warn(`health: quota snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    let lists: Record<string, unknown> | null = null;
    try {
      const settings = listSettings();
      const store = getListStore();
      const all = await store.readLists();
      const counts = await Promise.all(all.map((list) => store.siteCount(list.id)));
      lists = {
        management: settings.management,
        count: all.length,
        sites: counts.reduce((sum, count) => sum + count, 0),
        max_lists: settings.maxLists,
        max_sites_per_list: settings.maxSitesPerList,
      };
    } catch (err) {
      console.warn(`health: lists snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      quota,
      lists,
      limits: {
        max_urls: runtime.settings.maxUrls,
        concurrency: runtime.settings.concurrency,
        max_key_attempts: runtime.settings.maxKeyAttempts,
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
  return {
    settings: runtime.settings,
    firecrawl: runtime.firecrawl,
    gemini: runtime.gemini,
    quota: runtime.quota,
  };
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
    // Remember the batch for the "Add batch" picker on the lists page. This is
    // only metadata: the batch itself is never added to a list automatically.
    try {
      await getListStore().registerJob({
        id: meta.id,
        createdAt: meta.createdAt,
        total: meta.total,
        firstUrl: meta.urls[0] ?? "",
      });
    } catch (err) {
      console.warn(
        `could not register the batch for the list picker: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
      if (view.waiting > 0) {
        return failure(
          `This batch is waiting for Gemini quota; ${view.waiting} website(s) retry automatically. ` +
            "There is nothing to restart.",
          409,
          { waiting: view.waiting, next_retry_at: view.next_retry_at },
        );
      }
      return failure(
        view.done < view.total
          ? "This batch is still running. Wait until it stops making progress, then try again."
          : "This batch cannot be restarted any more. Start a new batch instead.",
        409,
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

/* ------------------------------------------------------- /v1/lists (permanent) */

interface ListAccess {
  owner: boolean;
  mode: ManagementMode;
}

interface ListContext {
  store: ReturnType<typeof getListStore>;
  settings: ListSettings;
  access: ListAccess;
}

/**
 * Reading is public; changing needs the key. When no key is configured the
 * project is a one-person tool and the link itself is the secret.
 */
function listAccess(request: Request, settings: ListSettings): ListAccess {
  if (settings.management === "open") return { owner: true, mode: "open" };
  if (settings.management === "disabled") return { owner: false, mode: "disabled" };
  const provided = (request.headers.get("x-sitescout-list-key") ?? "").trim();
  if (!provided) return { owner: false, mode: "key" };
  if (!tokenMatches(provided, settings.key)) {
    throw new ListError("That management key is not right.", 401, { code: "bad_key" });
  }
  return { owner: true, mode: "key" };
}

function listFailure(err: unknown): Response {
  if (err instanceof ListError) return failure(err.message, err.status, err.extra);
  if (err instanceof ConfigError) return failure(err.message, 503);
  return serverError(err);
}

function listContext(request: Request): ListContext | Response {
  try {
    const settings = listSettings();
    return { store: getListStore(), settings, access: listAccess(request, settings) };
  } catch (err) {
    return listFailure(err);
  }
}

function requireOwner(ctx: ListContext): Response | null {
  if (ctx.access.owner) return null;
  if (ctx.settings.management === "disabled") {
    return failure(
      "List management is switched off: SITESCOUT_LIST_KEY is shorter than 24 characters.",
      503,
    );
  }
  return failure("This action needs the management key. Unlock the list first.", 401, {
    code: "needs_key",
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ListError("Body is not valid JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ListError("Body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

function listView(meta: ListMeta, siteCount: number): Record<string, unknown> {
  return { ...meta, siteCount };
}

async function handleListsIndex(request: Request): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    const jobId = (new URL(request.url).searchParams.get("jobId") ?? "").trim();
    const lists = await ctx.store.readLists();
    const visible = ctx.access.owner
      ? lists
      : lists.filter((list) => list.visibility === "public");
    const counts = await Promise.all(visible.map((list) => ctx.store.siteCount(list.id)));

    let imported: Map<string, number> | null = null;
    if (jobId && ctx.access.owner && isValidJobId(jobId)) {
      const records = await Promise.all(visible.map((list) => ctx.store.readBatches(list.id)));
      imported = new Map<string, number>();
      visible.forEach((list, index) => {
        const record = records[index]?.find((entry) => entry.id === jobId);
        imported!.set(list.id, record?.imported.length ?? 0);
      });
    }

    return json({
      ok: true,
      owner: ctx.access.owner,
      management: ctx.access.mode,
      lists: visible.map((list, index) => ({
        ...listView(list, counts[index] ?? 0),
        ...(imported ? { imported: imported.get(list.id) ?? 0 } : {}),
      })),
    });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleCreateList(request: Request): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    const body = await jsonBody(request);
    const meta = await ctx.store.createList({
      name: body.name,
      description: body.description,
      visibility: body.visibility,
    });
    return json(
      { ok: true, owner: true, management: ctx.access.mode, list: listView(meta, 0) },
      201,
    );
  } catch (err) {
    return listFailure(err);
  }
}

/** Loads a list and enforces private visibility for non-owners. */
async function visibleList(ctx: ListContext, listId: string): Promise<ListMeta> {
  const meta = await ctx.store.readList(listId);
  if (!meta) throw new ListError("That list does not exist.", 404);
  if (meta.visibility === "private" && !ctx.access.owner) {
    // Same answer as a missing list, so private lists are not discoverable.
    throw new ListError("That list does not exist.", 404);
  }
  return meta;
}

async function handleReadList(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    const meta = await visibleList(ctx, listId);
    const summaries = await ctx.store.readSummaries(listId);
    const batches = ctx.access.owner ? await ctx.store.readBatches(listId) : null;
    return json({
      ok: true,
      owner: ctx.access.owner,
      management: ctx.access.mode,
      list: listView(meta, summaries.length),
      sites: ctx.access.owner ? summaries : summaries.map(publicSummary),
      ...(batches ? { batches } : {}),
    });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleUpdateList(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    const body = await jsonBody(request);
    const meta = await ctx.store.updateList(listId, {
      name: body.name,
      description: body.description,
      visibility: body.visibility,
    });
    return json({
      ok: true,
      owner: true,
      management: ctx.access.mode,
      list: listView(meta, await ctx.store.siteCount(listId)),
    });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleDeleteList(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    await ctx.store.deleteList(listId);
    return json({ ok: true, owner: true, deleted: listId });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleReadSite(
  request: Request,
  listId: string,
  siteKey: string,
): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    await visibleList(ctx, listId);
    const detail = await ctx.store.readSite(listId, siteKey);
    if (!detail) throw new ListError("That site is not in this list.", 404);
    return json({
      ok: true,
      owner: ctx.access.owner,
      management: ctx.access.mode,
      site: ctx.access.owner
        ? detail
        : {
            summary: publicSummary(detail.summary),
            report: publicReport(detail.report),
            history: publicHistory(detail.history),
          },
    });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleUpdateSite(
  request: Request,
  listId: string,
  siteKey: string,
): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    const body = await jsonBody(request);
    const summary = await ctx.store.updateSite(listId, siteKey, {
      status: body.status,
      notes: body.notes,
      tags: body.tags,
    });
    return json({ ok: true, owner: true, site: summary });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleDeleteSite(
  request: Request,
  listId: string,
  siteKey: string,
): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    await ctx.store.removeSite(listId, siteKey);
    return json({ ok: true, owner: true, removed: siteKey });
  } catch (err) {
    return listFailure(err);
  }
}

/** Full details in chunks: used by the JSON export. */
async function handleReadSites(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    await visibleList(ctx, listId);
    const body = await jsonBody(request);
    const keys = validateKeyList(body.keys, MAX_DETAIL_KEYS);
    return json({ ok: true, sites: await ctx.store.details(listId, keys) });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleListBulk(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    const body = await jsonBody(request);
    const keys = validateKeyList(body.keys, MAX_BULK_KEYS);
    if (body.action === "remove") {
      const removed = await ctx.store.removeSites(listId, keys);
      return json({ ok: true, removed, skipped: keys.length - removed });
    }
    if (body.action === "status") {
      const status = validateStatus(body.status);
      const changed = await ctx.store.setStatusMany(listId, keys, status);
      return json({ ok: true, changed, skipped: keys.length - changed });
    }
    throw new ListError('Action must be "status" or "remove".', 400);
  } catch (err) {
    return listFailure(err);
  }
}

async function handleClearList(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    const removed = await ctx.store.clearList(listId);
    return json({ ok: true, removed });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleRestoreList(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("write", clientIp(request));
    await visibleList(ctx, listId);
    const body = await jsonBody(request);
    const sites = Array.isArray(body.sites) ? body.sites : [];
    const batches = Array.isArray(body.batches) ? body.batches : [];
    if (sites.length === 0) throw new ListError("Nothing to restore in this chunk.", 400);
    const result = await ctx.store.restore(listId, sites, batches);
    return json({ ok: true, ...result });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleListCsv(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    const meta = await visibleList(ctx, listId);
    const csv = await ctx.store.csv(listId);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="sitescout-${meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "list"}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return listFailure(err);
  }
}

async function handleListBatches(request: Request, listId: string): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("read", clientIp(request));
    await visibleList(ctx, listId);
    const [jobs, records] = await Promise.all([
      ctx.store.readJobs(),
      ctx.store.readBatches(listId),
    ]);
    const byId = new Map(records.map((record) => [record.id, record]));
    return json({
      ok: true,
      jobs: jobs.map((job) => ({
        ...job,
        imported: byId.get(job.id)?.imported.length ?? 0,
      })),
    });
  } catch (err) {
    return listFailure(err);
  }
}

/** Adds one finished batch to one or more lists. */
async function handleImportJob(request: Request): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("import", clientIp(request));
    const body = await jsonBody(request);
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!isValidJobId(jobId)) throw new ListError("That batch link is not valid.", 400);
    const listIds = Array.isArray(body.listIds)
      ? [...new Set(body.listIds.filter((id): id is string => typeof id === "string" && id !== ""))]
      : [];
    if (listIds.length === 0) throw new ListError("Choose at least one list.", 400);
    if (listIds.length > ctx.settings.maxLists) {
      throw new ListError(`At most ${ctx.settings.maxLists} lists at once.`, 400);
    }

    const meta = await readMeta(jobId);
    if (!meta) throw new ListError("This batch has expired or does not exist.", 404);
    const entries = await readJobEntries(jobId);
    if (entries.length === 0) {
      throw new ListError("This batch has no finished reports yet.", 409);
    }

    const results: Record<string, unknown>[] = [];
    for (const listId of listIds) {
      try {
        if (!isValidListId(listId)) throw new ListError("That list does not exist.", 404);
        const { counts } = await ctx.store.importJob(listId, jobId, entries, {
          createdAt: meta.createdAt,
          total: meta.total,
          firstUrl: meta.urls[0] ?? "",
        });
        results.push({ listId, ok: true, ...counts });
      } catch (err) {
        if (!(err instanceof ListError)) throw err;
        results.push({ listId, ok: false, error: err.message });
      }
    }

    return json({
      ok: true,
      batch: { total: meta.total, ready: entries.length },
      results,
    });
  } catch (err) {
    return listFailure(err);
  }
}

/** Imports a CLI `report.json` (a plain array of reports) into lists. */
async function handleImportReports(request: Request): Promise<Response> {
  const ctx = listContext(request);
  if (ctx instanceof Response) return ctx;
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    await ctx.store.checkRate("import", clientIp(request));
    const body = await jsonBody(request);
    const reports = Array.isArray(body.reports) ? body.reports : null;
    if (!reports || reports.length === 0) {
      throw new ListError("Send the reports from report.json.", 400);
    }
    if (reports.length > MAX_REPORT_IMPORTS) {
      throw new ListError(`At most ${MAX_REPORT_IMPORTS} reports per request.`, 400);
    }
    const listIds = Array.isArray(body.listIds)
      ? [...new Set(body.listIds.filter((id): id is string => typeof id === "string" && id !== ""))]
      : [];
    if (listIds.length === 0) throw new ListError("Choose at least one list.", 400);

    const results: Record<string, unknown>[] = [];
    for (const listId of listIds) {
      try {
        if (!isValidListId(listId)) throw new ListError("That list does not exist.", 404);
        const { counts } = await ctx.store.importReports(listId, reports);
        results.push({ listId, ok: true, ...counts });
      } catch (err) {
        if (!(err instanceof ListError)) throw err;
        results.push({ listId, ok: false, error: err.message });
      }
    }
    return json({ ok: true, reports: reports.length, results });
  } catch (err) {
    return listFailure(err);
  }
}

/* ------------------------------------------------------------------ routing */

interface Route {
  pathname: string;
  jobId: string;
  listId: string;
  siteKey: string;
}

function routeParam(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeOf(url: URL): Route {
  const forced = url.searchParams.get("__route");
  const jobId = (url.searchParams.get("jobId") ?? "").trim();
  const listId = routeParam(url.searchParams.get("listId"));
  const siteKey = routeParam(url.searchParams.get("siteKey"));
  const base = { jobId, listId, siteKey };
  switch (forced) {
    case "health":
      return { pathname: "/health", ...base };
    case "analyze":
      return { pathname: "/v1/analyze", ...base };
    case "api":
      return { pathname: "/v1", ...base };
    case "jobs":
      return { pathname: "/v1/jobs", ...base };
    case "job_run":
      return { pathname: "/v1/jobs/run", ...base };
    case "job":
      return { pathname: `/v1/jobs/${jobId}`, ...base };
    case "job_retry":
      return { pathname: `/v1/jobs/${jobId}/retry`, ...base };
    case "job_report":
      return { pathname: `/v1/jobs/${jobId}/report.json`, ...base };
    case "lists":
      return { pathname: "/v1/lists", ...base };
    case "list":
      return { pathname: `/v1/lists/${listId}`, ...base };
    case "lists_import":
      return { pathname: "/v1/lists/import", ...base };
    case "lists_reports":
      return { pathname: "/v1/lists/reports", ...base };
    case "list_batches":
      return { pathname: `/v1/lists/${listId}/batches`, ...base };
    case "list_sites":
      return { pathname: `/v1/lists/${listId}/sites`, ...base };
    case "list_site":
      return { pathname: `/v1/lists/${listId}/sites/${siteKey}`, ...base };
    case "list_bulk":
      return { pathname: `/v1/lists/${listId}/bulk`, ...base };
    case "list_clear":
      return { pathname: `/v1/lists/${listId}/clear`, ...base };
    case "list_restore":
      return { pathname: `/v1/lists/${listId}/restore`, ...base };
    case "list_csv":
      return { pathname: `/v1/lists/${listId}/export.csv`, ...base };
    default:
      return { pathname: url.pathname, ...base };
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
          "GET /v1/lists": "The permanent lists and their site counts.",
          "POST /v1/lists": "Create a list.",
          "POST /v1/lists/import": "Copy a finished batch into one or more lists.",
          "POST /v1/lists/reports": "Import reports from a CLI report.json.",
          "GET /v1/lists/:id": "One list with a summary row per site.",
          "GET /v1/lists/:id/sites/:key": "One site: summary, report, run history.",
          "PATCH /v1/lists/:id/sites/:key": "Set outreach status, notes and tags.",
          "GET /v1/lists/:id/export.csv": "Download the list as CSV.",
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

    /* ------------------------------------------------------------- lists */

    if (pathname === "/v1/lists") {
      if (method === "GET" || method === "HEAD") return handleListsIndex(request);
      if (method === "POST") return handleCreateList(request);
      return failure("Use GET or POST /v1/lists.", 405, { allow: "GET, POST" });
    }

    if (pathname === "/v1/lists/import") {
      if (method !== "POST") return failure("Use POST /v1/lists/import.", 405, { allow: "POST" });
      return handleImportJob(request);
    }

    if (pathname === "/v1/lists/reports") {
      if (method !== "POST") return failure("Use POST /v1/lists/reports.", 405, { allow: "POST" });
      return handleImportReports(request);
    }

    const listSub = /^\/v1\/lists\/([^/]+)\/(sites|batches|bulk|clear|restore|export\.csv)(?:\/(.+))?$/.exec(
      pathname,
    );
    if (listSub) {
      const listId = decodeURIComponent(listSub[1]!);
      const kind = listSub[2]!;
      const extra = listSub[3] ? decodeURIComponent(listSub[3]) : "";
      if (!isValidListId(listId)) return failure("Unknown list.", 404);

      if (kind === "sites") {
        if (extra) {
          if (method === "GET" || method === "HEAD") return handleReadSite(request, listId, extra);
          if (method === "PATCH") return handleUpdateSite(request, listId, extra);
          if (method === "DELETE") return handleDeleteSite(request, listId, extra);
          return failure("Use GET, PATCH or DELETE on a site.", 405, {
            allow: "GET, PATCH, DELETE",
          });
        }
        if (method !== "POST") {
          return failure("Use POST /v1/lists/:id/sites to read several at once.", 405, {
            allow: "POST",
          });
        }
        return handleReadSites(request, listId);
      }

      if (kind === "batches") {
        if (method !== "GET" && method !== "HEAD") {
          return failure("Use GET /v1/lists/:id/batches.", 405);
        }
        return handleListBatches(request, listId);
      }

      if (kind === "export.csv") {
        if (method !== "GET" && method !== "HEAD") {
          return failure("Use GET /v1/lists/:id/export.csv.", 405);
        }
        return handleListCsv(request, listId);
      }

      if (method !== "POST") {
        return failure(`Use POST for /v1/lists/:id/${kind}.`, 405, { allow: "POST" });
      }
      if (kind === "bulk") return handleListBulk(request, listId);
      if (kind === "clear") return handleClearList(request, listId);
      if (kind === "restore") return handleRestoreList(request, listId);
    }

    const listOne = /^\/v1\/lists\/([^/]+)$/.exec(pathname);
    if (listOne) {
      const listId = decodeURIComponent(listOne[1]!);
      if (!isValidListId(listId)) return failure("Unknown list.", 404);
      if (method === "GET" || method === "HEAD") return handleReadList(request, listId);
      if (method === "PATCH") return handleUpdateList(request, listId);
      if (method === "DELETE") return handleDeleteList(request, listId);
      return failure("Use GET, PATCH or DELETE on a list.", 405, {
        allow: "GET, PATCH, DELETE",
      });
    }

    return failure(`Unknown path ${pathname}.`, 404);
  },
};
