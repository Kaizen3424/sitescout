/**
 * Permanent lists.
 *
 * A batch is a run: it lives for a few weeks and then disappears. A list is
 * the opposite: one row per domain, kept until you remove it, with the latest
 * full report plus a short history of earlier checks.
 *
 * Nothing enters a list by itself. The page calls `importJob` (a finished
 * batch) or `importReports` (a CLI `report.json`) when you press Add.
 *
 * Redis layout (all keys share the namespace, `ss:list` in production):
 *   <ns>:registry                 hash  listId -> list meta JSON
 *   <ns>:jobs                     hash  batchId -> compact batch record
 *   <ns>:lock                     string  import lock
 *   <ns>:rate:<kind>:<ip>:<hour>  counter per-IP limits
 *   <ns>:<id>:summaries           hash  siteKey -> summary JSON
 *   <ns>:<id>:reports             hash  siteKey -> latest full report JSON
 *   <ns>:<id>:history             hash  siteKey -> JSON array of runs
 *   <ns>:<id>:batches             hash  batchId -> import record
 *
 * List data has no TTL. The caps in `listSettings()` are what keep it inside
 * the free Upstash plan; the JSON export is the backup.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "@upstash/redis";

import { ListError } from "./errors.js";
import { getRedis, toRecord } from "./redis.js";
import type { Report, Verdict } from "./types.js";

/* ------------------------------------------------------------------ types */

export type ManagementMode = "open" | "key" | "disabled";
export type ListVisibility = "public" | "unlisted" | "private";
export type SiteStatus = "new" | "contacted" | "follow_up" | "won" | "no";
export type RunSource = "web" | "upload";

export const SITE_STATUSES: readonly SiteStatus[] = [
  "new",
  "contacted",
  "follow_up",
  "won",
  "no",
];
export const VISIBILITIES: readonly ListVisibility[] = ["public", "unlisted", "private"];

const VERDICTS: readonly Verdict[] = [
  "REACH_OUT",
  "MAYBE",
  "SKIP",
  "SITE_DOWN",
  "UNSCORED",
];
const SCORED = new Set<Verdict>(["REACH_OUT", "MAYBE", "SKIP"]);

/** Reports larger than this are refused instead of filling Redis. */
const MAX_REPORT_BYTES = 100_000;
/** How many batch ids a summary remembers for filtering. */
const MAX_SUMMARY_BATCHES = 20;
/** Registered batches kept for the "Add batch" picker. */
const MAX_REGISTERED_JOBS = 200;
/** Restore chunks are small, so one bad chunk cannot exceed the body limit. */
export const MAX_RESTORE_SITES = 15;
export const MAX_REPORT_IMPORTS = 25;
export const MAX_DETAIL_KEYS = 40;
export const MAX_BULK_KEYS = 500;

export interface ListSettings {
  /** Empty when management is open. */
  key: string;
  management: ManagementMode;
  maxLists: number;
  maxSitesPerList: number;
  maxSitesTotal: number;
  historyRuns: number;
  readsPerHour: number;
  importsPerHour: number;
  writesPerHour: number;
}

export interface ListMeta {
  id: string;
  name: string;
  description: string;
  visibility: ListVisibility;
  createdAt: string;
  updatedAt: string;
  schema: number;
}

export interface SiteSummary {
  v: number;
  key: string;
  host: string;
  url: string;
  inputUrl: string;
  name: string;
  title: string;
  verdict: Verdict;
  profileVerdict: Verdict | null;
  need: number | null;
  design: number | null;
  visual: number | null;
  navigation: number | null;
  credibility: number | null;
  category: string | null;
  era: string | null;
  platform: string | null;
  contactable: boolean;
  email: string | null;
  phone: string | null;
  profileAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptVerdict: Verdict | null;
  runs: number;
  needDelta: number | null;
  firstAddedAt: string;
  updatedAt: string;
  firstBatch: string | null;
  lastBatch: string | null;
  profileBatch: string | null;
  status: SiteStatus;
  statusAt: string;
  notes: string;
  tags: string[];
  attention: boolean;
  batches: string[];
}

export interface RunRecord {
  runId: string;
  at: string;
  verdict: Verdict;
  need: number | null;
  design: number | null;
  visual: number | null;
  navigation: number | null;
  credibility: number | null;
  category: string | null;
  era: string | null;
  reason: string;
  batch?: string;
  index?: number;
  source: RunSource;
}

export interface SiteDetail {
  summary: SiteSummary;
  report: Report | null;
  history: RunRecord[];
}

export interface ImportRecord {
  id: string;
  source: RunSource;
  createdAt: string;
  importedAt: string;
  total: number;
  imported: number[];
  added: number;
  updated: number;
  unchanged: number;
  label: string;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  total: number;
  firstUrl: string;
}

