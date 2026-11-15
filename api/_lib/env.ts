/** Settings: everything configurable through environment variables. */
import { ConfigError } from "./errors.js";

export const API_VERSION = "1.0.0";
export const USER_AGENT = "sitescout-api/1.0";

export type ImageResolution = "low" | "medium" | "high" | "ultra_high";

export interface Settings {
  firecrawlKeys: string[];
  geminiKeys: string[];
  apiToken: string;
  decisionModel: string;
  viewportW: number;
  viewportH: number;
  waitForMs: number;
  scrapeTimeoutMs: number;
  captureAttempts: number;
  httpRetries: number;
  backoffBase: number;
  imageResolution: ImageResolution;
  reachOutThreshold: number;
  maybeThreshold: number;
  minConfidence: number;
  decisionCacheTtlHours: number;
  maxUrls: number;
  concurrency: number;
  requestDeadlineMs: number;
  maxImageBytes: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envText(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

/** First non-empty env var wins; keys may be separated by commas, semicolons or spaces. */
function readKeys(...names: string[]): string[] {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw || raw.trim() === "") continue;
    const keys = raw
      .trim()
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length > 0) return [...new Set(keys)];
  }
  return [];
}

function readResolution(): ImageResolution {
  const raw = envText("SITESCOUT_IMAGE_RESOLUTION", "high").toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" || raw === "ultra_high" ? raw : "high";
}

export function loadSettings(): Settings {
  const firecrawlKeys = readKeys("FIRECRAWL_API_KEYS", "FIRECRAWL_API_KEY");
  const geminiKeys = readKeys("GEMINI_API_KEYS", "GEMINI_API_KEY", "GOOGLE_API_KEY");
  const apiToken = envText("SITESCOUT_API_TOKEN", "");

  const missing: string[] = [];
  if (firecrawlKeys.length === 0) missing.push("FIRECRAWL_API_KEYS");
  if (geminiKeys.length === 0) missing.push("GEMINI_API_KEYS");
  if (!apiToken) missing.push("SITESCOUT_API_TOKEN");
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing environment variables: ${missing.join(", ")}. ` +
        "Locally put them in .env.local; in production add them in the Vercel dashboard " +
        "under Settings > Environment Variables.",
    );
  }

  return {
    firecrawlKeys,
    geminiKeys,
    apiToken,
    decisionModel: envText("SITESCOUT_MODEL", "gemini-decision-1"),
    viewportW: envNumber("SITESCOUT_VIEWPORT_W", 1440),
    viewportH: envNumber("SITESCOUT_VIEWPORT_H", 900),
    waitForMs: envNumber("SITESCOUT_WAIT_MS", 2500),
    scrapeTimeoutMs: envNumber("SITESCOUT_SCRAPE_TIMEOUT_MS", 60_000),
    captureAttempts: envNumber("SITESCOUT_CAPTURE_ATTEMPTS", 2),
    httpRetries: envNumber("SITESCOUT_HTTP_RETRIES", 3),
    backoffBase: envNumber("SITESCOUT_BACKOFF_BASE", 1.5),
    imageResolution: readResolution(),
    reachOutThreshold: envNumber("SITESCOUT_REACH_OUT_THRESHOLD", 0.6),
    maybeThreshold: envNumber("SITESCOUT_MAYBE_THRESHOLD", 0.4),
    minConfidence: envNumber("SITESCOUT_MIN_CONFIDENCE", 0.55),
    decisionCacheTtlHours: envNumber("SITESCOUT_DECISION_CACHE_TTL_HOURS", 72),
    maxUrls: Math.max(1, Math.min(envNumber("SITESCOUT_MAX_URLS", 5), 10)),
    concurrency: Math.max(1, Math.min(envNumber("SITESCOUT_CONCURRENCY", 3), 5)),
    // Vercel Hobby kills a request at 300 s, so the internal budget stays below
    // that no matter what the environment says.
    requestDeadlineMs: Math.max(
      5_000,
      Math.min(envNumber("SITESCOUT_REQUEST_DEADLINE_MS", 270_000), 280_000),
    ),
    // Google's inline limit is 20 MB; stay just below it instead of shrinking anything.
    maxImageBytes: envNumber("SITESCOUT_MAX_IMAGE_BYTES", 18 * 1024 * 1024),
  };
}
