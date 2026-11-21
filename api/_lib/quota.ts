/**
 * Shared quota coordination for the Gemini keys.
 *
 * Google's rate limits are counted per Cloud project, and a project is
 * attached to a key rather than to a person. We therefore cannot know how
 * many projects the configured keys really cover, so the coordinator keeps
 * two levels of budget:
 *
 *   - a global budget over all keys together, sized to stay inside the free
 *     tier even when every key points at the same project;
 *   - a per-key budget, so no single key is hammered and a key that runs
 *     into its own limit is noticed.
 *
 * The counters live in Redis because Vercel runs many function instances at
 * the same time. A per-instance counter would let every instance spend the
 * same minute's tokens, which is exactly what used to happen.
 *
 * The rolling minute is a sorted set per bucket: every reservation is a
 * member scored with its timestamp, and the sum of the members inside the
 * last 60 seconds is what has been spent. One Lua script does the read and
 * the write in a single step, so two workers cannot both squeeze past the
 * limit at the same moment.
 *
 * A local, in-memory book implements the same interface. It is used by the
 * tests and as the fallback when no Redis credentials are configured.
 */
import { createHash, randomBytes } from "node:crypto";

/** One minute: the window Google's per-minute limits use. */
export const WINDOW_MS = 60_000;

export interface QuotaLimits {
  /** Input tokens per minute for one key. */
  tokensPerKey: number;
  /** Requests per minute for one key. */
  requestsPerKey: number;
  /** Input tokens per minute for all keys together. */
  tokensTotal: number;
  /** Requests per minute for all keys together. */
  requestsTotal: number;
}

/** Identifies a key without ever writing the key itself to Redis. */
export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export interface Reservation {
  /** False when the window is full; the caller must wait or defer. */
  allowed: boolean;
  /** How long until the window has room again. */
  waitMs: number;
  /** Tokens already spent inside the window (after this reservation). */
  tokensUsed: number;
  /** Requests already made inside the window (after this reservation). */
  requestsUsed: number;
  /** Identifier of the reservation, needed to commit or release it. */
  id: string;
  /** The scope this reservation was taken from ("global" or a key hash). */
  scopeKey: string;
  /** Which budget this reservation was taken from. */
  scope: "global" | "key";
  /** Tokens booked by this reservation. */
  tokens: number;
  /** Timestamp used as the sorted-set score. */
  score: number;
  /** Members written to Redis, kept so the reservation can be settled. */
  tokenMember: string;
  requestMember: string;
}

export interface QuotaSnapshot {
  scope: "global" | "key";
  tokensUsed: number;
  requestsUsed: number;
  cooldownUntil: number;
}

export interface QuotaAvailability {
  allowed: boolean;
  waitMs: number;
  tokensUsed: number;
  requestsUsed: number;
}

/**
 * The budget book. Everything above this interface works the same whether the
 * counters live in Redis (production) or in memory (tests, local dev).
 */
export interface QuotaBook {
  /** Books room for one call. */
  reserve(scope: string, tokens: number): Promise<Reservation>;
  /** Gives everything back: the request was never sent. */
  release(reservation: Reservation): Promise<void>;
  /**
   * Keeps the request counted but corrects the token amount to what the model
   * actually charged. Used after a successful call.
   */
  commit(reservation: Reservation, usedTokens: number): Promise<void>;
  /** Checks whether room is available without booking anything. */
  peek(scope: string, tokens: number): Promise<QuotaAvailability>;
  /** Blocks a scope until `until` (a Date.now() timestamp). */
  setCooldown(scope: string, until: number, ttlMs?: number): Promise<void>;
  /** Milliseconds until the scope is usable again; 0 when it is free. */
  cooldownRemaining(scope: string): Promise<number>;
  /** What the window looks like right now, for /health. */
  snapshot(scope: string): Promise<QuotaSnapshot>;
  /** Removes every counter of a scope. Used by the tests. */
  reset(scope: string): Promise<void>;
}

/** The scope that covers every key together. */
export const GLOBAL_SCOPE = "global";

