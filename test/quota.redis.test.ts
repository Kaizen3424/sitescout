/**
 * Integration tests against a real Upstash Redis.
 *
 * They are skipped when no credentials are configured, so `npm test` works
 * offline. Everything is written under a throw-away `ss:test:` prefix, so the
 * production keys are never touched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Redis } from "@upstash/redis";

import {
  GLOBAL_SCOPE,
  QuotaGuard,
  RedisQuotaBook,
  keyHash,
  type QuotaLimits,
} from "../api/_lib/quota.js";

/** Reads `.env.local` without adding a dependency. */
function loadLocalEnv(): Record<string, string> {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};

  const values: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

const local = loadLocalEnv();
const url = (process.env.UPSTASH_REDIS_REST_URL ?? local.UPSTASH_REDIS_REST_URL ?? "").trim();
const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? local.UPSTASH_REDIS_REST_TOKEN ?? "").trim();

const redis = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;
const skip = redis ? false : "no Upstash Redis credentials available";

const LIMITS: QuotaLimits = {
  tokensPerKey: 1_000,
  requestsPerKey: 10,
  tokensTotal: 1_500,
  requestsTotal: 20,
};

let counter = 0;

/** A prefix nobody else uses. */
function newPrefix(name: string): string {
  counter += 1;
  return `ss:test:${name}:${process.pid}:${counter}`;
}

/** A book on a prefix nobody else uses. */
function newBook(prefix: string): RedisQuotaBook {
  return new RedisQuotaBook(redis!, LIMITS, prefix);
}

test("redis: a reservation round-trips and reports its window", { skip }, async (t) => {
  const book = newBook(newPrefix("basic"));
  const scope = keyHash("key-a");
  t.after(async () => {
    await book.reset(scope);
    await book.reset(GLOBAL_SCOPE);
  });

  const first = await book.reserve(scope, 400);
  assert.equal(first.allowed, true);
  assert.equal(first.tokensUsed, 400);
  assert.equal(first.requestsUsed, 1);

  const snapshot = await book.snapshot(scope);
  assert.equal(snapshot.tokensUsed, 400);
  assert.equal(snapshot.requestsUsed, 1);
});

test("redis: the per-key budget refuses a call that does not fit", { skip }, async (t) => {
  const book = newBook(newPrefix("cap"));
  const scope = keyHash("key-a");
  t.after(async () => {
    await book.reset(scope);
    await book.reset(GLOBAL_SCOPE);
  });

  assert.equal((await book.reserve(scope, 800)).allowed, true);

  const blocked = await book.reserve(scope, 300);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.waitMs > 0);
  assert.equal((await book.snapshot(scope)).tokensUsed, 800, "a refused call books nothing");
});

test("redis: release refunds, commit corrects the token count", { skip }, async (t) => {
  const book = newBook(newPrefix("settle"));
  const scope = keyHash("key-a");
  t.after(async () => {
    await book.reset(scope);
    await book.reset(GLOBAL_SCOPE);
  });

  const held = await book.reserve(scope, 900);
  await book.commit(held, 250);
  let snapshot = await book.snapshot(scope);
  assert.equal(snapshot.tokensUsed, 250);
  assert.equal(snapshot.requestsUsed, 1, "a committed call still counts as a request");

  const second = await book.reserve(scope, 600);
  assert.equal(second.allowed, true, "250 + 600 fits in 1000");
  await book.release(second);

  snapshot = await book.snapshot(scope);
  assert.equal(snapshot.tokensUsed, 250);
  assert.equal(snapshot.requestsUsed, 1);
});

test("redis: a cooldown survives between workers", { skip }, async (t) => {
  const shared = newPrefix("cooldown");
  const book = newBook(shared);
  const other = newBook(shared);
  const scope = keyHash("key-a");
  const fresh = keyHash("key-b");
  t.after(async () => {
    await book.reset(scope);
    await book.reset(fresh);
    await book.reset(GLOBAL_SCOPE);
  });

  // The second book stands in for a different Vercel instance: it must see
  // the cooldown that the first one wrote.
  await book.setCooldown(scope, Date.now() + 4_000);
  assert.ok((await other.cooldownRemaining(scope)) > 1_000);

  const blocked = await other.reserve(scope, 100);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.waitMs > 1_000);

  assert.equal((await other.cooldownRemaining(fresh)), 0, "other keys keep working");
  assert.equal((await other.reserve(fresh, 100)).allowed, true);
});

test("redis: the global budget spans every key", { skip }, async (t) => {
  const book = newBook(newPrefix("global"));
  t.after(async () => {
    await book.reset(GLOBAL_SCOPE);
  });

  assert.equal((await book.reserve(GLOBAL_SCOPE, 800)).allowed, true);
  assert.equal((await book.reserve(GLOBAL_SCOPE, 800)).allowed, false);
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 800);
});

test("redis: the guard learns the real cost and refunds a refused key", { skip }, async (t) => {
  const guard = new QuotaGuard(newBook(newPrefix("guard")));
  const key = "AIza-key-one";
  const scope = keyHash(key);
  t.after(async () => {
    await guard.budget.reset(scope);
    await guard.budget.reset(GLOBAL_SCOPE);
  });

  const first = await guard.acquire(key, 800);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const refused = await guard.acquire(key, 300);
  assert.equal(refused.ok, false);
  assert.equal(
    (await guard.budget.snapshot(GLOBAL_SCOPE)).tokensUsed,
    800,
    "the refused attempt left no global tokens behind",
  );

  const used = await guard.settle(first.grant, { total_input_tokens: 1_043 }, 800);
  assert.equal(used, 1_043);
  assert.equal(guard.learnedTokens(key), 1_043);
  assert.equal((await guard.budget.snapshot(GLOBAL_SCOPE)).tokensUsed, 1_043);
});

test("redis: the health report hides the keys themselves", { skip }, async (t) => {
  const book = newBook(newPrefix("health"));
  const keys = ["AIza-key-one", "AIza-key-two"];
  t.after(async () => {
    for (const key of keys) await book.reset(keyHash(key));
    await book.reset(GLOBAL_SCOPE);
  });

  const guard = new QuotaGuard(book);
  await guard.acquire(keys[0]!, 500);
  const report = await guard.report(keys);

  assert.equal(report.global.tokensUsed, 500);
  assert.equal(report.keys.length, 2);
  for (const entry of report.keys) {
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
    assert.ok(!entry.hash.includes("AIza"));
  }
  assert.equal(report.keys[0]!.tokensUsed, 500);
  assert.equal(report.keys[1]!.tokensUsed, 0);
});
