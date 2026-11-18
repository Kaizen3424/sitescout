/**
 * The permanent lists against a real Upstash Redis.
 *
 * Every test uses a random namespace, so nothing else in the database is read
 * or written. Skipped when no credentials are available, like the job tests.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { Redis } from "@upstash/redis";

import { createJob, readJobEntries, saveReport, type JobConfig } from "../api/_lib/jobs.js";
import {
  ListStore,
  type ListSettings,
} from "../api/_lib/lists.js";
import type { Report } from "../api/_lib/types.js";

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
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = token;
}

const skip = url && token ? false : "no Upstash Redis credentials available";
const redis = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;

const JOB_CONFIG: JobConfig = {
  maxUrls: 50,
  ttlSeconds: 120,
  origin: "http://127.0.0.1:3000",
  concurrency: 5,
  jobsPerHourPerIp: 8,
  dailyUrlBudget: 500,
  inline: false,
  qstash: { baseUrl: "https://qstash.upstash.io", token: "test-token" },
  signing: { current: "sig_current", next: "sig_next" },
};

const BASE: ListSettings = {
  key: "",
  management: "open",
  maxLists: 5,
  maxSitesPerList: 50,
  maxSitesTotal: 100,
  historyRuns: 5,
  readsPerHour: 100,
  importsPerHour: 100,
  writesPerHour: 100,
};

/** A fresh namespace per test, cleaned up with a single KEYS/DEL afterwards. */
function makeStore(overrides: Partial<ListSettings> = {}): {
  store: ListStore;
  cleanup: () => Promise<void>;
} {
  const namespace = `ss:list:test:${randomBytes(8).toString("hex")}`;
  assert.ok(redis);
  const store = new ListStore(redis, { ...BASE, ...overrides }, namespace);
  const cleanup = async (): Promise<void> => {
    if (!redis) return;
    // The namespace is unique to this test, so KEYS cannot touch anything else.
    const keys = (await redis.keys(`${namespace}:*`)) as string[];
    if (keys.length > 0) {
      for (let index = 0; index < keys.length; index += 100) {
        await redis.del(...keys.slice(index, index + 100));
      }
    }
  };
  return { store, cleanup };
}

function report(overrides: Partial<Record<string, unknown>> = {}): Report {
  return {
    input_url: "https://www.example-bakery.nl",
    final_url: "https://www.example-bakery.nl/",
    analyzed_at: "2026-11-18T10:00:00Z",
    verdict: "REACH_OUT",
    reasons: ["The design looks dated."],
    warnings: [],
    need_score: 0.8,
    design_quality: 0.2,
    scores: {
      visual: { score_0_to_10: 2.1 },
      navigation: { score_0_to_10: 4.2 },
      credibility: { score_0_to_10: 3.3 },
    },
    category: { name: "bakery" },
    design_era: { name: "2010s" },
    signals: { platform: "wordpress" },
    contact: { emails: ["hello@example-bakery.nl"], phones: [] },
    ...overrides,
  } as unknown as Report;
}

async function jobWithReports(reports: Report[]): Promise<string> {
  const urls = reports.map((entry) => String(entry["input_url"]));
  const job = await createJob(urls, false, JOB_CONFIG);
  for (let index = 0; index < reports.length; index += 1) {
    await saveReport(job.id, index, reports[index]!, JOB_CONFIG);
  }
  return job.id;
}

test("redis lists: create, read, rename and delete", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);

  const list = await store.createList({ name: "Amsterdam bakeries", description: "Nov 2026" });
  assert.equal(list.name, "Amsterdam bakeries");
  assert.equal(list.visibility, "public");

  const read = await store.readList(list.id);
  assert.equal(read?.name, "Amsterdam bakeries");
  assert.equal((await store.readLists()).length, 1);

  const renamed = await store.updateList(list.id, { name: "Amsterdam bread", visibility: "unlisted" });
  assert.equal(renamed.name, "Amsterdam bread");
  assert.equal(renamed.visibility, "unlisted");
  assert.equal((await store.readLists())[0]?.name, "Amsterdam bread");

  await assert.rejects(store.createList({ name: "amsterdam bread" }), /already a list/);

  await store.deleteList(list.id);
  assert.equal(await store.readList(list.id), null);
  assert.equal((await store.readLists()).length, 0);
});