export interface ImportCounts {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface ImportResult {
  counts: ImportCounts;
  record: ImportRecord;
}

export interface JobEntryLike {
  index: number;
  report: Report;
}

/* ---------------------------------------------------------------- settings */

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

let cachedSettings: ListSettings | null = null;

export function listSettings(): ListSettings {
  if (cachedSettings) return cachedSettings;
  const key = env("SITESCOUT_LIST_KEY");
  const management: ManagementMode = !key ? "open" : key.length >= 24 ? "key" : "disabled";
  cachedSettings = {
    key,
    management,
    maxLists: clamp(envInt("SITESCOUT_LISTS_MAX", 20), 1, 100),
    maxSitesPerList: clamp(envInt("SITESCOUT_LIST_MAX_SITES", 2_000), 1, 20_000),
    maxSitesTotal: clamp(envInt("SITESCOUT_LISTS_MAX_SITES", 5_000), 1, 50_000),
    historyRuns: clamp(envInt("SITESCOUT_LIST_HISTORY_RUNS", 15), 1, 100),
    readsPerHour: clamp(envInt("SITESCOUT_LIST_READS_PER_HOUR", 600), 1, 100_000),
    importsPerHour: clamp(envInt("SITESCOUT_LIST_IMPORTS_PER_HOUR", 60), 1, 10_000),
    writesPerHour: clamp(envInt("SITESCOUT_LIST_WRITES_PER_HOUR", 300), 1, 10_000),
  };
  return cachedSettings;
}

export function resetListSettings(): void {
  cachedSettings = null;
}

export function isValidListId(id: string): boolean {
  return /^[A-Za-z0-9_-]{20,32}$/.test(id);
}

/* ------------------------------------------------------------ small utils */

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isoAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

function grade(report: Record<string, unknown>, key: string): number | null {
  return asNumber(asRecord(asRecord(report.scores)?.[key])?.["score_0_to_10"]);
}

function reasonOf(report: Record<string, unknown>): string {
  for (const entry of asArray(report.reasons)) {
    if (typeof entry === "string" && entry.trim()) return entry.trim();
  }
  return "";
}

function withBatch(batches: unknown, batch: string | null): string[] {
  const current = asArray(batches)
    .map((entry) => (typeof entry === "string" ? entry : ""))
    .filter(Boolean);
  if (!batch) return current.slice(0, MAX_SUMMARY_BATCHES);
  return [batch, ...current.filter((entry) => entry !== batch)].slice(0, MAX_SUMMARY_BATCHES);
}

/* --------------------------------------------------------------- identity */

/**
 * The stable identity of a site: the host of the final URL, lowercased, with
 * `www.` and a trailing dot removed. Subdomains stay separate on purpose.
 */
export function siteKeyOf(report: Report): string | null {
  const record = report as unknown as Record<string, unknown>;
  for (const value of [record["final_url"], record["input_url"]]) {
    const raw = asString(value);
    if (!raw) continue;
    let host = "";
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      host = parsed.hostname;
    } catch {
      continue;
    }
    host = host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
    if (!host || host.length > 253 || !host.includes(".")) continue;
    return host;
  }
  return null;
}

/* ---------------------------------------------------------------- merging */

interface Profile {
  need: number | null;
  design: number | null;
  visual: number | null;
  navigation: number | null;
  credibility: number | null;
  category: string | null;
  era: string | null;
  platform: string | null;
  contactable: boolean;
  email: string | null;
  phone: string | null;
}

function profileFromReport(report: Report): Profile {
  const record = report as unknown as Record<string, unknown>;
  const contact =
    asRecord(record["contact"]) ?? asRecord(asRecord(record["signals"])?.["contact"]);
  const emails = asArray(contact?.["emails"])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  const phones = asArray(contact?.["phones"])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  const contactable = Boolean(
    emails[0] ||
      phones[0] ||
      asString(contact?.["whatsapp"]) ||
      asString(contact?.["contact_page"]) ||
      asBoolean(contact?.["has_form"]) ||
      asString(contact?.["best"]),
  );
  return {
    need: asNumber(record["need_score"]),
    design: asNumber(record["design_quality"]),
    visual: grade(record, "visual"),
    navigation: grade(record, "navigation"),
    credibility: grade(record, "credibility"),
    category: asString(asRecord(record["category"])?.["name"]),
    era: asString(asRecord(record["design_era"])?.["name"]),
    platform: asString(asRecord(record["signals"])?.["platform"]),
    contactable,
    email: emails[0] ?? null,
    phone: phones[0] ?? null,
  };
}

function runFromReport(
  report: Report,
  verdict: Verdict,
  at: string,
  ctx: MergeContext,
): RunRecord {
  const record = report as unknown as Record<string, unknown>;
  return {
    runId: ctx.runId,
    at,
    verdict,
    need: asNumber(record["need_score"]),
    design: asNumber(record["design_quality"]),
    visual: grade(record, "visual"),
    navigation: grade(record, "navigation"),
    credibility: grade(record, "credibility"),
    category: asString(asRecord(record["category"])?.["name"]),
    era: asString(asRecord(record["design_era"])?.["name"]),
    reason: reasonOf(record).slice(0, 240),
    ...(ctx.batch ? { batch: ctx.batch } : {}),
    ...(ctx.index !== null ? { index: ctx.index } : {}),
    source: ctx.source,
  };
}

export interface MergeContext {
  runId: string;
  batch: string | null;
  index: number | null;
  source: RunSource;
  historyRuns: number;
}

export interface MergeState {
  summary: SiteSummary | null;
  history: RunRecord[];
}

export interface MergeResult {
  summary: SiteSummary;
  history: RunRecord[];
  added: boolean;
  addedRun: boolean;
  profileUpdated: boolean;
  /** True when this report is the one worth keeping in full. */
  writeReport: boolean;
  changed: boolean;
}

/**
 * Folds one report into the list's row for that site.
 *
 * Rules, in short:
 * - the newest attempt decides the displayed verdict, except that a failed
 *   re-check (`UNSCORED`) never replaces a good score; it raises `attention`;
 * - only a scored report can become the profile, and an older one never
 *   overwrites a newer profile;
 * - every attempt that is new is appended to the history (deduplicated by
 *   `runId`) and counted, even after the history cap drops it.
 */
