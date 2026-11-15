/**
 * Small wrapper around Vercel's Runtime Cache. `getCache()` already falls back
 * to an in-memory cache when it runs outside Vercel, so local runs work too.
 */
import { getCache } from "@vercel/functions";

type RuntimeCache = ReturnType<typeof getCache>;

let cache: RuntimeCache | null = null;

function runtimeCache(): RuntimeCache {
  cache ??= getCache({ namespace: "sitescout" });
  return cache;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const value = await runtimeCache().get(key);
    return (value ?? null) as T | null;
  } catch (err) {
    console.warn(`cache get failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await runtimeCache().set(key, value, { ttl: Math.max(60, Math.round(ttlSeconds)), name: key.slice(0, 64) });
  } catch (err) {
    console.warn(`cache set failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
