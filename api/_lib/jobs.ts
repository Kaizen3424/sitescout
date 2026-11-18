/**
 * Durable analysis jobs.
 *
 * A job is 1-50 URLs kept in Upstash Redis. Every URL is queued as its own
 * QStash message, so one slow or broken page never blocks the rest and the
 * batch keeps going after the browser is closed.
 *
 * Redis layout (all keys expire together):
 *   ss:job:<id>      hash   createdAt, urls, total, fresh, status, dispatches, ...
 *   ss:job:<id>:r    hash   "<index>" -> JSON report
 */
import { createHash, randomBytes } from "node:crypto";
import { Client, Receiver } from "@upstash/qstash";
import { ConfigError } from "./errors.js";
import { getRedis, redisCredentials, toRecord } from "./redis.js";
import type { Report } from "./types.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobConfig {
  maxUrls: number;
  ttlSeconds: number;
  /** Public origin QStash calls back to, without a trailing slash. */
  origin: string;
  concurrency: number;
  jobsPerHourPerIp: number;
  dailyUrlBudget: number;
  /** Development only: analyse in the request instead of via QStash. */
  inline: boolean;
  qstash: { baseUrl: string; token: string };
  signing: { current: string; next: string };
}

export interface JobMeta {
  id: string;
  createdAt: string;
  urls: string[];
  total: number;
  fresh: boolean;
  status: JobStatus;
  dispatches: number;
  /** When the last report arrived; used to spot a job that really is stuck. */
  lastProgressAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface JobView extends JobMeta {
  done: number;
  results: Report[];
  elapsed_s: number;
  /** URLs waiting for Gemini quota; they have their own delayed message. */
  waiting: number;
  /** When the soonest waiting URL tries again, as an ISO timestamp. */
  next_retry_at: string | null;
  /** True only when the job looks stuck; never while it is running normally. */
  canRetry: boolean;
  /** How long the reports stay readable, in days. */
  ttlDays: number;
}

const MAX_DISPATCHES = 5;
const JOB_ID = /^[A-Za-z0-9_-]{20,32}$/;
/** A batch that made no progress for this long may be re-dispatched by hand. */
const STUCK_AFTER_MS = 15 * 60_000;
/** A quota retry that is still missing this long after its due time was lost. */
const WAITING_STALE_MS = 30 * 60_000;
/** A claim lives longer than the longest possible run (Vercel kills at 300 s). */
const CLAIM_TTL_SECONDS = 420;

/* ------------------------------------------------------------------ config */

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * The absolute URL QStash must call. Production prefers the stable project
 * domain; previews must use their own deployment URL or the callback would hit
 * production instead.
 */
function publicOrigin(): string {
  const explicit = env("SITESCOUT_PUBLIC_ORIGIN").replace(/\/+$/, "");
  if (explicit) return explicit;
  const production = env("VERCEL_PROJECT_PRODUCTION_URL");
  const current = env("VERCEL_URL");
  const host =
    env("VERCEL_ENV") === "production" ? production || current : current || production;
  if (!host) {
    throw new ConfigError(
      "Cannot work out the public URL for background callbacks. Set " +
        "SITESCOUT_PUBLIC_ORIGIN (for example https://sitescout-dusky.vercel.app).",
    );
  }
  return `https://${host.replace(/\/+$/, "")}`;
}

let cached: JobConfig | null = null;

export function loadJobConfig(): JobConfig {
  if (cached) return cached;
  const missing: string[] = [];
  const token = env("QSTASH_TOKEN");
  const baseUrl = env("QSTASH_URL") || "https://qstash.upstash.io";
  const current = env("QSTASH_CURRENT_SIGNING_KEY");
  const next = env("QSTASH_NEXT_SIGNING_KEY");
  if (!token) missing.push("QSTASH_TOKEN");
  if (!current) missing.push("QSTASH_CURRENT_SIGNING_KEY");
  if (!next) missing.push("QSTASH_NEXT_SIGNING_KEY");
  // Fail early with the same style of message as the rest of the API.
  redisCredentials();
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing environment variables for background jobs: ${missing.join(", ")}. ` +
        "Locally put them in .env.local; in production add them in the Vercel dashboard " +
        "under Settings > Environment Variables.",
    );
  }

  cached = {
    maxUrls: clamp(envInt("SITESCOUT_MAX_JOB_URLS", 50), 1, 50),
    ttlSeconds: clamp(envInt("SITESCOUT_JOB_TTL_DAYS", 30), 1, 365) * 86_400,
    origin: publicOrigin(),
    concurrency: clamp(envInt("SITESCOUT_JOB_CONCURRENCY", 5), 1, 10),
    jobsPerHourPerIp: clamp(envInt("SITESCOUT_JOBS_PER_HOUR", 8), 1, 100),
    dailyUrlBudget: clamp(envInt("SITESCOUT_DAILY_URL_BUDGET", 500), 1, 5000),
    inline: env("SITESCOUT_JOBS_INLINE") === "1",
    qstash: { baseUrl, token },
    signing: { current, next },
  };
  return cached;
}

export function resetJobConfig(): void {
  cached = null;
}

/* ------------------------------------------------------------------- keys */

const metaKey = (id: string): string => `ss:job:${id}`;
const resultsKey = (id: string): string => `ss:job:${id}:r`;
/** `<index>` -> number of quota deferrals. */
const attemptsKey = (id: string): string => `ss:job:${id}:a`;
/** `<index>` -> timestamp (ms) when the delayed retry runs. */
const waitingKey = (id: string): string => `ss:job:${id}:w`;
/** One short-lived key per URL that a worker is busy with. */
const claimKey = (id: string, index: number): string => `ss:job:${id}:claim:${index}`;

export function isValidJobId(id: string): boolean {
  return JOB_ID.test(id);
}

function newJobId(): string {
  // 16 random bytes: 22 URL-safe characters, not guessable from another id.
  return randomBytes(16).toString("base64url");
}

/* --------------------------------------------------------------- job meta */

function asMeta(id: string, raw: Record<string, string>): JobMeta {
  let urls: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.urls ?? "[]");
    if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === "string");
  } catch {
    urls = [];
  }
  return {
    id,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    urls,
    total: Number(raw.total ?? urls.length),
    fresh: raw.fresh === "1",
    status: (raw.status as JobStatus) ?? "queued",
    dispatches: Number(raw.dispatches ?? 0),
    lastProgressAt: raw.lastProgressAt ?? raw.createdAt ?? null,
    completedAt: raw.completedAt ?? null,
    error: raw.error ?? null,
  };
}

export async function readMeta(id: string): Promise<JobMeta | null> {
  const raw = toRecord(await getRedis().hgetall(metaKey(id)));
  if (Object.keys(raw).length === 0) return null;
  return asMeta(id, raw);
}

export async function createJob(
  urls: string[],
  fresh: boolean,
  config: JobConfig,
): Promise<JobMeta> {
  const redis = getRedis();
  const id = newJobId();
  const createdAt = new Date().toISOString();
  await redis.hset(metaKey(id), {
    createdAt,
    urls: JSON.stringify(urls),
    total: urls.length,
    fresh: fresh ? "1" : "0",
    status: "queued",
    dispatches: 0,
    lastProgressAt: createdAt,
  });
  await redis.expire(metaKey(id), config.ttlSeconds);
  await redis.expire(resultsKey(id), config.ttlSeconds);
  return {
    id,
    createdAt,
    urls,
    total: urls.length,
    fresh,
    status: "queued",
    dispatches: 0,
    lastProgressAt: createdAt,
    completedAt: null,
    error: null,
  };
}

/* ---------------------------------------------------------------- reports */

export async function hasReport(id: string, index: number): Promise<boolean> {
  return (await getRedis().hexists(resultsKey(id), String(index))) === 1;
}

/** Number of URLs that already have a stored report. */
export async function resultCount(id: string): Promise<number> {
  return getRedis().hlen(resultsKey(id));
}

/** Stores one finished report. Safe to call twice: the field simply wins. */
export async function saveReport(
  id: string,
  index: number,
  report: Report,
  config: JobConfig,
): Promise<{ done: number; total: number; complete: boolean }> {
  const redis = getRedis();
  await redis.hset(resultsKey(id), { [String(index)]: JSON.stringify(report) });
  await redis.expire(resultsKey(id), config.ttlSeconds);
  await redis.expire(metaKey(id), config.ttlSeconds);
  await redis.hset(metaKey(id), { lastProgressAt: new Date().toISOString() });
  // A finished URL is no longer waiting, and its attempt history is over.
  await Promise.all([clearWaiting(id, index), clearAttempts(id, index)]);
  const done = await redis.hlen(resultsKey(id));
  const total = Number((await redis.hget(metaKey(id), "total")) ?? done);
  const complete = total > 0 && done >= total;
  if (complete) {
    await redis.hset(metaKey(id), {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }
  return { done, total, complete };
}

/* ------------------------------------------------- claims, attempts, waiting */

/**
 * Takes exclusive ownership of one URL for this invocations.
 *
 * QStash guarantees at-least-once delivery, so the same item can arrive twice
 * (a slow run, a retry). Without a claim both would call Gemini and pay twice.
 */
export async function claimItem(id: string, index: number): Promise<boolean> {
  const result = await getRedis().set(claimKey(id, index), String(Date.now()), {
    nx: true,
    px: CLAIM_TTL_SECONDS * 1000,
  });
  return result === "OK";
}

export async function releaseClaim(id: string, index: number): Promise<void> {
  await getRedis().del(claimKey(id, index));
}

/** Counts one more quota deferral and returns the new total. */
export async function bumpAttempt(id: string, index: number, ttlSeconds: number): Promise<number> {
  const redis = getRedis();
  const value = await redis.hincrby(attemptsKey(id), String(index), 1);
  await redis.expire(attemptsKey(id), ttlSeconds);
  return Number(value);
}

export async function clearAttempts(id: string, index: number): Promise<void> {
  await getRedis().hdel(attemptsKey(id), String(index));
}

/** Marks a URL as waiting for quota until `dueAt` (a Date.now() timestamp). */
export async function markWaiting(
  id: string,
  index: number,
  dueAt: number,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedis();
  await redis.hset(waitingKey(id), { [String(index)]: String(Math.round(dueAt)) });
  await redis.expire(waitingKey(id), ttlSeconds);
}

export async function clearWaiting(id: string, index: number): Promise<void> {
  await getRedis().hdel(waitingKey(id), String(index));
}

/**
 * `<index>` -> due timestamp in ms, for every URL waiting on quota.
 *
 * An entry whose retry was due long ago is ignored: the delayed message was
 * lost (a purged queue, a failed publish). Without this the batch would look
 * like it is waiting forever and the manual retry would never be offered.
 */
export async function readWaiting(id: string): Promise<Record<string, number>> {
  const raw = toRecord(await getRedis().hgetall(waitingKey(id)));
  const cutoff = Date.now() - WAITING_STALE_MS;
  const out: Record<string, number> = {};
  for (const [index, value] of Object.entries(raw)) {
    const due = Number(value);
    if (!Number.isFinite(due)) continue;
    if (due < cutoff) continue;
    out[index] = due;
  }
  return out;
}

export interface JobEntry {
  index: number;
  report: Report;
}

/**
 * The stored reports together with the position they were queued at.
 *
 * `readJob()` only needs the reports, but a permanent list must know which
 * batch index a report came from to keep imports idempotent.
 */
export async function readJobEntries(id: string): Promise<JobEntry[]> {
  const raw = toRecord(await getRedis().hgetall(resultsKey(id)));
  const entries: JobEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    try {
      entries.push({ index, report: JSON.parse(value) as Report });
    } catch {
      // A corrupt field is ignored; the next delivery rewrites it.
    }
  }
  return entries.sort((a, b) => a.index - b.index);
}

export async function readJob(id: string, config: JobConfig): Promise<JobView | null> {
  const redis = getRedis();
  const meta = await readMeta(id);
  if (!meta) return null;

  const entries = await readJobEntries(id);
  const results = entries.map((entry) => entry.report);

  const done = entries.length;
  const waitingMap = await readWaiting(id);
  // A URL that already has a report cannot be waiting any more.
  const doneIndexes = new Set(entries.map((entry) => entry.index));
  const waitingIndexes = Object.keys(waitingMap).filter(
    (index) => !doneIndexes.has(Number(index)),
  );
  const dueTimes = waitingIndexes
    .map((index) => waitingMap[index]!)
    .filter((due) => Number.isFinite(due))
    .sort((a, b) => a - b);

  let status = meta.status;
  if (meta.total > 0 && done >= meta.total) status = "completed";
  else if (status !== "failed") status = meta.dispatches > 0 ? "running" : "queued";

  const started = Date.parse(meta.createdAt);
  const ended = meta.completedAt ? Date.parse(meta.completedAt) : Date.now();
  const elapsed_s = Number.isFinite(started)
    ? Math.max(0, Math.round(((Number.isFinite(ended) ? ended : Date.now()) - started) / 100) / 10)
    : 0;

  // Only offer a manual retry when the batch is genuinely stuck. While it is
  // running (or waiting for quota) a retry would simply double the traffic.
  const lastProgress = Date.parse(meta.lastProgressAt ?? meta.createdAt);
  const idleMs = Number.isFinite(lastProgress) ? Date.now() - lastProgress : 0;
  const stuck = idleMs > STUCK_AFTER_MS && waitingIndexes.length === 0;

  return {
    ...meta,
    status,
    done,
    results,
    elapsed_s,
    waiting: waitingIndexes.length,
    next_retry_at: dueTimes.length > 0 ? new Date(dueTimes[0]!).toISOString() : null,
    canRetry:
      status !== "completed" &&
      done < meta.total &&
      stuck &&
      meta.dispatches < MAX_DISPATCHES,
    ttlDays: Math.round(config.ttlSeconds / 86_400),
  };
}

/* ----------------------------------------------------------------- quota */

function hashIp(ip: string): string {
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 16);
}

export interface QuotaVerdict {
  ok: boolean;
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * A public form that spends Firecrawl and Gemini credits needs a ceiling.
 * Two counters: batches per address per hour, and URLs per day for everyone.
 */
export async function consumeQuota(
  ip: string,
  urlCount: number,
  config: JobConfig,
): Promise<QuotaVerdict> {
  const redis = getRedis();
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000);
  const ipKey = `ss:rate:job:${hashIp(ip)}:${hour}`;
  const dayKey = `ss:rate:urls:${new Date(now).toISOString().slice(0, 10)}`;

  const batches = await redis.incr(ipKey);
  if (batches === 1) await redis.expire(ipKey, 3_600);
  if (batches > config.jobsPerHourPerIp) {
    return {
      ok: false,
      message:
        `Too many batches from this connection (limit ${config.jobsPerHourPerIp} per hour). ` +
        "Try again later.",
      retryAfterSeconds: 600,
    };
  }

  const urls = await redis.incrby(dayKey, urlCount);
  if (urls === urlCount) await redis.expire(dayKey, 2 * 86_400);
  if (urls > config.dailyUrlBudget) {
    await redis.decrby(dayKey, urlCount);
    return {
      ok: false,
      message:
        `The daily budget of ${config.dailyUrlBudget} websites is used up. ` +
        "It resets at midnight UTC.",
      retryAfterSeconds: 3_600,
    };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- QStash */

let qstash: Client | null = null;

function qstashClient(config: JobConfig): Client {
  qstash ??= new Client({
    baseUrl: config.qstash.baseUrl,
    token: config.qstash.token,
    enableTelemetry: false,
  });
  return qstash;
}

export function resetQstash(): void {
  qstash = null;
}

/**
 * Queues one message per URL that has no report yet. Returns how many were
 * sent. The flow-control key keeps the whole deployment at a fixed parallelism.
 */
export async function dispatchJob(id: string, config: JobConfig): Promise<number> {
  const redis = getRedis();
  const meta = await readMeta(id);
  if (!meta) return 0;
  if (meta.dispatches >= MAX_DISPATCHES) return 0;

  const stored = new Set(await redis.hkeys(resultsKey(id)));
  const waiting = await readWaiting(id);
  const pending: number[] = [];
  for (let index = 0; index < meta.total; index += 1) {
    if (stored.has(String(index))) continue;
    // A URL waiting for quota already has its own delayed message. Sending a
    // second one now would ignore the wait and burn quota again.
    if (waiting[String(index)] !== undefined) continue;
    pending.push(index);
  }

  if (pending.length > 0) {
    const destination = `${config.origin}/v1/jobs/run`;
    const messages = pending.map((index) => ({
      url: destination,
      body: { jobId: id, index },
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      retries: 2,
      timeout: "280s" as const,
      flowControl: { key: "sitescout-jobs", parallelism: config.concurrency },
    }));
    // The batch endpoint accepts up to 100 messages; jobs are capped at 50.
    await qstashClient(config).batchJSON(messages);
  }

  await redis.hset(metaKey(id), {
    dispatches: meta.dispatches + 1,
    ...(pending.length > 0 ? { status: "running" } : {}),
  });
  await redis.expire(metaKey(id), config.ttlSeconds);
  return pending.length;
}

/**
 * The deduplication id of a retry message.
 *
 * QStash remembers an id for 90 days, so the attempt number must be part of it:
 * otherwise the second retry of the same URL would be swallowed. QStash refuses
 * ids containing a colon, hence the hyphens.
 */
export function requeueDedupeId(id: string, index: number, attempt: number): string {
  return `${id}-${index}-${attempt}`;
}

/**
 * Puts one URL back in the queue after a delay.
 *
 * Called when Gemini reports a temporary quota limit. The message is a normal
 * job delivery, so the browser can stay closed; the deduplication id includes
 * the attempt number because QStash remembers ids for 90 days and would
 * otherwise ignore the second and later retries. QStash refuses ids containing
 * a colon, so the parts are joined with hyphens.
 */
export async function requeueItem(
  id: string,
  index: number,
  delaySeconds: number,
  attempt: number,
  config: JobConfig,
): Promise<void> {
  await qstashClient(config).publishJSON({
    url: `${config.origin}/v1/jobs/run`,
    body: { jobId: id, index },
    method: "POST",
    headers: { "content-type": "application/json" },
    retries: 2,
    timeout: "280s",
    flowControl: { key: "sitescout-jobs", parallelism: config.concurrency },
    delay: Math.max(10, Math.round(delaySeconds)),
    deduplicationId: requeueDedupeId(id, index, attempt),
  });
}

/** True only for a genuine, unexpired QStash signature. */
export async function verifyCallback(
  rawBody: string,
  signature: string | null,
  config: JobConfig,
): Promise<boolean> {
  if (!signature) return false;
  const receiver = new Receiver({
    currentSigningKey: config.signing.current,
    nextSigningKey: config.signing.next,
  });
  try {
    await receiver.verify({
      signature,
      body: rawBody,
      // QStash signs the exact destination URL. Building it from the configured
      // origin avoids proxy differences in request.url.
      url: `${config.origin}/v1/jobs/run`,
    });
    return true;
  } catch (err) {
    console.warn(`qstash signature rejected: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