test("redis lists: a batch imports, then only the new reports", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });

  const first = report({ input_url: "https://a.example", final_url: "https://a.example/" });
  const second = report({ input_url: "https://b.example", final_url: "https://b.example/" });
  const job = await createJob(["https://a.example", "https://b.example"], false, JOB_CONFIG);
  t.after(async () => {
    await redis?.del(`ss:job:${job.id}`, `ss:job:${job.id}:r`);
  });
  await saveReport(job.id, 0, first, JOB_CONFIG);

  const entries = await readJobEntries(job.id);
  assert.equal(entries.length, 1);

  const partial = await store.importJob(list.id, job.id, entries, {
    createdAt: new Date().toISOString(),
    total: 2,
    firstUrl: "https://a.example",
  });
  assert.deepEqual(partial.counts, { added: 1, updated: 0, unchanged: 0, failed: 0 });
  assert.equal(await store.siteCount(list.id), 1);

  await saveReport(job.id, 1, second, JOB_CONFIG);
  const rest = await store.importJob(list.id, job.id, await readJobEntries(job.id), {
    createdAt: new Date().toISOString(),
    total: 2,
  });
  assert.deepEqual(rest.counts, { added: 1, updated: 0, unchanged: 1, failed: 0 });
  assert.deepEqual(rest.record.imported, [0, 1]);

  const again = await store.importJob(list.id, job.id, await readJobEntries(job.id), {
    createdAt: new Date().toISOString(),
    total: 2,
  });
  assert.deepEqual(again.counts, { added: 0, updated: 0, unchanged: 2, failed: 0 });
  assert.equal(await store.siteCount(list.id), 2);

  const summaries = await store.readSummaries(list.id);
  const firstRow = summaries.find((entry) => entry.key === "a.example");
  assert.equal(firstRow?.verdict, "REACH_OUT");
  assert.equal(firstRow?.runs, 1);
  assert.deepEqual(firstRow?.batches, [job.id]);

  const detail = await store.readSite(list.id, "a.example");
  assert.equal(detail?.report?.["input_url"], "https://a.example");
  assert.equal(detail?.history.length, 1);
  assert.equal(detail?.history[0]?.batch, job.id);
});

test("redis lists: an older report does not replace a newer profile", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });

  const newer = report({
    analyzed_at: "2026-11-20T10:00:00Z",
    need_score: 0.9,
    input_url: "https://a.example",
    final_url: "https://a.example/",
  });
  const older = report({
    analyzed_at: "2026-11-01T10:00:00Z",
    need_score: 0.1,
    input_url: "https://a.example",
    final_url: "https://a.example/",
  });

  await store.importReports(list.id, [newer]);
  const after = await store.importReports(list.id, [older]);
  assert.equal(after.counts.updated, 1, "the run is still recorded");

  const detail = await store.readSite(list.id, "a.example");
  assert.equal(detail?.summary.need, 0.9);
  assert.equal(detail?.summary.runs, 2);
  assert.equal(detail?.history.length, 2);
  assert.equal(detail?.history[0]?.at, "2026-11-20T10:00:00.000Z");
  assert.equal(detail?.report?.["need_score"], 0.9);
});

test("redis lists: remove a site, re-add the batch restores it", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });
  const job = await jobWithReports([report()]);
  t.after(async () => {
    await redis?.del(`ss:job:${job}`, `ss:job:${job}:r`);
  });

  await store.importJob(list.id, job, await readJobEntries(job), {
    createdAt: new Date().toISOString(),
    total: 1,
  });
  assert.equal(await store.siteCount(list.id), 1);

  await store.removeSite(list.id, "example-bakery.nl");
  assert.equal(await store.siteCount(list.id), 0);
  assert.equal(await store.readSite(list.id, "example-bakery.nl"), null);

  const restored = await store.importJob(list.id, job, await readJobEntries(job), {
    createdAt: new Date().toISOString(),
    total: 1,
  });
  assert.deepEqual(restored.counts, { added: 1, updated: 0, unchanged: 0, failed: 0 });
  assert.equal(await store.siteCount(list.id), 1);
});

test("redis lists: clear removes every site but keeps the list", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });
  await store.importReports(list.id, [
    report({ input_url: "https://a.example", final_url: "https://a.example/" }),
    report({ input_url: "https://b.example", final_url: "https://b.example/" }),
  ]);

  assert.equal(await store.clearList(list.id), 2);
  assert.equal(await store.siteCount(list.id), 0);
  assert.ok(await store.readList(list.id), "the list itself is still there");
});