export function mergeReport(
  existing: MergeState,
  report: Report,
  ctx: MergeContext,
): MergeResult | null {
  const key = siteKeyOf(report);
  if (!key) return null;

  const record = report as unknown as Record<string, unknown>;
  const at = isoAt(record["analyzed_at"]) ?? new Date().toISOString();
  const verdict: Verdict = isVerdict(record["verdict"]) ? record["verdict"] : "UNSCORED";
  const scored = SCORED.has(verdict);
  const previous = existing.summary;
  const added = previous === null;
  const now = new Date().toISOString();

  const history = [...existing.history];
  const duplicate = history.some((run) => run.runId === ctx.runId);
  let runs = previous?.runs ?? 0;
  if (!duplicate) {
    history.push(runFromReport(report, verdict, at, ctx));
    runs += 1;
  }
  history.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const kept = history.slice(0, Math.max(1, ctx.historyRuns));
  const latest = kept[0] ?? runFromReport(report, verdict, at, ctx);

  let profileVerdict = previous?.profileVerdict ?? null;
  let profileAt = previous?.profileAt ?? null;
  let values: Profile = {
    need: previous?.need ?? null,
    design: previous?.design ?? null,
    visual: previous?.visual ?? null,
    navigation: previous?.navigation ?? null,
    credibility: previous?.credibility ?? null,
    category: previous?.category ?? null,
    era: previous?.era ?? null,
    platform: previous?.platform ?? null,
    contactable: previous?.contactable ?? false,
    email: previous?.email ?? null,
    phone: previous?.phone ?? null,
  };
  let profileUpdated = false;

  if (scored) {
    const atMs = Date.parse(at);
    const currentMs = profileAt ? Date.parse(profileAt) : Number.NaN;
    if (!profileAt || !Number.isFinite(currentMs) || atMs >= currentMs) {
      const next = profileFromReport(report);
      const same =
        profileAt === at &&
        profileVerdict === verdict &&
        values.need === next.need &&
        values.design === next.design &&
        values.visual === next.visual &&
        values.navigation === next.navigation &&
        values.credibility === next.credibility &&
        values.category === next.category &&
        values.era === next.era &&
        values.platform === next.platform &&
        values.contactable === next.contactable &&
        values.email === next.email &&
        values.phone === next.phone;
      if (!same) {
        profileUpdated = true;
        profileVerdict = verdict;
        profileAt = at;
        values = next;
      }
    }
  }

  // A failed re-check keeps the last good verdict on display; a site that is
  // down shows that instead, because it changes what you would say to them.
  let display = latest.verdict;
  if (display === "UNSCORED" && profileVerdict) display = profileVerdict;

  let needDelta = previous?.needDelta ?? null;
  if (profileUpdated) {
    needDelta =
      previous?.need !== null && previous?.need !== undefined && values.need !== null
        ? round(values.need - previous.need)
        : null;
  }

  const changed = added || !duplicate || profileUpdated;
  const latestIsThisRun = latest.runId === ctx.runId;
  const summary: SiteSummary = {
    v: 1,
    key,
    host: key,
    url: asString(record["final_url"]) ?? previous?.url ?? asString(record["input_url"]) ?? key,
    inputUrl: asString(record["input_url"]) ?? previous?.inputUrl ?? key,
    name: asString(asRecord(record["business"])?.["name"]) ?? previous?.name ?? "",
    title: asString(asRecord(record["business"])?.["title"]) ?? previous?.title ?? "",
    verdict: display,
    profileVerdict,
    ...values,
    profileAt,
    lastAttemptAt: latest.at,
    lastAttemptVerdict: latest.verdict,
    runs,
    needDelta,
    firstAddedAt: previous?.firstAddedAt ?? now,
    updatedAt: changed ? now : (previous?.updatedAt ?? now),
    firstBatch: previous?.firstBatch ?? ctx.batch,
    lastBatch: latestIsThisRun ? (ctx.batch ?? previous?.lastBatch ?? null) : (previous?.lastBatch ?? null),
    profileBatch: profileUpdated
      ? (ctx.batch ?? previous?.profileBatch ?? null)
      : (previous?.profileBatch ?? null),
    status: previous?.status ?? "new",
    statusAt: previous?.statusAt ?? previous?.firstAddedAt ?? now,
    notes: previous?.notes ?? "",
    tags: previous?.tags ?? [],
    attention: latest.verdict === "UNSCORED" && profileVerdict !== null,
    batches: withBatch(previous?.batches, ctx.batch),
  };

  return {
    summary,
    history: kept,
    added,
    addedRun: !duplicate,
    profileUpdated,
    writeReport: profileUpdated || profileVerdict === null,
    changed,
  };
}

/* ------------------------------------------------------------ validation */

export function validateName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ListError("Give the list a name.", 400);
  if (name.length > 80) throw new ListError("List names are at most 80 characters.", 400);
  return name;
}

export function validateDescription(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 200) throw new ListError("Descriptions are at most 200 characters.", 400);
  return text;
}

export function validateVisibility(value: unknown, settings: ListSettings): ListVisibility {
  const visibility = typeof value === "string" && value ? value : "public";
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new ListError("Visibility must be public, unlisted or private.", 400);
  }
  if (visibility === "private" && settings.management !== "key") {
    throw new ListError(
      "Private lists need SITESCOUT_LIST_KEY, so the list can actually be protected.",
      400,
    );
  }
  return visibility as ListVisibility;
}

