/**
 * The job lifecycle against a real Upstash Redis: claims, quota deferrals and
 * the "is this batch stuck?" rule.
 *
 * Skipped without credentials. Every test writes a freshly generated job id and
 * deletes its keys afterwards, so nothing else in the database is touched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Redis } from "@upstash/redis";

import {
  bumpAttempt,
  claimItem,
  clearAttempts,
  clearWaiting,
  createJob,
  markWaiting,
  readJob,
  readWaiting,
  releaseClaim,
  saveReport,
  type JobConfig,
} from "../api/_lib/jobs.js";
import { baseReport } from "../api/_lib/report.js";

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

if (url && token) {
  // jobs.ts reads the credentials from the environment itself.
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = token;
}

const skip = url && token ? false : "no Upstash Redis credentials available";
const redis = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;

const CONFIG: JobConfig = {
  maxUrls: 50,
  ttlSeconds: 120,
  origin: "http://127.0.0.1:3000",
  concurrency: 5,
  jobsPerHourPerIp: 8,
  dailyUrlBudget: 500,
  inline: false,
  // Filled in so the type matches; these tests never publish anything.
  qstash: { baseUrl: "https://qstash.upstash.io", token: "test-token" },
  signing: { current: "sig_current", next: "sig_next" },
};

/** Removes every key a test job can create. */
async function dropJob(id: string): Promise<void> {
  if (!redis) return;
  await redis.del(`ss:job:${id}`, `ss:job:${id}:r`, `ss:job:${id}:a`, `ss:job:${id}:w`);
  for (let index = 0; index < 5; index += 1) {
    await redis.del(`ss:job:${id}:claim:${index}`);
  }
}

function report(reportUrl: string) {
  return { ...baseReport(reportUrl), verdict: "SKIP" as const };
}

test("redis jobs: a claim belongs to one worker at a time", { skip }, async (t) => {
  const job = await createJob(["https://example.com"], false, CONFIG);
  t.after(() => dropJob(job.id));

  assert.equal(await claimItem(job.id, 0), true, "first worker wins");
  assert.equal(await claimItem(job.id, 0), false, "a second delivery is turned away");

  await releaseClaim(job.id, 0);
  assert.equal(await claimItem(job.id, 0), true, "the claim is free again after release");
  await releaseClaim(job.id, 0);
});

test("redis jobs: a waiting URL is visible but does not offer a retry", { skip }, async (t) => {
  const job = await createJob(["https://example.com", "https://example.org"], false, CONFIG);
  t.after(() => dropJob(job.id));

  const due = Date.now() + 60_000;
  await markWaiting(job.id, 0, due, CONFIG.ttlSeconds);

  const view = await readJob(job.id, CONFIG);
  assert.ok(view);
  assert.equal(view.waiting, 1);
  assert.ok(view.next_retry_at, "the page can show a countdown");
  assert.ok(Math.abs(Date.parse(view.next_retry_at!) - due) < 1_000);
  assert.equal(view.canRetry, false, "never restart a batch that is waiting");

  await clearWaiting(job.id, 0);
  assert.equal((await readJob(job.id, CONFIG))!.waiting, 0);
});

test("redis jobs: a waiting entry whose retry was lost stops blocking", { skip }, async (t) => {
  const job = await createJob(["https://example.com"], false, CONFIG);
  t.after(() => dropJob(job.id));

  // The delayed message never arrived: the due time is far in the past.
  await markWaiting(job.id, 0, Date.now() - 90 * 60_000, CONFIG.ttlSeconds);

  assert.deepEqual(await readWaiting(job.id), {}, "a stale entry is ignored");
  const view = await readJob(job.id, CONFIG);
  assert.equal(view!.waiting, 0);
});

test("redis jobs: attempts count up and reset when the URL finishes", { skip }, async (t) => {
  const job = await createJob(["https://example.com"], false, CONFIG);
  t.after(() => dropJob(job.id));

  assert.equal(await bumpAttempt(job.id, 0, CONFIG.ttlSeconds), 1);
  assert.equal(await bumpAttempt(job.id, 0, CONFIG.ttlSeconds), 2);
  assert.equal(await bumpAttempt(job.id, 0, CONFIG.ttlSeconds), 3);
  assert.equal(await bumpAttempt(job.id, 1, CONFIG.ttlSeconds), 1, "attempts are per URL");

  await saveReport(job.id, 0, report("https://example.com"), CONFIG);
  assert.equal(await bumpAttempt(job.id, 0, CONFIG.ttlSeconds), 1, "the history is gone");

  await clearAttempts(job.id, 1);
  assert.equal(await bumpAttempt(job.id, 1, CONFIG.ttlSeconds), 1);
});

test("redis jobs: the last report completes the batch and clears the wait", { skip }, async (t) => {
  const urls = ["https://example.com", "https://example.org"];
  const job = await createJob(urls, false, CONFIG);
  t.after(() => dropJob(job.id));

  await markWaiting(job.id, 1, Date.now() + 30_000, CONFIG.ttlSeconds);

  const first = await saveReport(job.id, 0, report(urls[0]!), CONFIG);
  assert.deepEqual(first, { done: 1, total: 2, complete: false });

  const view = await readJob(job.id, CONFIG);
  assert.equal(view!.done, 1);
  assert.equal(view!.waiting, 1, "the other URL is still waiting");

  const last = await saveReport(job.id, 1, report(urls[1]!), CONFIG);
  assert.deepEqual(last, { done: 2, total: 2, complete: true });

  const done = await readJob(job.id, CONFIG);
  assert.equal(done!.status, "completed");
  assert.equal(done!.waiting, 0, "finishing a URL clears its waiting entry");
  assert.equal(done!.canRetry, false);
  assert.equal(done!.results.length, 2);
});

test("redis jobs: a batch whose first report is old is not stuck while another waits", {
  skip,
}, async (t) => {
  const urls = ["https://example.com", "https://example.org"];
  const job = await createJob(urls, false, CONFIG);
  t.after(() => dropJob(job.id));

  // One report landed a minute ago; the second URL is waiting for quota.
  await saveReport(job.id, 0, report(urls[0]!), CONFIG);
  await markWaiting(job.id, 1, Date.now() + 5 * 60_000, CONFIG.ttlSeconds);

  const view = await readJob(job.id, CONFIG);
  assert.equal(view!.waiting, 1);
  assert.equal(view!.canRetry, false);
});
