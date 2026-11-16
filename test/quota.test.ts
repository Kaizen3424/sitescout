import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOBAL_SCOPE,
  MemoryQuotaBook,
  QuotaGuard,
  estimateInputTokens,
  keyHash,
  millisecondsUntilPacificMidnight,
  usageInputTokens,
  type QuotaLimits,
} from "../api/_lib/quota.js";

const LIMITS: QuotaLimits = {
  tokensPerKey: 1_000,
  requestsPerKey: 10,
  tokensTotal: 1_500,
  requestsTotal: 20,
};

test("keyHash hides the key and stays stable", () => {
  const a = keyHash("AIza-key-one");
  const b = keyHash("AIza-key-one");
  const c = keyHash("AIza-key-two");

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes("AIza"));
});

test("a reservation that fits is allowed and counted", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const scope = keyHash("key-a");

  const first = await book.reserve(scope, 400);
  assert.equal(first.allowed, true);
  assert.equal(first.tokensUsed, 400);
  assert.equal(first.requestsUsed, 1);

  const snapshot = await book.snapshot(scope);
  assert.equal(snapshot.tokensUsed, 400);
  assert.equal(snapshot.requestsUsed, 1);
  assert.equal(snapshot.cooldownUntil, 0);
});

test("the per-key token budget blocks the next call", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const scope = keyHash("key-a");

  assert.equal((await book.reserve(scope, 800)).allowed, true);

  const blocked = await book.reserve(scope, 300);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.waitMs > 0);
  // Nothing was booked by the refused attempt.
  assert.equal((await book.snapshot(scope)).tokensUsed, 800);
});

test("the requests budget blocks a burst of cheap calls", async () => {
  const book = new MemoryQuotaBook({ ...LIMITS, requestsPerKey: 3, tokensPerKey: 100_000 });
  const scope = keyHash("key-a");

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await book.reserve(scope, 1)).allowed, true, `call ${i + 1} should fit`);
  }
  const blocked = await book.reserve(scope, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.requestsUsed, 3);
});

test("release refunds a reservation completely", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const scope = keyHash("key-a");

  const held = await book.reserve(scope, 900);
  assert.equal((await book.reserve(scope, 900)).allowed, false);

  await book.release(held);

  const after = await book.snapshot(scope);
  assert.equal(after.tokensUsed, 0);
  assert.equal(after.requestsUsed, 0);
  assert.equal((await book.reserve(scope, 900)).allowed, true);
});

test("commit keeps the request but corrects the tokens", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const scope = keyHash("key-a");

  const held = await book.reserve(scope, 900);
  await book.commit(held, 250);

  const after = await book.snapshot(scope);
  assert.equal(after.tokensUsed, 250);
  assert.equal(after.requestsUsed, 1, "the call did happen, so it still counts");
});

test("a cooldown blocks the scope until it expires", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const scope = keyHash("key-a");

  await book.setCooldown(scope, Date.now() + 5_000);
  const blocked = await book.reserve(scope, 100);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.waitMs > 1_000 && blocked.waitMs <= 5_000);

  // A different key is unaffected.
  assert.equal((await book.reserve(keyHash("key-b"), 100)).allowed, true);

  await book.setCooldown(scope, Date.now() - 1);
  assert.equal(await book.cooldownRemaining(scope), 0);
  assert.equal((await book.reserve(scope, 100)).allowed, true);
});

test("the global budget covers every key together", async () => {
  const book = new MemoryQuotaBook(LIMITS);

  assert.equal((await book.reserve(GLOBAL_SCOPE, 800)).allowed, true);
  assert.equal((await book.reserve(GLOBAL_SCOPE, 800)).allowed, false, "1500 token cap");
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 800);
});

test("the guard refunds the global budget when the key budget refuses", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const guard = new QuotaGuard(book);
  const key = "AIza-key-one";

  const first = await guard.acquire(key, 800);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // 800 + 300 breaks the per-key budget (1000) but would fit the global one.
  const second = await guard.acquire(key, 300);
  assert.equal(second.ok, false);
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 800, "no leaked global tokens");

  await guard.abandon(first.grant);
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 0);
  assert.equal((await book.snapshot(keyHash(key))).tokensUsed, 0);
});

test("the guard settles on the tokens the model reported", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const guard = new QuotaGuard(book);
  const key = "AIza-key-one";

  const attempt = await guard.acquire(key, 700);
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;

  const used = await guard.settle(attempt.grant, { total_input_tokens: 1_043 }, 700);
  assert.equal(used, 1_043);
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 1_043);
  assert.equal(guard.learnedTokens(key), 1_043);
  assert.equal((await book.snapshot(keyHash(key))).requestsUsed, 1);
});

test("a rate limited key cools down without touching the other keys", async () => {
  const book = new MemoryQuotaBook(LIMITS);
  const guard = new QuotaGuard(book);
  const key = "AIza-key-one";

  await guard.noteRateLimited(key, { retryAfterMs: 30_000, scope: "minute" });
  assert.equal(await guard.available(key), false);
  assert.equal(await guard.available("AIza-key-two"), true);
  assert.equal((await book.snapshot(GLOBAL_SCOPE)).tokensUsed, 0, "the global budget is untouched");
});

test("estimateInputTokens never goes below the image cost", () => {
  const empty = estimateInputTokens({ textChars: 0, resolution: "high" });
  assert.ok(empty >= 1_150);

  const text = estimateInputTokens({ textChars: 3_000, resolution: "high" });
  assert.equal(text, 1_000 + 1_150);

  const learned = estimateInputTokens({ textChars: 0, resolution: "high", observed: 5_680 });
  assert.equal(learned, 5_680, "a measured value wins over the estimate");

  const unknown = estimateInputTokens({ textChars: 0, resolution: "nonsense" });
  assert.equal(unknown, 1_150, "an unknown resolution falls back to high");
});

test("usageInputTokens reads the shapes Google uses", () => {
  assert.equal(usageInputTokens({ total_input_tokens: 1_043 }), 1_043);
  assert.equal(usageInputTokens({ prompt_token_count: 615 }), 615);
  assert.equal(usageInputTokens({ input_tokens: 796 }), 796);
  assert.equal(usageInputTokens({}), null);
  assert.equal(usageInputTokens(null), null);
  assert.equal(usageInputTokens("nonsense"), null);
});

test("the daily reset is midnight in California, not UTC", () => {
  // 08:00 UTC on 15 Nov 2026 is exactly midnight PST.
  const atMidnightPst = Date.parse("2026-11-15T08:00:00Z");
  assert.equal(millisecondsUntilPacificMidnight(atMidnightPst), 24 * 3_600_000);

  // 20:00 UTC on 15 July 2026 is 13:00 PDT, so eleven hours to go.
  const summer = Date.parse("2026-07-15T20:00:00Z");
  assert.equal(millisecondsUntilPacificMidnight(summer), 11 * 3_600_000);

  // Never a negative or silly-small delay, whatever the clock says.
  const delay = millisecondsUntilPacificMidnight();
  assert.ok(delay >= 60_000);
  assert.ok(delay <= 25 * 3_600_000);
});