export function validateStatus(value: unknown): SiteStatus {
  if (typeof value !== "string" || !(SITE_STATUSES as readonly string[]).includes(value)) {
    throw new ListError("Status must be new, contacted, follow_up, won or no.", 400);
  }
  return value as SiteStatus;
}

export function validateNotes(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ListError("Notes must be text.", 400);
  if (value.length > 2_000) throw new ListError("Notes are at most 2,000 characters.", 400);
  return value;
}

export function validateTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ListError("Tags must be a list of words.", 400);
  if (value.length > 10) throw new ListError("At most 10 tags per site.", 400);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    const tag = typeof entry === "string" ? entry.trim() : "";
    if (!tag) continue;
    if (tag.length > 30) throw new ListError("Tags are at most 30 characters.", 400);
    const folded = tag.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    tags.push(tag);
  }
  return tags;
}

export function validateKeyList(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ListError("Send a non-empty list of sites.", 400);
  }
  if (value.length > max) throw new ListError(`At most ${max} sites at a time.`, 400);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const key = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!key || key.length > 253 || key.includes("/")) {
      throw new ListError("One of the site keys is not valid.", 400);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** True when the value is a report we are willing to store. */
export function isStorableReport(value: unknown): value is Report {
  const record = asRecord(value);
  if (!record) return false;
  if (!asString(record["input_url"])) return false;
  if (!isVerdict(record["verdict"])) return false;
  try {
    return Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_REPORT_BYTES;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------- public projections */

/**
 * What a visitor without the management key may see. Contact routes, notes,
 * outreach status and batch links are the owner's working data.
 */
export function publicSummary(summary: SiteSummary): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...summary };
  for (const field of [
    "notes",
    "status",
    "statusAt",
    "tags",
    "email",
    "phone",
    "firstBatch",
    "lastBatch",
    "profileBatch",
    "batches",
  ]) {
    delete copy[field];
  }
  return copy;
}

export function publicHistory(history: RunRecord[]): Record<string, unknown>[] {
  return history.map((run) => {
    const copy: Record<string, unknown> = { ...run };
    delete copy.batch;
    delete copy.index;
    return copy;
  });
}

export function publicReport(report: Report | null): Record<string, unknown> | null {
  if (!report) return null;
  const copy: Record<string, unknown> = { ...report };
  delete copy.contact;
  delete copy.outreach;
  const signals = asRecord(copy.signals);
  if (signals) {
    const next = { ...signals };
    delete next.contact;
    copy.signals = next;
  }
  return copy;
}

/* -------------------------------------------------------------------- csv */

const CSV_FIELDS = [
  "host",
  "url",
  "name",
  "verdict",
  "profile_verdict",
  "need",
  "design",
  "visual",
  "navigation",
  "credibility",
  "category",
  "era",
  "platform",
  "contactable",
  "email",
  "phone",
  "status",
  "notes",
  "tags",
  "runs",
  "first_added",
  "last_checked",
  "first_batch",
  "last_batch",
] as const;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
}

export function summariesToCsv(summaries: SiteSummary[]): string {
  const header = CSV_FIELDS.map(csvCell).join(",");
  const rows = summaries.map((summary) => {
    const values: Record<(typeof CSV_FIELDS)[number], unknown> = {
      host: summary.host,
      url: summary.url,
      name: summary.name,
      verdict: summary.verdict,
      profile_verdict: summary.profileVerdict ?? "",
      need: summary.need ?? "",
      design: summary.design ?? "",
      visual: summary.visual ?? "",
      navigation: summary.navigation ?? "",
      credibility: summary.credibility ?? "",
      category: summary.category ?? "",
      era: summary.era ?? "",
      platform: summary.platform ?? "",
      contactable: summary.contactable ? "yes" : "no",
      email: summary.email ?? "",
      phone: summary.phone ?? "",
      status: summary.status,
      notes: summary.notes,
      tags: summary.tags.join("; "),
      runs: summary.runs,
      first_added: summary.firstAddedAt,
      last_checked: summary.profileAt ?? summary.lastAttemptAt ?? "",
      first_batch: summary.firstBatch ?? "",
      last_batch: summary.lastBatch ?? "",
    };
    return CSV_FIELDS.map((field) => csvCell(values[field])).join(",");
  });
  return `\uFEFF${[header, ...rows].join("\r\n")}${rows.length > 0 ? "\r\n" : ""}`;
}

/* ------------------------------------------------------------------ store */

function hashIp(ip: string): string {
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 16);
}

function parseJson<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as T;
  return null;
}

/** `hmget` returns `(string | null)[]` with raw deserialization; normalise it. */
function toStringArray(raw: unknown): (string | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (entry === null || entry === undefined) return null;
    return typeof entry === "string" ? entry : String(entry);
  });
}

export class ListStore {
  constructor(
    private readonly redis: Redis,
    readonly settings: ListSettings,
    readonly namespace = "ss:list",
  ) {}

  private key(name: string): string {
    return `${this.namespace}:${name}`;
  }

  private registryKey(): string {
    return this.key("registry");
  }

  private jobsKey(): string {
    return this.key("jobs");
  }

  private summariesKey(listId: string): string {
    return this.key(`${listId}:summaries`);
  }

  private reportsKey(listId: string): string {
    return this.key(`${listId}:reports`);
  }

  private historyKey(listId: string): string {
    return this.key(`${listId}:history`);
  }

  private batchesKey(listId: string): string {
    return this.key(`${listId}:batches`);
  }