export function scopeOf(scope: string): "global" | "key" {
  return scope === GLOBAL_SCOPE ? "global" : "key";
}

/* --------------------------------------------------------------- Redis book */

/** The subset of Redis this module needs; keeps the tests independent. */
export interface QuotaRedis {
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { px?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Reserves room in the rolling minute.
 *
 * The script returns { allowed, tokensUsed, requestsUsed, waitMs }. It is
 * written to fail closed: when the window is full the caller is told how
 * long to wait instead of being allowed to spend anyway.
 */
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local tokens = tonumber(ARGV[3])
local id = ARGV[4]
local maxTokens = tonumber(ARGV[5])
local maxRequests = tonumber(ARGV[6])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

local used = 0
local members = redis.call('ZRANGEBYSCORE', KEYS[1], cutoff, '+inf')
for i = 1, #members do
  local amount = string.match(members[i], '^%d+:(%d+):')
  if amount then used = used + tonumber(amount) end
end
local requests = redis.call('ZCARD', KEYS[2])

local cooldown = tonumber(redis.call('GET', KEYS[3]) or '0')
if cooldown > now then
  return {0, used, requests, cooldown - now}
end

if used + tokens > maxTokens or requests + 1 > maxRequests then
  local wait = window
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    wait = (tonumber(oldest[2]) + window) - now
  end
  if requests + 1 > maxRequests then
    local oldestRequest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    if oldestRequest[2] then
      local requestWait = (tonumber(oldestRequest[2]) + window) - now
      if requestWait > wait then wait = requestWait end
    end
  end
  if wait < 1000 then wait = 1000 end
  return {0, used, requests, wait}
end

redis.call('ZADD', KEYS[1], now, now .. ':' .. tokens .. ':' .. id)
redis.call('ZADD', KEYS[2], now, now .. ':' .. id)
redis.call('PEXPIRE', KEYS[1], window * 2)
redis.call('PEXPIRE', KEYS[2], window * 2)
return {1, used + tokens, requests + 1, 0}
`;

/** Reads the window without booking anything. */
const PEEK_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

local used = 0
local members = redis.call('ZRANGEBYSCORE', KEYS[1], cutoff, '+inf')
for i = 1, #members do
  local amount = string.match(members[i], '^%d+:(%d+):')
  if amount then used = used + tonumber(amount) end
end
local requests = redis.call('ZCARD', KEYS[2])

local cooldown = tonumber(redis.call('GET', KEYS[3]) or '0')
if cooldown > now then
  return {0, used, requests, cooldown - now}
end
return {1, used, requests, 0}
`;

/** Drops a reservation completely (the request never left). */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

/**
 * Keeps the request, rewrites the tokens to what was charged. The score stays
 * the same so the corrected amount ages out of the window at the same moment
 * the original reservation would have.
 */
const COMMIT_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
end
return 1
`;

/** Reads the window for /health. */
const SNAPSHOT_SCRIPT = `
local cutoff = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

local used = 0
local members = redis.call('ZRANGEBYSCORE', KEYS[1], cutoff, '+inf')
for i = 1, #members do
  local amount = string.match(members[i], '^%d+:(%d+):')
  if amount then used = used + tonumber(amount) end
end
local requests = redis.call('ZCARD', KEYS[2])
local cooldown = tonumber(redis.call('GET', KEYS[3]) or '0')
return {used, requests, cooldown}
`;

/**
 * The Redis-backed quota book.
 *
 * A scope is either "global" (all keys share one budget) or a key hash.
 * Both are stored under the same prefix, so a global cooldown and a key
 * cooldown are handled by the same code.
 */
export class RedisQuotaBook implements QuotaBook {
  private readonly redis: QuotaRedis;
  private readonly limits: QuotaLimits;
  private readonly prefix: string;
  private readonly windowMs: number;

  constructor(redis: QuotaRedis, limits: QuotaLimits, prefix = "ss:quota", windowMs = WINDOW_MS) {
    this.redis = redis;
    this.limits = limits;
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  private tokenKey(scope: string): string {
    return `${this.prefix}:tok:${scope}`;
  }

  private requestKey(scope: string): string {
    return `${this.prefix}:req:${scope}`;
  }

  private cooldownKey(scope: string): string {
    return `${this.prefix}:cd:${scope}`;
  }

  /** The limits that apply to one scope. */
  private limitsFor(scope: string): { tokens: number; requests: number } {
    if (scope === GLOBAL_SCOPE) {
      return { tokens: this.limits.tokensTotal, requests: this.limits.requestsTotal };
    }
    return { tokens: this.limits.tokensPerKey, requests: this.limits.requestsPerKey };
  }

  private makeReservation(
    scope: string,
    tokens: number,
    now: number,
    id: string,
    row: number[],
  ): Reservation {
    return {
      allowed: row[0] === 1,
      waitMs: Number.isFinite(row[3]) ? Math.max(0, row[3]) : this.windowMs,
      tokensUsed: Number.isFinite(row[1]) ? row[1] : 0,
      requestsUsed: Number.isFinite(row[2]) ? row[2] : 0,
      id,
      scopeKey: scope,
      scope: scopeOf(scope),
      tokens,
      score: now,
      tokenMember: `${now}:${tokens}:${id}`,
      requestMember: `${now}:${id}`,
    };
  }

  private row(result: unknown): number[] {
    return Array.isArray(result) ? result.map((value) => Number(value)) : [];
  }

  async reserve(scope: string, tokens: number): Promise<Reservation> {
    const now = Date.now();
    const id = randomBytes(6).toString("hex");
    const limits = this.limitsFor(scope);
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      [this.tokenKey(scope), this.requestKey(scope), this.cooldownKey(scope)],
      [now, this.windowMs, tokens, id, limits.tokens, limits.requests],
    );
    return this.makeReservation(scope, tokens, now, id, this.row(result));
  }

  async release(reservation: Reservation): Promise<void> {
    await this.redis.eval(
      RELEASE_SCRIPT,
      [this.tokenKey(reservation.scopeKey), this.requestKey(reservation.scopeKey)],
      [reservation.tokenMember, reservation.requestMember],
    );
  }

  async commit(reservation: Reservation, usedTokens: number): Promise<void> {
    const used = Math.max(0, Math.round(usedTokens));
    await this.redis.eval(
      COMMIT_SCRIPT,
      [this.tokenKey(reservation.scopeKey)],
      [
        reservation.tokenMember,
        used,
        reservation.score,
        `${reservation.score}:${used}:${reservation.id}`,
        this.windowMs * 2,
      ],
    );
  }

  async peek(scope: string, tokens: number): Promise<QuotaAvailability> {
    const result = await this.redis.eval(
      PEEK_SCRIPT,
      [this.tokenKey(scope), this.requestKey(scope), this.cooldownKey(scope)],
      [Date.now(), this.windowMs],
    );
    const row = this.row(result);
    const cooling = row[0] === 0 && Number.isFinite(row[3]) && row[3] > 0;
    const limits = this.limitsFor(scope);
    const used = Number.isFinite(row[1]) ? row[1] : 0;
    const requests = Number.isFinite(row[2]) ? row[2] : 0;
    const full = used + tokens > limits.tokens || requests + 1 > limits.requests;
    return {
      allowed: !cooling && !full,
      waitMs: cooling ? Math.max(0, row[3] ?? 0) : full ? this.windowMs : 0,
      tokensUsed: used,
      requestsUsed: requests,
    };
  }

  async setCooldown(scope: string, until: number, ttlMs?: number): Promise<void> {
    const ttl = Math.max(1_000, ttlMs ?? Math.max(1_000, until - Date.now()));
    await this.redis.set(this.cooldownKey(scope), String(Math.round(until)), { px: ttl });
  }

  async cooldownRemaining(scope: string): Promise<number> {
    const raw = await this.redis.get(this.cooldownKey(scope));
    if (raw === null || raw === undefined) return 0;
    const until = Number(String(raw));
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - Date.now());
  }

  async snapshot(scope: string): Promise<QuotaSnapshot> {
    const result = await this.redis.eval(
      SNAPSHOT_SCRIPT,
      [this.tokenKey(scope), this.requestKey(scope), this.cooldownKey(scope)],
      [Date.now() - this.windowMs],
    );
    const row = this.row(result);
    return {
      scope: scopeOf(scope),
      tokensUsed: Number.isFinite(row[0]) ? row[0] : 0,
      requestsUsed: Number.isFinite(row[1]) ? row[1] : 0,
      cooldownUntil: Number.isFinite(row[2]) ? row[2] : 0,
    };
  }

  async reset(scope: string): Promise<void> {
    await this.redis.del(this.tokenKey(scope));
    await this.redis.del(this.requestKey(scope));
    await this.redis.del(this.cooldownKey(scope));
  }
}

/* -------------------------------------------------------------- memory book */

interface MemoryEntry {
  id: string;
  score: number;
  tokens: number;
}

/**
 * The same rules, but in one process.
 *
 * Used by the tests and whenever Redis is not configured. It cannot coordinate
 * between Vercel instances, so it is only a safety net.
 */
export class MemoryQuotaBook implements QuotaBook {
  private readonly limits: QuotaLimits;
  private readonly windowMs: number;
  private readonly entries = new Map<string, MemoryEntry[]>();
  private readonly requests = new Map<string, { id: string; score: number }[]>();
  private readonly cooldowns = new Map<string, number>();

  constructor(limits: QuotaLimits, windowMs = WINDOW_MS) {
    this.limits = limits;
    this.windowMs = windowMs;
  }

  private limitsFor(scope: string): { tokens: number; requests: number } {
    if (scope === GLOBAL_SCOPE) {
      return { tokens: this.limits.tokensTotal, requests: this.limits.requestsTotal };
    }
    return { tokens: this.limits.tokensPerKey, requests: this.limits.requestsPerKey };
  }

  private prune(scope: string): void {
    const cutoff = Date.now() - this.windowMs;
    this.entries.set(
      scope,
      (this.entries.get(scope) ?? []).filter((entry) => entry.score > cutoff),
    );
    this.requests.set(
      scope,
      (this.requests.get(scope) ?? []).filter((entry) => entry.score > cutoff),
    );
  }

  async reserve(scope: string, tokens: number): Promise<Reservation> {
    const now = Date.now();
    const id = randomBytes(6).toString("hex");
    this.prune(scope);
    const entries = this.entries.get(scope) ?? [];
    const requests = this.requests.get(scope) ?? [];
    const used = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const limits = this.limitsFor(scope);
    const cooldown = this.cooldowns.get(scope) ?? 0;

    const reservation: Reservation = {
      allowed: false,
      waitMs: this.windowMs,
      tokensUsed: used,
      requestsUsed: requests.length,
      id,
      scopeKey: scope,
      scope: scopeOf(scope),
      tokens,
      score: now,
      tokenMember: `${now}:${tokens}:${id}`,
      requestMember: `${now}:${id}`,
    };

    if (cooldown > now) {
      reservation.waitMs = cooldown - now;
      return reservation;
    }
    if (used + tokens > limits.tokens || requests.length + 1 > limits.requests) {
      const oldest = entries[0]?.score ?? now;
      const oldestRequest = requests[0]?.score ?? now;
      reservation.waitMs = Math.max(
        1_000,
        oldest + this.windowMs - now,
        oldestRequest + this.windowMs - now,
      );
      return reservation;
    }

    entries.push({ id, score: now, tokens });
    this.entries.set(scope, entries);
    requests.push({ id, score: now });
    this.requests.set(scope, requests);
    reservation.allowed = true;
    reservation.waitMs = 0;
    reservation.tokensUsed = used + tokens;
    reservation.requestsUsed = requests.length;
    return reservation;
  }

  async release(reservation: Reservation): Promise<void> {
    this.entries.set(
      reservation.scopeKey,
      (this.entries.get(reservation.scopeKey) ?? []).filter((entry) => entry.id !== reservation.id),
    );
    this.requests.set(
      reservation.scopeKey,
      (this.requests.get(reservation.scopeKey) ?? []).filter((entry) => entry.id !== reservation.id),
    );
  }

  async commit(reservation: Reservation, usedTokens: number): Promise<void> {
    const used = Math.max(0, Math.round(usedTokens));
    const entries = this.entries.get(reservation.scopeKey) ?? [];
    const index = entries.findIndex((entry) => entry.id === reservation.id);
    if (index >= 0) entries[index] = { ...entries[index]!, tokens: used };
    this.entries.set(reservation.scopeKey, entries);
  }

  async peek(scope: string, tokens: number): Promise<QuotaAvailability> {
    this.prune(scope);
    const entries = this.entries.get(scope) ?? [];
    const requests = this.requests.get(scope) ?? [];
    const used = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const limits = this.limitsFor(scope);
    const remaining = (this.cooldowns.get(scope) ?? 0) - Date.now();
    const cooling = remaining > 0;
    const full = used + tokens > limits.tokens || requests.length + 1 > limits.requests;
    return {
      allowed: !cooling && !full,
      waitMs: cooling ? remaining : full ? this.windowMs : 0,
      tokensUsed: used,
      requestsUsed: requests.length,
    };
  }

  async setCooldown(scope: string, until: number): Promise<void> {
    this.cooldowns.set(scope, until);
  }

  async cooldownRemaining(scope: string): Promise<number> {
    return Math.max(0, (this.cooldowns.get(scope) ?? 0) - Date.now());
  }

  async snapshot(scope: string): Promise<QuotaSnapshot> {
    this.prune(scope);
    const entries = this.entries.get(scope) ?? [];
    return {
      scope: scopeOf(scope),
      tokensUsed: entries.reduce((sum, entry) => sum + entry.tokens, 0),
      requestsUsed: (this.requests.get(scope) ?? []).length,
      cooldownUntil: this.cooldowns.get(scope) ?? 0,
    };
  }

  async reset(scope: string): Promise<void> {
    this.entries.delete(scope);
    this.requests.delete(scope);
    this.cooldowns.delete(scope);
  }
}

/* ------------------------------------------------------------ token estimates */

/**
 * How many input tokens one image costs, per resolution.
 *
 * Measured on the free tier with the decision model: the token count barely
 * moves with the size of the screenshot, because "high" resolution downsamples
 * the page first. The numbers below are the measured values with a margin.
 */
export const IMAGE_TOKENS: Record<string, number> = {
  low: 300,
  medium: 560,
  high: 1150,
  ultra_high: 2300,
};

/**
 * Estimates the input tokens of one Decisions call.
 *
 * The text is counted from the request body without the base64 image; the
 * image part comes from the measured table above. `observed` is what the
 * model actually charged last time, and it always wins: it is the truth.
 */
export function estimateInputTokens(options: {
  textChars: number;
  resolution: string;
  /** How many images one call carries (the design call sends three). */
  imageCount?: number;
  observed?: number | null;
}): number {
  const image = IMAGE_TOKENS[options.resolution] ?? IMAGE_TOKENS.high!;
  const text = Math.ceil(options.textChars / 3);
  const raw = text + image * Math.max(1, options.imageCount ?? 1);
  const observed = Number(options.observed ?? 0);
  return Math.max(raw, Number.isFinite(observed) ? observed : 0);
}

/**
 * Reads the input tokens out of a Gemini usage block.
 *
 * The API reports `total_input_tokens`; older shapes use `prompt_token_count`.
 */
export function usageInputTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  for (const field of ["total_input_tokens", "input_tokens", "prompt_token_count"]) {
    const value = Number(record[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Milliseconds until the next midnight in California.
 *
 * Google's daily quota resets at midnight Pacific time, so a daily limit has
 * to wait for that moment, not for midnight UTC.
 */
export function millisecondsUntilPacificMidnight(from = Date.now()): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(from)).map((part) => [part.type, part.value]),
  );
  const second = Number(parts.second ?? "0") % 60;
  const minute = Number(parts.minute ?? "0");
  const hour = Number(parts.hour ?? "0") % 24;
  const day = Number(parts.day ?? "1");
  const month = Number(parts.month ?? "1");
  const year = Number(parts.year ?? "1970");
  // The wall clock in California, expressed as if it were UTC.
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = local - Math.floor(from / 1000) * 1000;
  const nextMidnightLocal = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  return Math.max(60_000, nextMidnightLocal - offset - from);
}

/* ------------------------------------------------------------------ the guard */

/** A reservation taken on both budgets for one call. */
export interface QuotaGrant {
  key: Reservation;
  global: Reservation;
}

export type QuotaAttempt =
  | { ok: true; grant: QuotaGrant }
  | { ok: false; waitMs: number; scope: "minute" | "day"; scopeKey: string };

/**
 * The thing the pipeline talks to.
 *
 * It hides the two-level reservation, remembers what a call really cost, and
 * turns a 429 into a cooldown on exactly one key instead of a global panic.
 */
export class QuotaGuard {
  private readonly book: QuotaBook;
  /** Learned cost per key hash, so the next estimate is not too low. */
  private readonly observed = new Map<string, number>();

  constructor(book: QuotaBook) {
    this.book = book;
  }

  get budget(): QuotaBook {
    return this.book;
  }

  /**
   * Books room for one call. Deferred when either budget is full: the caller
   * should requeue the work instead of waiting inside the request.
   */
  async acquire(key: string, tokens: number): Promise<QuotaAttempt> {
    const scope = keyHash(key);
    const global = await this.book.reserve(GLOBAL_SCOPE, tokens);
    if (!global.allowed) {
      return { ok: false, waitMs: global.waitMs, scope: "minute", scopeKey: GLOBAL_SCOPE };
    }
    const perKey = await this.book.reserve(scope, tokens);
    if (!perKey.allowed) {
      await this.book.release(global);
      return { ok: false, waitMs: perKey.waitMs, scope: "minute", scopeKey: scope };
    }
    return { ok: true, grant: { key: perKey, global } };
  }

  /** The request never left: give both reservations back. */
  async abandon(grant: QuotaGrant): Promise<void> {
    await Promise.all([this.book.release(grant.key), this.book.release(grant.global)]);
  }

  /** The call worked: keep exactly what the model says it charged. */
  async settle(grant: QuotaGrant, usage: unknown, estimated: number): Promise<number> {
    const used = usageInputTokens(usage) ?? estimated;
    const scope = grant.key.scopeKey;
    this.observed.set(scope, used);
    await Promise.all([this.book.commit(grant.key, used), this.book.commit(grant.global, used)]);
    return used;
  }

  /** What one call on this key is likely to cost, learned from earlier calls. */
  learnedTokens(key: string): number | null {
    const value = this.observed.get(keyHash(key));
    return value === undefined ? null : value;
  }

  /**
   * Records that Google refused a call. The key cools down; the shared token
   * budget is left alone, because a single key's limit says nothing about the
   * keys that live in other projects.
   */
  async noteRateLimited(
    key: string,
    opts: { retryAfterMs: number; scope: "minute" | "day" },
  ): Promise<void> {
    const scope = keyHash(key);
    const until = Date.now() + Math.max(1_000, opts.retryAfterMs);
    await this.book.setCooldown(scope, until, Math.max(opts.retryAfterMs, 1_000) + 5_000);
  }

  /** True when the key may be used right now. */
  async available(key: string): Promise<boolean> {
    return (await this.book.cooldownRemaining(keyHash(key))) === 0;
  }

  /** Everything /health needs to show, without leaking key material. */
  async report(keys: string[]): Promise<{
    global: QuotaSnapshot;
    keys: { hash: string; tokensUsed: number; requestsUsed: number; cooldownMs: number }[];
  }> {
    const global = await this.book.snapshot(GLOBAL_SCOPE);
    const perKey = await Promise.all(
      keys.map(async (key) => {
        const scope = keyHash(key);
        const snapshot = await this.book.snapshot(scope);
        return {
          hash: scope,
          tokensUsed: snapshot.tokensUsed,
          requestsUsed: snapshot.requestsUsed,
          cooldownMs: Math.max(0, snapshot.cooldownUntil - Date.now()),
        };
      }),
    );
    return { global, keys: perKey };
  }
}
