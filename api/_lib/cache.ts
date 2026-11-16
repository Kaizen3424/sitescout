/**
 * The Decisions answer cache.
 *
 * Redis first, because a URL that is put back in the queue runs in a different
 * function instance and must not pay again for the question groups that were
 * already answered. Vercel's Runtime Cache is the fallback: it works without
 * any configuration, but it is per instance.
 */
import { getCache } from "@vercel/functions";

import { getRedis, hasRedis } from "./redis.js";

type RuntimeCache = ReturnType<typeof getCache>;

let cache: RuntimeCache | null = null;

function runtimeCache(): RuntimeCache {
  cache ??= getCache({ namespace: "sitescout" });
  return cache;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (hasRedis()) {
    try {
      const raw = await getRedis().get<string>(`ss:cache:${key}`);
      if (raw === null || raw === undefined) return null;
      return typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T);
    } catch (err) {
      console.warn(`cache get failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
  try {
    const value = await runtimeCache().get(key);
    return (value ?? null) as T | null;
  } catch (err) {
    console.warn(`cache get failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const ttl = Math.max(60, Math.round(ttlSeconds));
  if (hasRedis()) {
    try {
      await getRedis().set(`ss:cache:${key}`, JSON.stringify(value), { ex: ttl });
      return;
    } catch (err) {
      console.warn(`cache set failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await runtimeCache().set(key, value, { ttl, name: key.slice(0, 64) });
  } catch (err) {
    console.warn(`cache set failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