  /* ------------------------------------------------------------- meta */

  private parseList(raw: unknown, fallbackId: string): ListMeta | null {
    const parsed = typeof raw === "string" ? parseJson<Partial<ListMeta>>(raw) : asRecord(raw);
    if (!parsed) return null;
    if (typeof parsed.name !== "string") return null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : fallbackId,
      name: parsed.name,
      description: typeof parsed.description === "string" ? parsed.description : "",
      visibility:
        typeof parsed.visibility === "string" &&
        (VISIBILITIES as readonly string[]).includes(parsed.visibility)
          ? (parsed.visibility as ListVisibility)
          : "public",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : typeof parsed.createdAt === "string"
            ? parsed.createdAt
            : new Date(0).toISOString(),
      schema: typeof parsed.schema === "number" ? parsed.schema : 1,
    };
  }

  async readLists(): Promise<ListMeta[]> {
    const raw = toRecord(await this.redis.hgetall(this.registryKey()));
    const lists: ListMeta[] = [];
    for (const [id, value] of Object.entries(raw)) {
      const meta = this.parseList(value, id);
      if (meta) lists.push(meta);
    }
    return lists.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async readList(listId: string): Promise<ListMeta | null> {
    if (!isValidListId(listId)) return null;
    return this.parseList(await this.redis.hget(this.registryKey(), listId), listId);
  }

  async createList(input: {
    name: unknown;
    description?: unknown;
    visibility?: unknown;
  }): Promise<ListMeta> {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const visibility = validateVisibility(input.visibility, this.settings);
    const lists = await this.readLists();
    if (lists.length >= this.settings.maxLists) {
      throw new ListError(`At most ${this.settings.maxLists} lists. Delete one first.`, 409);
    }
    if (lists.some((list) => list.name.toLowerCase() === name.toLowerCase())) {
      throw new ListError(`There is already a list called "${name}".`, 409);
    }
    const now = new Date().toISOString();
    const meta: ListMeta = {
      id: randomBytes(16).toString("base64url"),
      name,
      description,
      visibility,
      createdAt: now,
      updatedAt: now,
      schema: 1,
    };
    await this.redis.hset(this.registryKey(), { [meta.id]: JSON.stringify(meta) });
    return meta;
  }

  async updateList(
    listId: string,
    patch: { name?: unknown; description?: unknown; visibility?: unknown },
  ): Promise<ListMeta> {
    const meta = await this.readList(listId);
    if (!meta) throw new ListError("That list does not exist.", 404);
    const name = patch.name === undefined ? meta.name : validateName(patch.name);
    if (name.toLowerCase() !== meta.name.toLowerCase()) {
      const lists = await this.readLists();
      if (lists.some((list) => list.id !== listId && list.name.toLowerCase() === name.toLowerCase())) {
        throw new ListError(`There is already a list called "${name}".`, 409);
      }
    }
    const next: ListMeta = {
      ...meta,
      name,
      description:
        patch.description === undefined ? meta.description : validateDescription(patch.description),
      visibility:
        patch.visibility === undefined
          ? meta.visibility
          : validateVisibility(patch.visibility, this.settings),
      updatedAt: new Date().toISOString(),
    };
    await this.redis.hset(this.registryKey(), { [listId]: JSON.stringify(next) });
    return next;
  }

  async deleteList(listId: string): Promise<void> {
    const meta = await this.readList(listId);
    if (!meta) throw new ListError("That list does not exist.", 404);
    await this.redis.del(
      this.summariesKey(listId),
      this.reportsKey(listId),
      this.historyKey(listId),
      this.batchesKey(listId),
    );
    await this.redis.hdel(this.registryKey(), listId);
  }

  async siteCount(listId: string): Promise<number> {
    return this.redis.hlen(this.summariesKey(listId));
  }

  async totalSites(): Promise<number> {
    const lists = await this.readLists();
    const counts = await Promise.all(lists.map((list) => this.siteCount(list.id)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /* ------------------------------------------------------------ sites */

  async readSummaries(listId: string): Promise<SiteSummary[]> {
    const raw = toRecord(await this.redis.hgetall(this.summariesKey(listId)));
    const summaries: SiteSummary[] = [];
    for (const value of Object.values(raw)) {
      const summary = parseJson<SiteSummary>(value);
      if (summary && typeof summary.key === "string") summaries.push(summary);
    }
    return summaries.sort((a, b) => a.host.localeCompare(b.host));
  }

  async readSite(listId: string, siteKey: string): Promise<SiteDetail | null> {
    const [summaryRaw, reportRaw, historyRaw] = await Promise.all([
      this.redis.hget(this.summariesKey(listId), siteKey),
      this.redis.hget(this.reportsKey(listId), siteKey),
      this.redis.hget(this.historyKey(listId), siteKey),
    ]);
    const summary = parseJson<SiteSummary>(summaryRaw);
    if (!summary) return null;
    const report = parseJson<Report>(reportRaw);
    const history = parseJson<RunRecord[]>(historyRaw) ?? [];
    return { summary, report, history };
  }

  async details(listId: string, keys: string[]): Promise<SiteDetail[]> {
    const out: SiteDetail[] = [];
    for (const key of keys) {
      const detail = await this.readSite(listId, key);
      if (detail) out.push(detail);
    }
    return out;
  }

  async updateSite(
    listId: string,
    siteKey: string,
    patch: { status?: unknown; notes?: unknown; tags?: unknown },
  ): Promise<SiteSummary> {
    const raw = await this.redis.hget(this.summariesKey(listId), siteKey);
    const summary = parseJson<SiteSummary>(raw);
    if (!summary) throw new ListError("That site is not in this list.", 404);
    const now = new Date().toISOString();
    const status = patch.status === undefined ? summary.status : validateStatus(patch.status);
    const next: SiteSummary = {
      ...summary,
      status,
      statusAt: status !== summary.status ? now : summary.statusAt,
      notes: patch.notes === undefined ? summary.notes : validateNotes(patch.notes),
      tags: patch.tags === undefined ? summary.tags : validateTags(patch.tags),
      updatedAt: now,
    };
    await this.redis.hset(this.summariesKey(listId), { [siteKey]: JSON.stringify(next) });
    return next;
  }

  async removeSite(listId: string, siteKey: string): Promise<void> {
    await Promise.all([
      this.redis.hdel(this.summariesKey(listId), siteKey),
      this.redis.hdel(this.reportsKey(listId), siteKey),
      this.redis.hdel(this.historyKey(listId), siteKey),
    ]);
  }

  async removeSites(listId: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const removed = await this.redis.hdel(this.summariesKey(listId), ...keys);
    await Promise.all([
      this.redis.hdel(this.reportsKey(listId), ...keys),
      this.redis.hdel(this.historyKey(listId), ...keys),
    ]);
    return Number(removed) || 0;
  }

  async setStatusMany(listId: string, keys: string[], status: SiteStatus): Promise<number> {
    if (keys.length === 0) return 0;
    const raw = toStringArray(await this.redis.hmget(this.summariesKey(listId), ...keys));
    const now = new Date().toISOString();
    const fields: Record<string, string> = {};
    keys.forEach((key, index) => {
      const summary = parseJson<SiteSummary>(raw[index] ?? null);
      if (!summary) return;
      fields[key] = JSON.stringify({
        ...summary,
        status,
        statusAt: status !== summary.status ? now : summary.statusAt,
        updatedAt: now,
      });
    });
    if (Object.keys(fields).length > 0) {
      await this.redis.hset(this.summariesKey(listId), fields);
    }
    return Object.keys(fields).length;
  }

  async clearList(listId: string): Promise<number> {
    const meta = await this.readList(listId);
    if (!meta) throw new ListError("That list does not exist.", 404);
    const count = await this.siteCount(listId);
    await this.redis.del(
      this.summariesKey(listId),
      this.reportsKey(listId),
      this.historyKey(listId),
    );
    await this.redis.hset(this.registryKey(), {
      [listId]: JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }),
    });
    return count;
  }

  /* ---------------------------------------------------------- imports */

  async importJob(
    listId: string,
    jobId: string,
    entries: JobEntryLike[],
    job: { createdAt: string; total: number; firstUrl?: string },
  ): Promise<ImportResult> {
    return this.withImportLock(async () => {
      const meta = await this.readList(listId);
      if (!meta) throw new ListError("That list does not exist.", 404);
      await this.checkCapacity(listId, entries.map((entry) => entry.report));
      return this.mergeEntries(
        listId,
        meta,
        entries,
        {
          sourceId: jobId,
          batch: jobId,
          source: "web",
          createdAt: job.createdAt,
          total: job.total,
          label: job.firstUrl ?? "",
        },
        jobId,
      );
    });
  }

  async importReports(listId: string, reports: unknown[]): Promise<ImportResult> {
    const sourceId = `upload:${createHash("sha256")
      .update(JSON.stringify(reports))
      .digest("hex")
      .slice(0, 16)}`;
    return this.withImportLock(async () => {
      const meta = await this.readList(listId);
      if (!meta) throw new ListError("That list does not exist.", 404);
      const entries: JobEntryLike[] = [];
      reports.forEach((report, index) => {
        if (isStorableReport(report)) entries.push({ index, report });
      });
      await this.checkCapacity(listId, entries.map((entry) => entry.report));
      return this.mergeEntries(
        listId,
        meta,
        entries,
        {
          sourceId,
          batch: null,
          source: "upload",
          createdAt: new Date().toISOString(),
          total: reports.length,
          label: `${reports.length} report${reports.length === 1 ? "" : "s"} from report.json`,
        },
        null,
      );
    });
  }

  private async checkCapacity(listId: string, reports: Report[]): Promise<void> {
    const keys = [
      ...new Set(
        reports
          .map((report) => siteKeyOf(report))
          .filter((key): key is string => key !== null),
      ),
    ];
    const current = await this.siteCount(listId);
    let newKeys = keys.length;
    if (keys.length > 0) {
      const existing = toStringArray(await this.redis.hmget(this.summariesKey(listId), ...keys));
      newKeys = keys.filter(
        (_key, index) => existing[index] === null || existing[index] === undefined,
      ).length;
    }
    if (current + newKeys > this.settings.maxSitesPerList) {
      throw new ListError(
        `This list is full (${current} of ${this.settings.maxSitesPerList} sites). ` +
          "Remove a few sites, or raise SITESCOUT_LIST_MAX_SITES.",
        409,
      );
    }
    const total = await this.totalSites();
    if (total + newKeys > this.settings.maxSitesTotal) {
      throw new ListError(
        `All lists together are at their limit (${total} of ${this.settings.maxSitesTotal} entries). ` +
          "Remove some sites, or raise SITESCOUT_LISTS_MAX_SITES.",
        409,
      );
    }
  }

  private async mergeEntries(
    listId: string,
    meta: ListMeta,
    entries: JobEntryLike[],
    ctx: {
      sourceId: string;
      batch: string | null;
      source: RunSource;
      createdAt: string;
      total: number;
      label: string;
    },
    jobId: string | null,
  ): Promise<ImportResult> {
    const counts: ImportCounts = { added: 0, updated: 0, unchanged: 0, failed: 0 };
    const valid = entries.filter((entry) => isStorableReport(entry.report));
    counts.failed += entries.length - valid.length;

    const keys = [
      ...new Set(
        valid
          .map((entry) => siteKeyOf(entry.report))
          .filter((key): key is string => key !== null),
      ),
    ];
    const [summaryRaw, historyRaw] = await Promise.all([
      keys.length > 0
        ? this.redis.hmget(this.summariesKey(listId), ...keys)
        : Promise.resolve([] as unknown[]),
      keys.length > 0
        ? this.redis.hmget(this.historyKey(listId), ...keys)
        : Promise.resolve([] as unknown[]),
    ]);
    const summariesRaw = toStringArray(summaryRaw);
    const historiesRaw = toStringArray(historyRaw);
    const pending = new Map<string, MergeState>();
    keys.forEach((key, index) => {
      pending.set(key, {
        summary: parseJson<SiteSummary>(summariesRaw[index] ?? null),
        history: parseJson<RunRecord[]>(historiesRaw[index] ?? null) ?? [],
      });
    });

    const changedKeys = new Set<string>();
    const reportsToWrite: Record<string, string> = {};
    const imported: number[] = [];

    for (const entry of valid) {
      const key = siteKeyOf(entry.report);
      if (!key) {
        counts.failed += 1;
        continue;
      }
      const state = pending.get(key) ?? { summary: null, history: [] };
      const merged = mergeReport(state, entry.report, {
        runId: `${ctx.sourceId}:${entry.index}`,
        batch: ctx.batch,
        index: entry.index,
        source: ctx.source,
        historyRuns: this.settings.historyRuns,
      });
      if (!merged) {
        counts.failed += 1;
        continue;
      }
      imported.push(entry.index);
      pending.set(key, { summary: merged.summary, history: merged.history });
      if (merged.added) counts.added += 1;
      else if (merged.changed) counts.updated += 1;
      else counts.unchanged += 1;
      if (merged.changed) changedKeys.add(key);
      if (merged.writeReport) reportsToWrite[key] = JSON.stringify(entry.report);
    }

    if (changedKeys.size > 0) {
      const summaryFields: Record<string, string> = {};
      const historyFields: Record<string, string> = {};
      for (const key of changedKeys) {
        const state = pending.get(key);
        if (!state?.summary) continue;
        summaryFields[key] = JSON.stringify(state.summary);
        historyFields[key] = JSON.stringify(state.history);
      }
      if (Object.keys(summaryFields).length > 0) {
        await this.redis.hset(this.summariesKey(listId), summaryFields);
        await this.redis.hset(this.historyKey(listId), historyFields);
      }
    }
    if (Object.keys(reportsToWrite).length > 0) {
      await this.redis.hset(this.reportsKey(listId), reportsToWrite);
    }

    const now = new Date().toISOString();
    const previous = parseJson<ImportRecord>(
      await this.redis.hget(this.batchesKey(listId), ctx.sourceId),
    );
    const record: ImportRecord = {
      id: ctx.sourceId,
      source: ctx.source,
      createdAt: previous?.createdAt ?? ctx.createdAt,
      importedAt: now,
      total: ctx.total,
      imported: [...new Set([...(previous?.imported ?? []), ...imported])].sort((a, b) => a - b),
      added: counts.added,
      updated: counts.updated,
      unchanged: counts.unchanged,
      label: ctx.label,
    };
    await this.redis.hset(this.batchesKey(listId), { [ctx.sourceId]: JSON.stringify(record) });
    await this.redis.hset(this.registryKey(), {
      [listId]: JSON.stringify({ ...meta, updatedAt: now }),
    });
    if (jobId) await this.registerJobFromImport(jobId, ctx);

    return { counts, record };
  }

  private async registerJobFromImport(
    jobId: string,
    ctx: { createdAt: string; total: number; label: string },
  ): Promise<void> {
    const existing = parseJson<JobRecord>(await this.redis.hget(this.jobsKey(), jobId));
    if (existing) return;
    await this.writeJob({
      id: jobId,
      createdAt: ctx.createdAt,
      total: ctx.total,
      firstUrl: ctx.label,
    });
  }

  async readBatches(listId: string): Promise<ImportRecord[]> {
    const raw = toRecord(await this.redis.hgetall(this.batchesKey(listId)));
    const records: ImportRecord[] = [];
    for (const value of Object.values(raw)) {
      const record = parseJson<ImportRecord>(value);
      if (record && typeof record.id === "string") records.push(record);
    }
    return records.sort((a, b) => Date.parse(b.importedAt) - Date.parse(a.importedAt));
  }

  /* ------------------------------------------------------ batch picker */

  private async writeJob(job: JobRecord): Promise<void> {
    await this.redis.hset(this.jobsKey(), { [job.id]: JSON.stringify(job) });
    const size = await this.redis.hlen(this.jobsKey());
    if (size <= MAX_REGISTERED_JOBS) return;
    const raw = toRecord(await this.redis.hgetall(this.jobsKey()));
    const records = Object.values(raw)
      .map((value) => parseJson<JobRecord>(value))
      .filter((entry): entry is JobRecord => entry !== null && typeof entry.id === "string")
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const extra = records.slice(0, Math.max(0, records.length - MAX_REGISTERED_JOBS));
    if (extra.length > 0) {
      await this.redis.hdel(this.jobsKey(), ...extra.map((entry) => entry.id));
    }
  }

  async registerJob(job: JobRecord): Promise<void> {
    await this.writeJob(job);
  }

  async readJobs(): Promise<JobRecord[]> {
    const raw = toRecord(await this.redis.hgetall(this.jobsKey()));
    const jobs: JobRecord[] = [];
    for (const value of Object.values(raw)) {
      const job = parseJson<JobRecord>(value);
      if (job && typeof job.id === "string") jobs.push(job);
    }
    return jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /* ---------------------------------------------------------- restore */

  async restore(
    listId: string,
    sites: unknown[],
    batches: unknown[],
  ): Promise<{ restored: number; skipped: number }> {
    if (sites.length > MAX_RESTORE_SITES) {
      throw new ListError(`Restore at most ${MAX_RESTORE_SITES} sites per request.`, 400);
    }
    return this.withImportLock(async () => {
      const meta = await this.readList(listId);
      if (!meta) throw new ListError("That list does not exist.", 404);
      const existingCount = await this.siteCount(listId);

      const summaryFields: Record<string, string> = {};
      const reportFields: Record<string, string> = {};
      const historyFields: Record<string, string> = {};
      let restored = 0;
      let skipped = 0;

      for (const entry of sites) {
        const record = asRecord(entry);
        if (!record) {
          skipped += 1;
          continue;
        }
        const summary = asRecord(record["summary"]);
        const key = asString(summary?.["key"]);
        if (!summary || !key || key.length > 253 || key.includes("/")) {
          skipped += 1;
          continue;
        }
        const exists = await this.redis.hexists(this.summariesKey(listId), key);
        if (exists === 1) {
          skipped += 1;
          continue;
        }
        const report = record["report"];
        const history = asArray(record["history"])
          .filter((run) => {
            const item = asRecord(run);
            return Boolean(item && typeof item.runId === "string" && isVerdict(item.verdict));
          })
          .slice(0, 100);

        summaryFields[key] = JSON.stringify({ ...summary, v: 1 });
        historyFields[key] = JSON.stringify(history);
        if (isStorableReport(report)) reportFields[key] = JSON.stringify(report);
        restored += 1;
      }

      if (existingCount + restored > this.settings.maxSitesPerList) {
        throw new ListError(
          `This list is full (${existingCount} of ${this.settings.maxSitesPerList} sites).`,
          409,
        );
      }
      if (restored > 0) {
        const total = await this.totalSites();
        if (total + restored > this.settings.maxSitesTotal) {
          throw new ListError(
            `All lists together are at their limit (${total} of ${this.settings.maxSitesTotal} entries).`,
            409,
          );
        }
      }

      if (restored > 0) {
        await this.redis.hset(this.summariesKey(listId), summaryFields);
        await this.redis.hset(this.historyKey(listId), historyFields);
        if (Object.keys(reportFields).length > 0) {
          await this.redis.hset(this.reportsKey(listId), reportFields);
        }
      }

      const batchFields: Record<string, string> = {};
      for (const entry of batches) {
        const record = asRecord(entry);
        const id = asString(record?.["id"]);
        if (!record || !id) continue;
        batchFields[id] = JSON.stringify(record);
      }
      if (Object.keys(batchFields).length > 0) {
        await this.redis.hset(this.batchesKey(listId), batchFields);
      }

      const now = new Date().toISOString();
      await this.redis.hset(this.registryKey(), {
        [listId]: JSON.stringify({ ...meta, updatedAt: now }),
      });
      return { restored, skipped };
    });
  }

  /* -------------------------------------------------------------- csv */

  async csv(listId: string): Promise<string> {
    return summariesToCsv(await this.readSummaries(listId));
  }

  /* ------------------------------------------------------------ limits */

  async checkRate(kind: "read" | "import" | "write", ip: string): Promise<void> {
    const limit =
      kind === "read"
        ? this.settings.readsPerHour
        : kind === "import"
          ? this.settings.importsPerHour
          : this.settings.writesPerHour;
    const hour = Math.floor(Date.now() / 3_600_000);
    const bucket = this.key(`rate:${kind}:${hashIp(ip)}:${hour}`);
    const count = Number(await this.redis.incr(bucket));
    if (count === 1) await this.redis.expire(bucket, 3_600);
    if (count > limit) {
      const retryAfter = 3_600 - Math.floor((Date.now() % 3_600_000) / 1_000);
      throw new ListError(
        `Too many list requests from this connection (limit ${limit} per hour). Try again later.`,
        429,
        { retry_after_s: Math.max(1, retryAfter) },
      );
    }
  }

  /**
   * Imports copy JSON between keys with read-modify-write steps, so two at once
   * could each think a site is new. A short Redis lock serialises them.
   */
  private async withImportLock<T>(work: () => Promise<T>): Promise<T> {
    const lockKey = this.key("lock");
    const token = randomBytes(8).toString("hex");
    const acquired = await this.redis.set(lockKey, token, { nx: true, px: 30_000 });
    if (acquired !== "OK") {
      throw new ListError("Another import is running. Try again in a moment.", 409);
    }
    try {
      return await work();
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }
}

/* --------------------------------------------------------------- factory */

let store: ListStore | null = null;

export function getListStore(): ListStore {
  store ??= new ListStore(getRedis(), listSettings());
  return store;
}

export function resetListStore(): void {
  store = null;
}