test("redis lists: the cap is checked before anything is written", { skip }, async (t) => {
  const { store, cleanup } = makeStore({ maxSitesPerList: 1 });
  t.after(cleanup);
  const list = await store.createList({ name: "One" });

  await assert.rejects(
    store.importReports(list.id, [
      report({ input_url: "https://a.example", final_url: "https://a.example/" }),
      report({ input_url: "https://b.example", final_url: "https://b.example/" }),
    ]),
    /list is full/,
  );
  assert.equal(await store.siteCount(list.id), 0, "nothing was half-written");
});

test("redis lists: an import lock blocks a second import", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });
  assert.ok(redis);

  await redis.set(`${store.namespace}:lock`, "someone-else", { px: 10_000 });

  await assert.rejects(
    store.importReports(list.id, [report()]),
    /Another import is running/,
  );
  await redis.del(`${store.namespace}:lock`);
  const ok = await store.importReports(list.id, [report()]);
  assert.equal(ok.counts.added, 1);
});

test("redis lists: the per-IP rate limit counts and refuses", { skip }, async (t) => {
  const { store, cleanup } = makeStore({ readsPerHour: 2 });
  t.after(cleanup);

  await store.checkRate("read", "203.0.113.9");
  await store.checkRate("read", "203.0.113.9");
  await assert.rejects(store.checkRate("read", "203.0.113.9"), /Too many list requests/);
  // A different address and a different kind have their own counter.
  await store.checkRate("read", "203.0.113.10");
  await store.checkRate("write", "203.0.113.9");
});

test("redis lists: status, bulk status and removal", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const list = await store.createList({ name: "One" });
  await store.importReports(list.id, [
    report({ input_url: "https://a.example", final_url: "https://a.example/" }),
    report({ input_url: "https://b.example", final_url: "https://b.example/" }),
  ]);

  const updated = await store.updateSite(list.id, "a.example", {
    status: "contacted",
    notes: "Emailed 18 Nov.",
    tags: ["bakery"],
  });
  assert.equal(updated.status, "contacted");
  assert.equal(updated.notes, "Emailed 18 Nov.");

  assert.equal(await store.setStatusMany(list.id, ["a.example", "b.example"], "follow_up"), 2);
  const summaries = await store.readSummaries(list.id);
  assert.deepEqual(summaries.map((entry) => entry.status).sort(), ["follow_up", "follow_up"]);

  assert.equal(await store.removeSites(list.id, ["a.example", "b.example"]), 2);
  assert.equal(await store.siteCount(list.id), 0);
});

test("redis lists: a backup restores status, notes and history", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);
  const source = await store.createList({ name: "Source" });
  await store.importReports(source.id, [
    report({ input_url: "https://a.example", final_url: "https://a.example/" }),
  ]);
  await store.updateSite(source.id, "a.example", {
    status: "won",
    notes: "Signed in December.",
    tags: ["keep"],
  });
  const detail = await store.readSite(source.id, "a.example");
  assert.ok(detail);

  const target = await store.createList({ name: "Source (restored)" });
  const restored = await store.restore(target.id, [detail], []);
  assert.deepEqual(restored, { restored: 1, skipped: 0 });

  const copy = await store.readSite(target.id, "a.example");
  assert.equal(copy?.summary.status, "won");
  assert.equal(copy?.summary.notes, "Signed in December.");
  assert.deepEqual(copy?.summary.tags, ["keep"]);
  assert.equal(copy?.history.length, 1);
  assert.equal(copy?.report?.["input_url"], "https://a.example");

  const again = await store.restore(target.id, [detail], []);
  assert.deepEqual(again, { restored: 0, skipped: 1 }, "restoring twice is safe");
});

test("redis lists: registered batches feed the picker", { skip }, async (t) => {
  const { store, cleanup } = makeStore();
  t.after(cleanup);

  await store.registerJob({
    id: "Rw5c_3o4j3geFU741_nl0A",
    createdAt: "2026-11-18T10:00:00Z",
    total: 12,
    firstUrl: "https://a.example",
  });
  await store.registerJob({
    id: "Xy7c_3o4j3geFU741_nl0B",
    createdAt: "2026-11-19T10:00:00Z",
    total: 3,
    firstUrl: "https://b.example",
  });

  const jobs = await store.readJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.id, "Xy7c_3o4j3geFU741_nl0B", "newest first");
});
