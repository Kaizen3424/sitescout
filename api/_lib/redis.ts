/**
 * Upstash Redis client (HTTP/REST, so it works from serverless functions).
 *
 * Only the durable job queue uses this. The existing `/v1/analyze` endpoint
 * still relies on Vercel's Runtime Cache, so nothing changes for it.
 */
import { Redis } from "@upstash/redis";
import { ConfigError } from "./errors.js";

let client: Redis | null = null;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The Vercel Marketplace integration writes `UPSTASH_REDIS_REST_*`, older
 * Vercel KV setups wrote `KV_REST_API_*`; accept both.
 */
export function redisCredentials(): { url: string; token: string } {
  const url = env("UPSTASH_REDIS_REST_URL") || env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") || env("KV_REST_API_TOKEN");
  if (!url || !token) {
    throw new ConfigError(
      "Missing Upstash Redis configuration: set UPSTASH_REDIS_REST_URL and " +
        "UPSTASH_REDIS_REST_TOKEN. Locally put them in .env.local; in production add them " +
        "in the Vercel dashboard under Settings > Environment Variables.",
    );
  }
  return { url, token };
}

/** True when Redis is configured; lets optional features fall back cleanly. */
export function hasRedis(): boolean {
  const url = env("UPSTASH_REDIS_REST_URL") || env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") || env("KV_REST_API_TOKEN");
  return Boolean(url && token);
}

export function getRedis(): Redis {
  if (client) return client;
  const { url, token } = redisCredentials();
  // Values are stored as JSON strings and parsed by the job layer, so the
  // client must not try to deserialize them on its own.
  client = new Redis({ url, token, automaticDeserialization: false });
  return client;
}

export function resetRedis(): void {
  client = null;
}

/**
 * `hgetall` is not a plain object when automatic deserialization is off: the
 * SDK returns `["field", "value", ...]` (and `[]` for a missing key). Normalise
 * both shapes so callers always get a record of raw strings.
 */
export function toRecord(flat: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out[String(flat[i])] = String(flat[i + 1]);
    }
    return out;
  }
  if (flat && typeof flat === "object") {
    for (const [key, value] of Object.entries(flat as Record<string, unknown>)) {
      out[key] = value === null || value === undefined ? "" : String(value);
    }
  }
  return out;
}
