/**
 * Reading Google's 429 answer.
 *
 * The difference between a per-minute and a per-day limit decides whether the
 * URL should come back in two minutes or wait for midnight Pacific, so it is
 * worth testing with the shapes Google really sends.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readQuotaSignal } from "../api/_lib/decisions.js";

function body(details: unknown[]): unknown {
  return {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota.",
      details,
    },
  };
}

function violation(quotaId: string, metric: string, value: string): unknown {
  return {
    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
    violations: [{ quotaId, quotaMetric: metric, quotaValue: value, quotaDimensions: {} }],
  };
}

test("a per-minute token limit is read as retryable in a minute", () => {
  const signal = readQuotaSignal(
    body([
      violation(
        "GenerateContentInputTokensPerModelPerMinute-FreeTier",
        "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",
        "50000",
      ),
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
    ]),
  );

  assert.equal(signal.scope, "minute");
  assert.equal(signal.retryAfterMs, 27_000);
  assert.equal(signal.quotaValue, 50_000);
  assert.match(signal.quotaId ?? "", /PerMinute/);
  assert.match(signal.metric ?? "", /input_token_count/);
});

test("a per-day limit waits for the daily reset instead of two minutes", () => {
  const signal = readQuotaSignal(
    body([
      violation(
        "GenerateContentRequestsPerDayPerProject-PerDay",
        "generativelanguage.googleapis.com/generate_content_free_tier_requests",
        "10000",
      ),
    ]),
  );

  assert.equal(signal.scope, "day");
  assert.ok(signal.retryAfterMs >= 60_000, "not a short retry");
});

test("a Retry-After header is used when the body is quiet", () => {
  const res = new Response("{}", { status: 429, headers: { "retry-after": "12" } });
  const signal = readQuotaSignal(null, res);
  assert.equal(signal.retryAfterMs, 12_000);
  assert.equal(signal.scope, "minute");
});

test("the body's retryDelay wins over the header", () => {
  const res = new Response("{}", { status: 429, headers: { "retry-after": "90" } });
  const signal = readQuotaSignal(
    body([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "45s" }]),
    res,
  );
  assert.equal(signal.retryAfterMs, 45_000);
});

test("a fractional delay is understood and never under a second", () => {
  const signal = readQuotaSignal(
    body([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.4s" }]),
  );
  assert.equal(signal.retryAfterMs, 5_000, "clamped to a sane minimum");
});

test("minutes-and-seconds delays are understood", () => {
  const signal = readQuotaSignal(
    body([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1m30s" }]),
  );
  assert.equal(signal.retryAfterMs, 90_000);
});

test("nonsense stays a minute instead of throwing", () => {
  for (const payload of [null, "nonsense", {}, { error: {} }, { error: { details: "x" } }]) {
    const signal = readQuotaSignal(payload);
    assert.equal(signal.scope, "minute");
    assert.equal(signal.retryAfterMs, 60_000);
    assert.equal(signal.quotaId, null);
  }
});

test("an absurd RetryInfo is capped", () => {
  const signal = readQuotaSignal(
    body([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9999s" }]),
  );
  assert.equal(signal.retryAfterMs, 15 * 60_000, "a minute limit never parks a URL for hours");
});
