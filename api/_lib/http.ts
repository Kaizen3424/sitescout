/**
 * HTTP helpers: retries with backoff, plus retry-with-key-rotation on top.
 * Mirrors the Python `httpio.py`, using the global fetch available on Vercel.
 */
import { DeadlineError, FatalApiError, NetworkError } from "./errors.js";
import type { KeyPool } from "./keys.js";

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  retries: number;
  backoff: number;
  timeoutMs: number;
  label: string;
  /** Absolute timestamp (Date.now() based) after which no new work is started. */
  deadline?: number;
  /** Aborted when the client disconnects or the request budget runs out. */
  signal?: AbortSignal;
}

export interface KeyedOptions extends RetryOptions {
  pool: KeyPool;
  buildInit: (key: string) => RequestInit;
  maxKeyWaitMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeadlineError("request aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DeadlineError("request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(1, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.min(seconds, 60)) * 1000;
}

function backoffMs(attempt: number, baseSeconds: number): number {
  const base = Math.min(30, baseSeconds * 2 ** (attempt - 1)) * 1000;
  return base + Math.random() * 0.5 * baseSeconds * 1000;
}

/** Timeout for one attempt, never beyond the request deadline. */
function attemptTimeout(opts: RetryOptions): number {
  if (opts.deadline !== undefined) {
    const left = opts.deadline - Date.now();
    if (left <= 0) throw new DeadlineError(`${opts.label}: request time budget exhausted`);
    return Math.max(1, Math.min(opts.timeoutMs, left));
  }
  return Math.max(1, opts.timeoutMs);
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  opts: RetryOptions,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (opts.signal?.aborted) throw new DeadlineError(`${opts.label}: request cancelled`);
    if (timeout.aborted) {
      throw new NetworkError(`${opts.label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`${opts.label}: ${message}`);
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to do: the response is being thrown away anyway.
  }
}

/** Request without API-key rotation (used for screenshot downloads). */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const attempts = opts.retries + 1;
  let lastResponse: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchOnce(url, init, attemptTimeout(opts), opts);
      if (!RETRY_STATUSES.has(res.status)) return res;
      lastResponse = res;
      if (attempt === attempts) break;
      const wait = retryAfterMs(res) ?? backoffMs(attempt, opts.backoff);
      console.warn(`${opts.label}: HTTP ${res.status} (attempt ${attempt}/${attempts}) - retrying in ${Math.round(wait)}ms`);
      await discardBody(res);
      await sleep(wait, opts.signal);
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === attempts) break;
      const wait = backoffMs(attempt, opts.backoff);
      console.warn(`${opts.label}: ${lastError.message} (attempt ${attempt}/${attempts}) - retrying in ${Math.round(wait)}ms`);
      await sleep(wait, opts.signal);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new NetworkError(`${opts.label}: request failed`);
}

/**
 * Like fetchWithRetry, but rotates API keys on auth and rate-limit failures.
 *
 *   401/402/403 -> key retired, switch immediately
 *   429         -> key cools down for 60s, switch immediately; if every key is
 *                  cooling down, wait for the soonest one (bounded)
 *   5xx/network -> retry the same key with backoff, then switch keys
 */
export async function fetchWithKeys(url: string, opts: KeyedOptions): Promise<Response> {
  const attempts = opts.retries + 1;
  const maxKeyWait = opts.maxKeyWaitMs ?? 180_000;
  const tried = new Set<string>();
  let lastResponse: Response | null = null;
  let lastError: Error | null = null;
  let waited = 0;

  for (;;) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      throw new DeadlineError(`${opts.label}: request time budget exhausted`);
    }

    let key: string;
    try {
      key = opts.pool.pick(tried);
    } catch {
      if (!opts.pool.hasAlive()) {
        throw new FatalApiError(
          `All ${opts.pool.name} API keys are invalid or exhausted. Add more keys.`,
        );
      }
      const wait = opts.pool.msUntilReady();
      if (wait === null) throw new FatalApiError(`All ${opts.pool.name} API keys are unusable.`);
      if (waited + wait > maxKeyWait) {
        if (lastResponse) return lastResponse;
        throw new NetworkError(`${opts.label}: all API keys are rate-limited`);
      }
      if (wait > 0) {
        console.warn(`${opts.label}: all keys cooling down - waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000, opts.signal);
        waited += wait + 1000;
      }
      tried.clear();
      lastResponse = null;
      continue;
    }

    tried.add(key);
    const tag = `${opts.label}[...${key.slice(-4)}]`;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await fetchOnce(url, opts.buildInit(key), attemptTimeout(opts), opts);
      } catch (err) {
        if (err instanceof DeadlineError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= attempts) {
          opts.pool.reportFailure(key, { cooldownMs: 30_000 });
          break;
        }
        const wait = backoffMs(attempt, opts.backoff);
        console.warn(
          `${tag}: ${lastError.message} (attempt ${attempt}/${attempts}) - retrying in ${Math.round(wait)}ms`,
        );
        await sleep(wait, opts.signal);
        continue;
      }

      lastResponse = res;

      if (res.status === 401 || res.status === 402 || res.status === 403) {
        opts.pool.reportFailure(key, { fatal: true });
        console.warn(`${tag}: key rejected (${res.status}) - retiring and switching keys`);
        break;
      }

      if (res.status === 429) {
        opts.pool.reportRateLimited(key);
        console.warn(`${tag}: rate-limited (429) - switching keys`);
        break;
      }

      if (!RETRY_STATUSES.has(res.status)) {
        opts.pool.reportSuccess(key);
        return res;
      }

      if (attempt >= attempts) {
        opts.pool.reportFailure(key, { cooldownMs: 30_000 });
        break;
      }

      const wait = retryAfterMs(res) ?? backoffMs(attempt, opts.backoff);
      console.warn(`${tag}: HTTP ${res.status} (attempt ${attempt}/${attempts}) - retrying in ${Math.round(wait)}ms`);
      await discardBody(res);
      await sleep(wait, opts.signal);
    }
  }
}

export async function safeJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export function errorMessage(payload: unknown, res: Response): string {
  let message: unknown;
  if (payload && typeof payload === "object") {
    const body = payload as Record<string, unknown>;
    const error = body.error;
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      message = e.message ?? e.status;
    } else if (typeof error === "string") {
      message = error;
    }
    message = message ?? body.message;
  }
  const text = typeof message === "string" && message.trim() ? message : res.statusText;
  return (text || `HTTP ${res.status}`).trim().slice(0, 300);
}

/** Stable JSON with sorted keys, used for cache fingerprints. */
export function stableStringify(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}
