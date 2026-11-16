/**
 * The key-rotation rules, tested against a real HTTP server.
 *
 * The bug these guard against: a single 429 used to send the request through
 * every configured key, then wait ~58 s and start again. That multiplied one
 * minute of exhausted quota into hundreds of failed calls.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { KeyUnavailableError } from "../api/_lib/errors.js";
import { fetchWithKeys } from "../api/_lib/http.js";
import type { KeyPool } from "../api/_lib/keys.js";

/** Just enough of KeyPool for the rotation logic. */
class FakePool {
  readonly name = "Gemini";
  readonly keys: string[];
  readonly rateLimited: string[] = [];
  readonly failed: string[] = [];
  private readonly cooldown = new Map<string, number>();

  constructor(keys: string[]) {
    this.keys = keys;
  }

  get size(): number {
    return this.keys.length;
  }

  pick(exclude: Set<string> = new Set()): string {
    const ready = this.keys.filter(
      (key) => !exclude.has(key) && (this.cooldown.get(key) ?? 0) <= Date.now(),
    );
    if (ready.length === 0) throw new Error("no key available");
    return ready[0]!;
  }

  hasAlive(): boolean {
    return true;
  }

  msUntilReady(): number | null {
    const soonest = Math.min(...this.keys.map((key) => this.cooldown.get(key) ?? 0));
    return Math.max(0, soonest - Date.now());
  }

  reportRateLimited(key: string, cooldownMs = 60_000): void {
    this.rateLimited.push(key);
    this.cooldown.set(key, Date.now() + cooldownMs);
  }

  reportFailure(key: string): void {
    this.failed.push(key);
  }

  reportSuccess(): void {}
}

const KEYS = Array.from({ length: 14 }, (_, i) => `AIza-key-${String(i + 1).padStart(2, "0")}`);

interface Harness {
  url: string;
  server: Server;
  requests: string[];
  /** Every request gets the next status; the last one repeats. */
  plan: number[];
}

async function startServer(plan: number[]): Promise<Harness> {
  const harness: Harness = { url: "", server: createServer(), requests: [], plan };
  harness.server.on("request", (req, res) => {
    harness.requests.push(String(req.headers["x-key"] ?? ""));
    const status = harness.plan[Math.min(harness.requests.length - 1, harness.plan.length - 1)]!;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { ok: true } : { error: { code: status } }));
  });
  await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
  const address = harness.server.address() as AddressInfo;
  harness.url = `http://127.0.0.1:${address.port}/`;
  return harness;
}

function stop(harness: Harness): Promise<void> {
  return new Promise((resolve) => harness.server.close(() => resolve()));
}

test("a 429 storm tries at most maxKeyAttempts keys, not the whole pool", async () => {
  const harness = await startServer([429]);
  const pool = new FakePool(KEYS);
  try {
    const res = await fetchWithKeys(harness.url, {
      pool: pool as unknown as KeyPool,
      buildInit: (key) => ({ headers: { "x-key": key } }),
      label: "Gemini test",
      retries: 0,
      backoff: 0.1,
      timeoutMs: 5_000,
      maxKeyAttempts: 3,
      whenExhausted: "fail",
    });

    assert.equal(res.status, 429, "the caller gets the 429 so it can defer the work");
    assert.equal(harness.requests.length, 3);
    assert.equal(new Set(harness.requests).size, 3, "three different keys");
    assert.equal(pool.rateLimited.length, 3);
    assert.equal(pool.failed.length, 0, "a 429 is not a broken key");
  } finally {
    await stop(harness);
  }
});

test("the default budget still never sweeps more keys than the pool has", async () => {
  const harness = await startServer([429]);
  const pool = new FakePool(["AIza-one", "AIza-two"]);
  try {
    await fetchWithKeys(harness.url, {
      pool: pool as unknown as KeyPool,
      buildInit: (key) => ({ headers: { "x-key": key } }),
      label: "Gemini test",
      retries: 0,
      backoff: 0.1,
      timeoutMs: 5_000,
      maxKeyAttempts: 9,
      whenExhausted: "fail",
    });
    assert.equal(harness.requests.length, 2);
  } finally {
    await stop(harness);
  }
});

test("a key that is cooling down elsewhere is skipped without using an attempt", async () => {
  const harness = await startServer([200]);
  const pool = new FakePool(KEYS);
  const prepared: string[] = [];
  try {
    const res = await fetchWithKeys(harness.url, {
      pool: pool as unknown as KeyPool,
      buildInit: (key) => ({ headers: { "x-key": key } }),
      label: "Gemini test",
      retries: 0,
      backoff: 0.1,
      timeoutMs: 5_000,
      maxKeyAttempts: 1,
      whenExhausted: "fail",
      prepare: async (key) => {
        prepared.push(key);
        // Pretend the first two keys are still cooling down in another worker.
        return prepared.length > 2;
      },
    });

    assert.equal(res.status, 200);
    assert.equal(harness.requests.length, 1);
    assert.equal(prepared.length, 3, "two skipped, one used");
    assert.equal(harness.requests[0], prepared[2], "the third key carried the request");
  } finally {
    await stop(harness);
  }
});

test("a server error is retried on the same key, then succeeds", async () => {
  const harness = await startServer([503, 503, 200]);
  const pool = new FakePool(KEYS);
  let settled = 0;
  try {
    const res = await fetchWithKeys(harness.url, {
      pool: pool as unknown as KeyPool,
      buildInit: (key) => ({ headers: { "x-key": key } }),
      label: "Gemini test",
      retries: 3,
      backoff: 0.01,
      timeoutMs: 5_000,
      maxKeyAttempts: 3,
      whenExhausted: "fail",
      settle: async () => {
        settled += 1;
      },
    });

    assert.equal(res.status, 200);
    assert.equal(harness.requests.length, 3);
    assert.equal(new Set(harness.requests).size, 1, "backoff stays on the same key");
    assert.equal(settled, 1);
  } finally {
    await stop(harness);
  }
});

test("no request is sent when every key is cooling down", async () => {
  const harness = await startServer([200]);
  const pool = new FakePool(KEYS);
  for (const key of KEYS) pool.reportRateLimited(key, 30_000);
  try {
    await assert.rejects(
      fetchWithKeys(harness.url, {
        pool: pool as unknown as KeyPool,
        buildInit: (key) => ({ headers: { "x-key": key } }),
        label: "Gemini test",
        retries: 0,
        backoff: 0.1,
        timeoutMs: 5_000,
        whenExhausted: "fail",
      }),
      (err: unknown) => {
        assert.ok(err instanceof KeyUnavailableError);
        assert.ok(err.retryAfterMs > 5_000, "it says how long to wait");
        return true;
      },
    );
    assert.equal(harness.requests.length, 0);
  } finally {
    await stop(harness);
  }
});

test("discard is told why an attempt ended", async () => {
  const harness = await startServer([429, 401, 200]);
  const pool = new FakePool(KEYS);
  const reasons: string[] = [];
  try {
    await fetchWithKeys(harness.url, {
      pool: pool as unknown as KeyPool,
      buildInit: (key) => ({ headers: { "x-key": key } }),
      label: "Gemini test",
      retries: 0,
      backoff: 0.1,
      timeoutMs: 5_000,
      maxKeyAttempts: 3,
      whenExhausted: "fail",
      discard: async (_key, reason) => {
        reasons.push(reason);
      },
    });
    assert.deepEqual(reasons, ["rate_limited", "failed"]);
    assert.deepEqual(pool.failed, [harness.requests[1]], "a rejected key is retired");
  } finally {
    await stop(harness);
  }
});
