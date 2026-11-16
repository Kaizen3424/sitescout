/** Module-level singletons so key cooldowns survive between warm invocations. */
import { loadSettings, type Settings } from "./env.js";
import { KeyPool } from "./keys.js";
import { MemoryQuotaBook, QuotaGuard, RedisQuotaBook, type QuotaLimits } from "./quota.js";
import { getRedis, hasRedis } from "./redis.js";

export interface Runtime {
  settings: Settings;
  firecrawl: KeyPool;
  gemini: KeyPool;
  quota: QuotaGuard;
}

let runtime: Runtime | null = null;

export function quotaLimits(settings: Settings): QuotaLimits {
  return {
    tokensPerKey: settings.geminiTokensPerKey,
    requestsPerKey: settings.geminiRequestsPerKey,
    tokensTotal: settings.geminiTokensPerMinute,
    requestsTotal: settings.geminiRequestsPerMinute,
  };
}

/**
 * The quota guard coordinates every worker instance through Redis. Without
 * Redis credentials it falls back to an in-memory book: correct for a single
 * process, a safety net only.
 */
export function loadQuotaGuard(settings: Settings): QuotaGuard {
  const limits = quotaLimits(settings);
  if (!hasRedis()) {
    console.warn("quota: no Redis configured, using in-memory budgets for this instance only");
    return new QuotaGuard(new MemoryQuotaBook(limits));
  }
  return new QuotaGuard(new RedisQuotaBook(getRedis(), limits));
}

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const settings = loadSettings();
  runtime = {
    settings,
    firecrawl: new KeyPool(settings.firecrawlKeys, "Firecrawl"),
    gemini: new KeyPool(settings.geminiKeys, "Gemini"),
    quota: loadQuotaGuard(settings),
  };
  return runtime;
}

export function resetRuntime(): void {
  runtime = null;
}
