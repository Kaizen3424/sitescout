/**
 * The list routes through the real handler.
 *
 * The store tests cover the data layer; this one covers the wiring: the
 * `__route` parameters Vercel uses, the optional management key, what a visitor
 * without the key may see, and the CSV download.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import api from "../api/index.js";
import { resetListSettings, resetListStore } from "../api/_lib/lists.js";
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
const KEY = "test-management-key-0123456789";

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  text: string;
}

async function call(
  route: string,
  params: Record<string, string> = {},
  options: { method?: string; body?: unknown; key?: string | null } = {},
): Promise<Answer> {
  const target = new URL("http://localhost/api");
  target.searchParams.set("__route", route);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key) headers["x-sitescout-list-key"] = options.key;
  const response = await api.fetch(
    new Request(target, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await response.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data, text };
}

function report(): Report {
  return {
    input_url: "https://www.api-smoke-bakery.nl",
    final_url: "https://www.api-smoke-bakery.nl/",
    analyzed_at: "2026-11-18T10:00:00Z",
    verdict: "REACH_OUT",
    reasons: ["The design is dated."],
    warnings: [],
    need_score: 0.81,
    design_quality: 0.19,
    scores: {
      visual: { score_0_to_10: 2.4 },
      navigation: { score_0_to_10: 4.1 },
      credibility: { score_0_to_10: 3.2 },
    },
    category: { name: "bakery" },
    design_era: { name: "2010s" },
    signals: { platform: "wordpress" },
    contact: { emails: ["hello@api-smoke-bakery.nl"], phones: [] },
  } as unknown as Report;
}

test("api lists: key, import, owner view, public view, csv and delete", { skip }, async (t) => {
  process.env.SITESCOUT_LIST_KEY = KEY;
  resetListSettings();
  resetListStore();

  let listId = "";
  t.after(async () => {
    if (listId) await call("list", { listId }, { method: "DELETE", key: KEY });
    delete process.env.SITESCOUT_LIST_KEY;
    resetListSettings();
    resetListStore();
  });

  const name = `API smoke ${Date.now()}`;

  const anonymous = await call("lists", {}, { method: "POST", body: { name } });
  assert.equal(anonymous.status, 401, "creating a list needs the key");

  const created = await call("lists", {}, { method: "POST", body: { name }, key: KEY });
  assert.equal(created.status, 201);
  listId = String((created.data?.list as Record<string, unknown>).id);
  assert.match(listId, /^[A-Za-z0-9_-]{20,32}$/);

  const imported = await call(
    "lists_reports",
    {},
    { method: "POST", body: { reports: [report()], listIds: [listId] }, key: KEY },
  );
  assert.equal(imported.status, 200);
  const results = imported.data?.results as Record<string, unknown>[];
  assert.equal(results[0]?.added, 1);

  const publicRead = await call("list", { listId });
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.data?.owner, false);
  const publicSites = publicRead.data?.sites as Record<string, unknown>[];
  assert.equal(publicSites.length, 1);
  assert.equal(publicSites[0]?.host, "api-smoke-bakery.nl");
  assert.equal(publicSites[0]?.email, undefined, "contact routes are private");
  assert.equal(publicSites[0]?.notes, undefined);
  assert.equal(publicRead.data?.batches, undefined, "batch history is private");

  const ownerRead = await call("list", { listId }, { key: KEY });
  assert.equal(ownerRead.data?.owner, true);
  const ownerSites = ownerRead.data?.sites as Record<string, unknown>[];
  assert.equal(ownerSites[0]?.email, "hello@api-smoke-bakery.nl");
  assert.equal(ownerSites[0]?.status, "new");

  const wrongKey = await call("list", { listId }, { key: "not-the-key-at-all-0123456789" });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.data?.code, "bad_key");

  const edited = await call(
    "list_site",
    { listId, siteKey: "api-smoke-bakery.nl" },
    {
      method: "PATCH",
      body: { status: "contacted", notes: "Called on Tuesday.", tags: ["bakery"] },
      key: KEY,
    },
  );
  assert.equal(edited.status, 200);
  const editedSite = edited.data?.site as Record<string, unknown>;
  assert.equal(editedSite.status, "contacted");
  assert.equal(editedSite.notes, "Called on Tuesday.");

  const detail = await call(
    "list_site",
    { listId, siteKey: "api-smoke-bakery.nl" },
    { key: KEY },
  );
  assert.equal(detail.status, 200);
  const site = detail.data?.site as Record<string, unknown>;
  const summary = site.summary as Record<string, unknown>;
  const history = site.history as Record<string, unknown>[];
  const full = site.report as Record<string, unknown>;
  assert.equal(summary.notes, "Called on Tuesday.");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.verdict, "REACH_OUT");
  assert.equal(full.input_url, "https://www.api-smoke-bakery.nl");

  const publicDetail = await call("list_site", { listId, siteKey: "api-smoke-bakery.nl" });
  const publicSite = publicDetail.data?.site as Record<string, unknown>;
  assert.equal((publicSite.summary as Record<string, unknown>).notes, undefined);
  assert.equal(publicSite.report && (publicSite.report as Record<string, unknown>).contact, undefined);

  const csv = await call("list_csv", { listId }, { key: KEY });
  assert.equal(csv.status, 200);
  // `Response.text()` strips a leading BOM, so the model test checks that part.
  assert.ok(csv.text.includes('"host"'));
  assert.ok(csv.text.includes('"api-smoke-bakery.nl"'));
  assert.ok(csv.text.includes('"contacted"'));

  const anonymousCsv = await call("list_csv", { listId });
  assert.equal(anonymousCsv.status, 401, "the owner's working data stays private");

  const deleted = await call("list", { listId }, { method: "DELETE", key: KEY });
  assert.equal(deleted.status, 200);
  const gone = await call("list", { listId }, { key: KEY });
  assert.equal(gone.status, 404);
  listId = "";
});

test("api lists: a list with no key config is open, private lists are refused", { skip }, async (t) => {
  delete process.env.SITESCOUT_LIST_KEY;
  resetListSettings();
  resetListStore();

  let listId = "";
  t.after(async () => {
    if (listId) await call("list", { listId }, { method: "DELETE" });
  });

  const created = await call("lists", {}, {
    method: "POST",
    body: { name: `Open smoke ${Date.now()}`, visibility: "public" },
  });
  assert.equal(created.status, 201, "no key configured means the link is the secret");
  listId = String((created.data?.list as Record<string, unknown>).id);

  const open = await call("list", { listId });
  assert.equal(open.data?.owner, true);

  const privateAttempt = await call("list", { listId }, {
    method: "PATCH",
    body: { visibility: "private" },
  });
  assert.equal(privateAttempt.status, 400);
  assert.match(String(privateAttempt.data?.error), /SITESCOUT_LIST_KEY/);

  await call("list", { listId }, { method: "DELETE" });
  listId = "";
});
