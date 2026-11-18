/**
 * SiteScout batch interface.
 *
 * No framework, no build step: the page talks to the JSON API in api/index.ts.
 * A batch lives on the server, so closing the tab (or the whole browser) only
 * stops the polling, never the analysis.
 */

const MAX_URLS = 50;
const POLL_MS = 4000;
const RECENT_KEY = "sitescout.recent.v1";
const RECENT_LIMIT = 12;
const LIST_KEY_STORAGE = "sitescout.listkey.v1";

const VERDICTS = [
  { key: "REACH_OUT", label: "Reach out", tone: "good" },
  { key: "MAYBE", label: "Maybe", tone: "warn" },
  { key: "SKIP", label: "Skip", tone: "plain" },
  { key: "SITE_DOWN", label: "Site down", tone: "bad" },
  { key: "UNSCORED", label: "Unscored", tone: "plain" },
];

const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for quota",
  completed: "Completed",
  failed: "Failed",
};

const SCORE_LABELS = {
  visual: "Visual appeal",
  navigation: "Navigation",
  credibility: "Professional look",
};

const SITE_STATUSES = [
  { key: "new", label: "New", tone: "plain" },
  { key: "contacted", label: "Contacted", tone: "warn" },
  { key: "follow_up", label: "Follow up", tone: "warn" },
  { key: "won", label: "Won", tone: "good" },
  { key: "no", label: "No", tone: "plain" },
];

const state = {
  jobId: null,
  job: null,
  notice: null,
  open: new Set(),
  query: "",
  sort: "need-desc",
  timer: null,
  inFlight: false,
  failures: 0,
};

const listState = {
  lists: [],
  owner: true,
  management: "open",
  list: null,
  sites: [],
  batches: [],
  detail: new Map(),
  detailErrors: new Map(),
  pending: new Set(),
  open: new Set(),
  query: "",
  verdict: "all",
  status: "all",
  sort: "need-desc",
  selecting: false,
  selected: new Set(),
};

const $ = (id) => document.getElementById(id);
const views = {
  home: $("view-home"),
  job: $("view-job"),
  lists: $("view-lists"),
  list: $("view-list"),
};

/* ------------------------------------------------------------------ utils */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url).replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0] || url;
  }
}

/** A safe absolute link for the "Open" button, even if the input had no scheme. */
function siteHref(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    // no scheme: try https below
  }
  try {
    return new URL(`https://${raw.replace(/^\/+/, "")}`).href;
  } catch {
    return "";
  }
}

function verdictMeta(verdict) {
  return VERDICTS.find((v) => v.key === verdict) ?? { key: verdict, label: verdict, tone: "plain" };
}

function toneForScore(score10) {
  if (score10 >= 7) return "good";
  if (score10 >= 4) return "warn";
  return "bad";
}

function formatDate(value, opts) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(
    undefined,
    opts ?? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}

function shortDate(value) {
  return formatDate(value, { day: "numeric", month: "short" });
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Numbers like 0.8234 -> "0.82"; keeps missing values out of the way. */
function num(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/* ------------------------------------------------------------------- urls */

const TRIM_EDGES = /^[<>"'“”‘’\s]+|[<>"'“”‘’\s.,;]+$/g;

function splitUrls(text) {
  const seen = new Set();
  const urls = [];
  for (const raw of String(text).split(/[\s,;]+/)) {
    const cleaned = raw.replace(TRIM_EDGES, "");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(cleaned);
  }
  return urls;
}

/** A cheap sanity check so obvious typos are caught before spending credits. */
function looksLikeAddress(value) {
  const host = value.replace(/^https?:\/\//i, "").split("/")[0];
  if (!host || /\s/.test(host)) return false;
  if (host.startsWith("localhost") || host.includes(".")) return /[a-z0-9-]\.[a-z]{2,}/i.test(host);
  return false;
}

function readForm() {
  const urls = splitUrls($("urls").value);
  return { urls, bad: urls.filter((u) => !looksLikeAddress(u)) };
}

function updateCount() {
  const { urls, bad } = readForm();
  const count = $("url-count");
  count.textContent = `${urls.length} / ${MAX_URLS}`;
  count.classList.toggle("over", urls.length > MAX_URLS);
  const warning = $("url-warning");
  if (urls.length > MAX_URLS) {
    warning.textContent = `Remove ${urls.length - MAX_URLS} to stay within ${MAX_URLS}.`;
  } else if (bad.length > 0) {
    warning.textContent = `Not a web address: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}`;
  } else {
    warning.textContent = "";
  }
}

function showFormError(message) {
  const box = $("form-error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

/* ---------------------------------------------------------------- storage */

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.id === "string");
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch {
    // Private mode or a full quota: the list is a convenience, not a feature.
  }
}

function rememberJob(job) {
  const list = loadRecent().filter((entry) => entry.id !== job.id);
  list.unshift({
    id: job.id,
    createdAt: job.createdAt,
    total: job.total,
    done: job.done,
    status: job.status,
  });
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  saveRecent(list);
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const panel = $("recent-panel");
  panel.hidden = list.length === 0;
  const ul = $("recent-list");
  clear(ul);
  for (const entry of list) {
    const status = STATUS_LABELS[entry.status] ?? entry.status;
    const row = el(
      "button",
      {
        class: "batch-row",
        type: "button",
        onclick: () => openJob(entry.id, { push: true }),
        title: `Open batch ${entry.id}`,
      },
      [
        el("span", { class: "chip", "data-tone": entry.status, text: status }),
        el("span", { class: "mono batch-id", text: `#${entry.id.slice(0, 8)}` }),
        el("span", { text: `${entry.total} ${entry.total === 1 ? "site" : "sites"}` }),
        el("span", {
          class: "batch-count",
          text: `${entry.done}/${entry.total} · ${shortDate(entry.createdAt)}`,
        }),
      ],
    );
    ul.append(el("li", {}, row));
  }
}

/* -------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

function apiErrorMessage(result, fallback) {
  if (result.data && typeof result.data.error === "string") return result.data.error;
  if (result.status === 404) return "This batch has expired or does not exist.";
  return `${fallback} (HTTP ${result.status})`;
}

/* ------------------------------------------------------------------ views */

function setView(name) {
  document.body.dataset.view = name;
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  if (name === "home") document.title = "SiteScout — find sites worth a redesign";
  if (name === "job") window.scrollTo({ top: 0, behavior: "smooth" });

  const nav = name === "lists" || name === "list" ? "lists" : "home";
  for (const link of document.querySelectorAll("[data-nav]")) {
    const active = link.dataset.nav === nav;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function goHome(push = true) {
  stopPolling();
  state.jobId = null;
  state.job = null;
  state.notice = null;
  state.open.clear();
  setView("home");
  if (push) history.pushState({ view: "home" }, "", "/");
  $("urls").focus({ preventScroll: true });
}

function openJob(id, { push = false } = {}) {
  if (!id) return;
  const changed = state.jobId !== id;
  state.jobId = id;
  state.failures = 0;
  if (changed) {
    state.open.clear();
    state.notice = null;
    resetJobView();
  }
  setView("job");
  if (push) history.pushState({ view: "job", id }, "", `/j/${id}`);
  tick();
}

function resetJobView() {
  $("job-status").textContent = "Loading";
  $("job-status").dataset.tone = "queued";
  $("job-title").textContent = "Batch";
  $("job-sub").textContent = "";
  $("progress-fill").style.width = "0%";
  $("progress").setAttribute("aria-valuenow", "0");
  $("progress-text").textContent = "";
  clear($("job-totals"));
  clear($("results"));
  $("toolbar").hidden = true;
  $("job-empty").hidden = true;
  $("job-foot").hidden = true;
  $("job-error").hidden = true;
  $("download").href = "#";
  $("job-add-list").hidden = true;
  $("search").value = "";
  $("sort").value = "need-desc";
  state.query = "";
  state.sort = "need-desc";
}

/* ---------------------------------------------------------------- polling */

function stopPolling() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function scheduleNext(delay = POLL_MS) {
  stopPolling();
  if (!state.jobId || document.hidden) return;
  state.timer = setTimeout(tick, delay);
}

async function tick() {
  const id = state.jobId;
  if (!id || state.inFlight) return;
  state.inFlight = true;
  try {
    const result = await api(`/v1/jobs/${encodeURIComponent(id)}`);
    if (state.jobId !== id) return;

    if (!result.ok) {
      const terminal = result.status === 404;
      state.failures += terminal ? 99 : 1;
      showJobError(
        apiErrorMessage(
          result,
          terminal ? "" : "Could not read the batch. It may still be running.",
        ),
      );
      if (!terminal && state.failures < 6) scheduleNext(POLL_MS * 2);
      return;
    }

    state.failures = 0;
    const job = result.data?.job;
    if (!job) {
      showJobError("The server sent an unexpected answer.");
      return;
    }
    renderJob(job);
    rememberJob(job);
    if (job.status === "completed" || job.status === "failed") stopPolling();
    else scheduleNext();
  } catch {
    if (state.jobId !== id) return;
    state.failures += 1;
    if (state.failures < 6) {
      showJobError("The connection dropped. Trying again…");
      scheduleNext(POLL_MS * 2);
    } else {
      showJobError(
        "Could not reach the server. Your batch keeps running; reload the page in a moment.",
      );
    }
  } finally {
    state.inFlight = false;
  }
}

function showJobError(message) {
  const box = $("job-error");
  box.textContent = message;
  box.hidden = false;
}

function hideJobError() {
  const box = $("job-error");
  box.hidden = true;
  box.textContent = "";
}

/* --------------------------------------------------------------- rendering */

function renderJob(job) {
  state.job = job;
  hideJobError();

  const waiting = Number(job.waiting) || 0;
  const statusKey = job.status === "running" && waiting > 0 ? "waiting" : job.status;
  const chip = $("job-status");
  chip.textContent = STATUS_LABELS[statusKey] ?? job.status;
  chip.dataset.tone = statusKey;

  const first = job.urls?.[0] ?? "";
  $("job-title").textContent =
    job.total === 1 ? hostOf(first) : `${hostOf(first)} and ${job.total - 1} more`;

  const bits = [`${job.total} ${job.total === 1 ? "site" : "sites"}`];
  if (job.createdAt) bits.push(formatDate(job.createdAt));
  if (job.ttlDays) bits.push(`kept ${job.ttlDays} days`);
  $("job-sub").textContent = `${bits.join(" · ")} · batch ${job.id}`;

  renderProgress(job);
  renderTotals(job);

  $("download").href = `/v1/jobs/${encodeURIComponent(job.id)}/report.json`;
  // Only a batch with at least one finished report is worth adding.
  $("job-add-list").hidden = !(Number(job.done) > 0);

  renderResults(job);

  renderJobFoot(job);
  document.title =
    job.status === "completed"
      ? `Batch of ${job.total} — SiteScout`
      : `Analysing ${job.done}/${job.total} — SiteScout`;
}

function renderProgress(job) {
  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const waiting = Number(job.waiting) || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  $("progress-fill").style.width = `${percent}%`;
  $("progress").setAttribute("aria-valuenow", String(percent));

  const text = $("progress-text");
  if (job.status === "completed") {
    text.textContent = `All ${total} ${total === 1 ? "website" : "websites"} analysed${
      job.elapsed_s ? ` in ${formatDuration(job.elapsed_s)}` : ""
    }.`;
  } else if (job.status === "failed") {
    text.textContent = `${done} of ${total} analysed before the batch stopped.`;
  } else if (waiting > 0) {
    // Gemini is temporarily out of quota. The server retries on its own, so
    // the page must say so instead of looking stuck.
    const when = countdown(job.next_retry_at);
    const which = `${waiting} ${waiting === 1 ? "website is" : "websites are"} waiting for Gemini quota`;
    text.textContent = `${done} of ${total} analysed · ${which}${
      when ? `, retrying in about ${when}` : ", retrying shortly"
    }. Nothing is lost if you close this tab.`;
  } else if (done === 0) {
    text.textContent = `0 of ${total} analysed · the first report usually arrives within a minute.`;
  } else {
    const remaining = total - done;
    const average = job.elapsed_s && done > 0 ? job.elapsed_s / done : 0;
    const eta = average > 0 ? ` · about ${formatDuration(average * remaining)} left` : "";
    text.textContent = `${done} of ${total} analysed${eta}. You can close this tab.`;
  }
}

/** "3 min" / "40 s" until an ISO timestamp, or "" when it is unknown. */
function countdown(iso) {
  if (!iso) return "";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "";
  const seconds = Math.max(0, Math.round((target - Date.now()) / 1000));
  if (seconds <= 30) return "half a minute";
  if (seconds < 90) return "a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

function renderTotals(job) {
  const host = $("job-totals");
  clear(host);
  const totals = job.totals ?? {};
  for (const verdict of VERDICTS) {
    const count = Number(totals[verdict.key] ?? 0);
    if (count === 0) continue;
    host.append(
      el("span", { class: "tally", "data-verdict": verdict.key }, [
        el("b", { text: String(count) }),
        verdict.label,
      ]),
    );
  }
}

function renderJobFoot(job) {
  const foot = $("job-foot");
  const note = $("job-foot-note");
  const retry = $("retry");
  const waiting = Number(job.waiting) || 0;
  const unfinished = job.status !== "completed" && (job.done ?? 0) < (job.total ?? 0);

  retry.hidden = !unfinished || !job.canRetry;
  retry.disabled = false;
  retry.textContent = (job.done ?? 0) > 0 ? "Retry missing websites" : "Start analysis";

  if (state.notice) {
    note.textContent = state.notice;
    foot.hidden = false;
  } else if (waiting > 0) {
    const when = countdown(job.next_retry_at);
    note.textContent =
      `Gemini's free quota is used up for the moment. ${waiting} ` +
      `${waiting === 1 ? "website is" : "websites are"} queued to try again${
        when ? ` in about ${when}` : " shortly"
      } — automatically, so you can close this tab.`;
    foot.hidden = false;
  } else if (unfinished) {
    note.textContent = job.canRetry
      ? "The batch stopped making progress. Press Retry to queue the missing websites again."
      : "The batch is queued in the background. Nothing is lost if you close the tab.";
    foot.hidden = false;
  } else if (job.status === "completed") {
    note.textContent = `Reports stay available for ${job.ttlDays ?? 30} days on this page and in the JSON download.`;
    foot.hidden = false;
  } else {
    foot.hidden = true;
  }
}

function matchesQuery(report, query) {
  if (!query) return true;
  const haystack = [
    report.input_url,
    report.final_url,
    report.business?.name,
    report.business?.title,
    ...(report.reasons ?? []),
    ...(report.issues ?? []).map((issue) => issue.label),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function sortedReports(reports) {
  const list = [...reports];
  const need = (r) =>
    typeof r.need_score === "number" ? r.need_score : Number.NEGATIVE_INFINITY;
  const quality = (r) =>
    typeof r.design_quality === "number" ? r.design_quality : Number.POSITIVE_INFINITY;
  switch (state.sort) {
    case "quality-asc":
      list.sort((a, b) => quality(a) - quality(b) || need(b) - need(a));
      break;
    case "url-asc":
      list.sort((a, b) =>
        String(a.input_url ?? "").localeCompare(String(b.input_url ?? ""), undefined, {
          numeric: true,
        }),
      );
      break;
    default:
      list.sort((a, b) => need(b) - need(a));
  }
  return list;
}

function renderResults(job) {
  const all = Array.isArray(job.results) ? job.results : [];
  const query = state.query.trim().toLowerCase();
  const visible = sortedReports(all.filter((report) => matchesQuery(report, query)));

  const hits = $("results");
  clear(hits);
  for (const report of visible) hits.append(resultNode(report));

  $("toolbar").hidden = all.length === 0;

  const empty = $("job-empty");
  if (all.length === 0) {
    empty.textContent =
      job.status === "completed"
        ? "The batch finished without any reports. Try starting a new batch."
        : "Waiting for the first report. It usually takes 20–60 seconds per website.";
    empty.hidden = false;
  } else if (visible.length === 0) {
    empty.textContent = "No results match this filter.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function resultNode(report) {
  const verdict = verdictMeta(report.verdict);
  const url = report.final_url || report.input_url || "";
  const key = url;
  const hasScore = typeof report.need_score === "number";
  const visual = report.scores?.visual?.score_0_to_10;
  const scoreText = hasScore
    ? `need ${num(report.need_score)} · ${
        typeof visual === "number"
          ? `visual ${num(visual, 1)}/10`
          : `design ${num(report.design_quality * 10, 1)}/10`
      }`
    : "not scored";

  const href = siteHref(url);
  const openLink = href
    ? el("a", {
        class: "result-open",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Open website in a new tab",
        "aria-label": `Open ${url} in a new tab`,
        text: "Open ↗",
        // Without this, clicking the link would also fold/unfold the result.
        onclick: (event) => event.stopPropagation(),
      })
    : null;

  const summary = el("summary", {}, [
    el("span", { class: "verdict-tag", "data-tone": verdict.tone, text: verdict.label }),
    el("span", { class: "result-url", text: url, title: url }),
    el("span", { class: "result-score", text: scoreText }),
    openLink,
  ]);

  const body = el("div", { class: "result-body" }, resultSections(report));

  const details = el("details", { class: "result" }, [summary, body]);
  details.open = state.open.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) state.open.add(key);
    else state.open.delete(key);
  });
  return details;
}

function section(title, children) {
  return el("div", {}, [el("h3", { class: "section-title", text: title }), ...[].concat(children)]);
}

function resultSections(report) {
  const sections = [];

  sections.push(
    section(
      "Why this verdict",
      el(
        "ul",
        { class: "reasons" },
        (report.reasons ?? []).map((reason) => el("li", { text: reason })),
      ),
    ),
  );

  const meta = [];
  if (typeof report.need_score === "number") {
    const visual = report.scores?.visual?.score_0_to_10;
    meta.push(kv("Redesign need", `${num(report.need_score)} / 1.00`));
    meta.push(
      kv(
        "Visual appeal",
        typeof visual === "number"
          ? `${num(visual, 1)} / 10`
          : `${num(report.design_quality * 10, 1)} / 10`,
      ),
    );
    meta.push(kv("Model confidence", `${num((report.model_confidence ?? 0) * 100, 0)}%`));
  }
  if (report.design_era?.name) meta.push(kv("Design era", report.design_era.name));
  if (report.category?.name) {
    meta.push(
      kv(
        "Looks like",
        `${report.category.name}${
          typeof report.category.confidence === "number"
            ? ` (${num(report.category.confidence * 100, 0)}%)`
            : ""
        }`,
      ),
    );
  }
  if (report.business?.name) meta.push(kv("Business", report.business.name));
  if (report.analyzed_at) meta.push(kv("Analysed", formatDate(report.analyzed_at)));
  if (meta.length > 0) {
    sections.push(el("dl", { class: "meta-grid" }, meta));
  }

  const scores = report.scores;
  if (scores && typeof scores === "object") {
    const rows = Object.keys(SCORE_LABELS)
      .filter((key) => scores[key])
      .map((key) => {
        const value = Number(scores[key].score_0_to_10) || 0;
        const tone = toneForScore(value);
        const detail = [
          scores[key].label,
          typeof scores[key].confidence === "number"
            ? `${Math.round(scores[key].confidence * 100)}%`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return el("div", { class: "scale-row" }, [
          el("span", {}, [
            el("span", { text: SCORE_LABELS[key] }),
            detail ? el("span", { class: "grade-name", text: detail }) : null,
          ]),
          el("span", { class: "scale-bar" }, [
            el("span", {
              "data-tone": tone,
              style: `width:${Math.max(2, Math.min(100, value * 10))}%`,
            }),
          ]),
          el("span", { class: "value", text: value.toFixed(1) }),
        ]);
      });
    if (rows.length > 0) {
      sections.push(section("Design grades (0–10, higher = better)", el("div", { class: "scale" }, rows)));
    }
  }

  const issues = (report.issues ?? []).filter((issue) => issue && issue.label);
  if (issues.length > 0 && (report.verdict === "REACH_OUT" || report.verdict === "MAYBE")) {
    sections.push(
      section(
        "Talking points",
        el(
          "ul",
          { class: "issue-list" },
          issues.slice(0, 6).map((issue) => el("li", { class: "issue", text: issue.label })),
        ),
      ),
    );
  }

  const opening = report.outreach?.opening_line;
  if (opening) {
    sections.push(
      section("Draft opening line (edit before sending)", el("p", { class: "opening-line", text: opening })),
    );
  }

  const contact = contactNodes(report);
  if (contact.length > 0) sections.push(section("Contact routes found", contact));

  const warnings = report.warnings ?? [];
  if (warnings.length > 0) {
    sections.push(
      section(
        "Warnings",
        el(
          "ul",
          { class: "warnings" },
          warnings.map((warning) => el("li", { text: warning })),
        ),
      ),
    );
  }

  const checks = report.signals?.checks ?? [];
  if (checks.length > 0) {
    const list = el(
      "ul",
      { class: "issue-list" },
      checks.map((check) =>
        el("li", {
          class: "issue",
          text: `${check.ok ? "✓" : "✗"} ${check.text}`,
          style: check.ok ? "" : "color:#97331f",
        }),
      ),
    );
    sections.push(section("Technical checks", list));
  }

  const elapsed = report.elapsed_s;
  if (typeof elapsed === "number" && !report.need_score) {
    sections.push(el("p", { class: "result-note", text: `Took ${formatDuration(elapsed)}.` }));
  }

  return sections;
}

function kv(term, value) {
  return el("div", { class: "meta-item" }, [
    el("dt", { text: term }),
    el("dd", { text: String(value) }),
  ]);
}

function contactNodes(report) {
  const contact = report.contact ?? {};
  const links = [];
  for (const email of contact.emails ?? []) {
    links.push(el("li", {}, el("a", { href: `mailto:${email}`, text: email })));
  }
  for (const phone of contact.phones ?? []) {
    const dial = String(phone).replace(/[^\d+]/g, "");
    links.push(el("li", {}, el("a", { href: `tel:${dial}`, text: phone })));
  }
  if (contact.whatsapp) {
    const digits = String(contact.whatsapp).replace(/[^\d]/g, "");
    links.push(
      el(
        "li",
        {},
        el("a", {
          href: `https://wa.me/${digits}`,
          text: `WhatsApp ${contact.whatsapp}`,
          target: "_blank",
          rel: "noopener noreferrer",
        }),
      ),
    );
  }
  if (contact.contact_page) {
    links.push(
      el(
        "li",
        {},
        el("a", {
          href: contact.contact_page,
          text: "Contact page",
          target: "_blank",
          rel: "noopener noreferrer",
        }),
      ),
    );
  }
  if (contact.has_form) links.push(el("li", { class: "result-note", text: "Has a contact form." }));
  for (const [network, href] of Object.entries(contact.social ?? {})) {
    links.push(
      el(
        "li",
        {},
        el("a", { href, text: network, target: "_blank", rel: "noopener noreferrer" }),
      ),
    );
  }
  if (links.length === 0) return [];
  return el("ul", { class: "contact-links" }, links);
}

/* ----------------------------------------------------------------- actions */

async function submitBatch(event) {
  event.preventDefault();
  showFormError("");
  const { urls, bad } = readForm();

  if (urls.length === 0) return showFormError("Paste at least one website address.");
  if (urls.length > MAX_URLS) {
    return showFormError(`At most ${MAX_URLS} websites per batch. Remove ${urls.length - MAX_URLS}.`);
  }
  if (bad.length > 0) {
    const shown = bad.slice(0, 5).join(", ");
    const more = bad.length > 5 ? ` and ${bad.length - 5} more` : "";
    return showFormError(`Not a web address: ${shown}${more}.`);
  }

  const button = $("submit");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving batch…";

  try {
    const result = await api("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ urls, fresh: $("fresh").checked }),
    });
    if (!result.ok) {
      const retryAfter = result.data?.retry_after_s;
      const suffix = retryAfter ? ` Try again in ${formatDuration(retryAfter)}.` : "";
      showFormError(apiErrorMessage(result, "The batch could not be saved.") + suffix);
      return;
    }
    const job = result.data?.job;
    if (!job?.id) {
      showFormError("The server saved the batch but did not return its link. Try again.");
      return;
    }
    const notice =
      result.data.dispatched === false && result.data.warning ? result.data.warning : null;
    $("urls").value = "";
    updateCount();
    openJob(job.id, { push: true });
    // Set after openJob: it clears the notice when switching batches.
    state.notice = notice;
  } catch {
    showFormError("Could not reach the server. Check your connection and try again.");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function retryJob() {
  if (!state.jobId) return;
  const button = $("retry");
  button.disabled = true;
  button.textContent = "Queueing…";
  try {
    const result = await api(`/v1/jobs/${encodeURIComponent(state.jobId)}/retry`, {
      method: "POST",
      body: "{}",
    });
    if (!result.ok) {
      showJobError(apiErrorMessage(result, "The batch could not be restarted."));
      return;
    }
    hideJobError();
    state.notice = null;
    if (result.data?.job) renderJob(result.data.job);
    scheduleNext(1500);
  } catch {
    showJobError("Could not reach the server. Try again in a moment.");
  } finally {
    button.disabled = false;
    button.textContent = "Retry missing websites";
  }
}

async function copyLink() {
  const button = $("copy-link");
  if (!state.jobId) return;
  const link = `${location.origin}/j/${state.jobId}`;
  const done = () => {
    const label = button.textContent;
    button.textContent = "Link copied";
    setTimeout(() => {
      button.textContent = label;
    }, 1600);
  };
  try {
    await navigator.clipboard.writeText(link);
    done();
  } catch {
    // Older browsers and non-secure origins: select the text for a manual copy.
    window.prompt("Copy this link:", link);
  }
}

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const text = String(reader.result ?? "");
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.split(/[,;\t]/)[0].trim())
      .filter(Boolean);
    if (rows.length === 0) {
      showFormError("That file has no addresses in it.");
      return;
    }
    const existing = $("urls").value.trim();
    $("urls").value = `${existing ? `${existing}\n` : ""}${rows.join("\n")}`;
    showFormError("");
    updateCount();
  });
  reader.addEventListener("error", () => showFormError("The file could not be read."));
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ lists */

function statusMeta(key) {
  return (
    SITE_STATUSES.find((entry) => entry.key === key) ?? {
      key,
      label: String(key ?? "New"),
      tone: "plain",
    }
  );
}

function listKey() {
  try {
    return localStorage.getItem(LIST_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function rememberListKey(value) {
  try {
    if (value) localStorage.setItem(LIST_KEY_STORAGE, value);
    else localStorage.removeItem(LIST_KEY_STORAGE);
  } catch {
    // Private mode: the key then lasts for this page view only.
  }
}

function listHeaders() {
  const key = listKey();
  return key ? { "x-sitescout-list-key": key } : {};
}

/** Every list call goes through here, so the optional key is always attached. */
async function listApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { ...listHeaders(), ...(options.headers ?? {}) },
  });
}

function showBox(id, message) {
  const box = $(id);
  if (!box) return;
  box.textContent = message ?? "";
  box.hidden = !message;
}

function showListPageError(message) {
  showBox("list-error", message);
}

function slug(value) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "list"
  );
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadText(name, text, type = "application/json") {
  downloadBlob(name, new Blob([text], { type: `${type};charset=utf-8` }));
}

/* -------------------------------------------------------------- dialogues */

function openModal({ title, body = [], actions = [] }) {
  const dialog = $("modal");
  // A dialog can only be opened once; confirmations replace the previous one.
  if (dialog.open) dialog.close();

  $("modal-title").textContent = title;
  const bodyHost = $("modal-body");
  clear(bodyHost);
  for (const node of [].concat(body).flat(Infinity)) {
    if (node === null || node === undefined || node === false) continue;
    bodyHost.append(node instanceof Node ? node : document.createTextNode(String(node)));
  }

  const actionHost = $("modal-actions");
  clear(actionHost);
  for (const action of actions) {
    const kind = action.kind === "primary" ? "btn-primary" : action.kind === "danger" ? "btn-danger" : "btn-ghost";
    const button = el("button", {
      class: `btn ${kind}`,
      type: "button",
      text: action.label,
      disabled: action.disabled === true,
    });
    button.addEventListener("click", async () => {
      if (!action.onClick) {
        closeModal();
        return;
      }
      const label = button.textContent;
      button.disabled = true;
      try {
        const keepOpen = await action.onClick();
        if (keepOpen !== false) closeModal();
      } catch (err) {
        modalError(err instanceof Error ? err.message : String(err));
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
    actionHost.append(button);
  }
  actionHost.hidden = actions.length === 0;
  dialog.showModal();
}

function closeModal() {
  const dialog = $("modal");
  if (dialog.open) dialog.close();
}

function modalError(message) {
  const body = $("modal-body");
  let box = body.querySelector(".modal-error");
  if (!box) {
    box = el("p", { class: "form-error modal-error", role: "alert" });
    body.prepend(box);
  }
  box.textContent = message;
  box.hidden = false;
}

function modalResults(title, rows, note = null) {
  $("modal-title").textContent = title;
  const body = $("modal-body");
  clear(body);
  if (note) body.append(el("p", { class: "hint", text: note }));
  body.append(
    el(
      "ul",
      { class: "import-results" },
      rows.map((row) =>
        el("li", { class: row.ok ? "" : "bad" }, [
          el("strong", { text: row.name }),
          el("span", { text: row.text }),
        ]),
      ),
    ),
  );
  const actions = $("modal-actions");
  clear(actions);
  actions.hidden = false;
  actions.append(
    el("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Done",
      onclick: closeModal,
    }),
  );
}

function field(labelText, control) {
  return el("label", { class: "field-inline" }, [
    el("span", { class: "field-label", text: labelText }),
    control,
  ]);
}

function textInput(props = {}) {
  return el("input", { type: "text", class: "input", ...props });
}

function choiceRow(list, checked = false, suffix = "") {
  const box = el("input", { type: "checkbox", value: list.id });
  box.checked = checked;
  return el("label", { class: "check list-choice" }, [
    box,
    el("span", { text: list.name }),
    el("span", { class: "hint", text: suffix ? ` · ${suffix}` : "" }),
  ]);
}

function choicesFrom(host) {
  return [...host.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => box.value);
}

function listName(id) {
  return listState.lists.find((list) => list.id === id)?.name ?? id.slice(0, 8);
}

function accessMessage() {
  if (listState.owner) return "";
  if (listState.management === "key") {
    return "Public view: notes, outreach status and contact routes are hidden. Press Unlock to change anything.";
  }
  if (listState.management === "disabled") {
    return "List management is switched off on this deployment, so lists are read-only.";
  }
  return "";
}

/* ------------------------------------------------------------ unlock flow */

function openKeyModal() {
  const input = el("input", {
    type: "password",
    class: "input",
    autocomplete: "current-password",
    placeholder: "SITESCOUT_LIST_KEY",
  });
  openModal({
    title: "Management key",
    body: [
      el("p", {
        class: "hint",
        text: "This SiteScout protects changes with a management key. Paste it once; this browser remembers it.",
      }),
      field("Key", input),
    ],
    actions: [
      {
        label: "Unlock",
        kind: "primary",
        onClick: async () => {
          const value = input.value.trim();
          if (!value) {
            modalError("Paste the management key.");
            return false;
          }
          rememberListKey(value);
          const result = await listApi("/v1/lists");
          if (!result.ok) {
            rememberListKey("");
            modalError(apiErrorMessage(result, "That key was not accepted."));
            return false;
          }
          listState.owner = Boolean(result.data?.owner);
          listState.management = result.data?.management ?? "key";
          if (document.body.dataset.view === "lists") await loadLists();
          else if (document.body.dataset.view === "list" && listState.list) {
            await loadList(listState.list.id);
          }
          return true;
        },
      },
    ],
  });
  input.focus();
}

/* -------------------------------------------------------------- dashboard */

async function openLists({ push = false } = {}) {
  stopPolling();
  state.jobId = null;
  state.job = null;
  listState.list = null;
  listState.sites = [];
  listState.batches = [];
  listState.detail.clear();
  listState.detailErrors.clear();
  listState.open.clear();
  listState.selected.clear();
  listState.selecting = false;
  setView("lists");
  if (push) history.pushState({ view: "lists" }, "", "/lists");
  document.title = "Lists — SiteScout";
  await loadLists();
}

async function loadLists() {
  showBox("lists-error", "");
  const result = await listApi("/v1/lists");
  if (!result.ok) {
    listState.lists = [];
    if (result.status === 401) {
      listState.owner = false;
      listState.management = "key";
      renderLists();
      showBox("lists-error", "That management key was not accepted. Press Unlock to enter it again.");
      return;
    }
    renderLists();
    showBox("lists-error", apiErrorMessage(result, "Could not load the lists."));
    return;
  }
  listState.lists = Array.isArray(result.data?.lists) ? result.data.lists : [];
  listState.owner = Boolean(result.data?.owner);
  listState.management = result.data?.management ?? "open";
  renderLists();
}

function renderLists() {
  const owner = listState.owner;
  $("lists-new").hidden = !owner;
  $("lists-import").hidden = !owner;
  $("lists-unlock").hidden = owner || listState.management !== "key";

  const note = $("lists-access");
  note.textContent = accessMessage();
  note.hidden = !note.textContent;

  const grid = $("lists-grid");
  clear(grid);
  for (const list of listState.lists) {
    const bits = [`${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"}`];
    if (list.updatedAt) bits.push(`updated ${shortDate(list.updatedAt)}`);
    if (list.visibility !== "public") bits.push(list.visibility);

    const card = el(
      "a",
      {
        class: "list-card",
        href: `/l/${list.id}`,
        onclick: (event) => {
          event.preventDefault();
          openList(list.id, { push: true });
        },
      },
      [
        el("div", { class: "list-card-head" }, [
          el("h2", { text: list.name }),
          el("span", { class: "count mono", text: String(list.siteCount) }),
        ]),
        list.description ? el("p", { class: "list-card-desc", text: list.description }) : null,
        el("p", { class: "list-card-meta mono", text: bits.join(" · ") }),
      ],
    );
    grid.append(card);
  }

  $("lists-empty").hidden = listState.lists.length > 0;
}

/* ---------------------------------------------------------------- one list */

async function openList(id, { push = false } = {}) {
  stopPolling();
  state.jobId = null;
  state.job = null;
  listState.list = null;
  listState.sites = [];
  listState.batches = [];
  listState.detail.clear();
  listState.detailErrors.clear();
  listState.open.clear();
  listState.selected.clear();
  listState.selecting = false;
  listState.query = "";
  listState.verdict = "all";
  listState.status = "all";
  listState.sort = "need-desc";
  resetListView();
  setView("list");
  if (push) history.pushState({ view: "list", id }, "", `/l/${encodeURIComponent(id)}`);
  await loadList(id);
}

function resetListView() {
  // Nothing from the previous list may linger while the next one loads.
  $("list-title").textContent = "Loading…";
  for (const id of ["list-add-batch", "list-export", "list-backup", "list-import", "list-manage", "list-select", "list-unlock"]) {
    $(id).hidden = true;
  }
  $("list-description").hidden = true;
  $("list-description").textContent = "";
  $("list-meta").textContent = "";
  clear($("list-totals"));
  clear($("list-sites"));
  $("list-toolbar").hidden = true;
  $("list-bulk").hidden = true;
  $("list-empty").hidden = true;
  showListPageError("");
  $("list-search").value = "";
  $("list-verdict").value = "all";
  $("list-status").value = "all";
  $("list-sort").value = "need-desc";
}

async function loadList(id) {
  showListPageError("");
  const result = await listApi(`/v1/lists/${encodeURIComponent(id)}`);
  if (!result.ok) {
    $("list-title").textContent = "List not found";
    $("list-meta").textContent = "";
    showListPageError(apiErrorMessage(result, "This list does not exist (it may have been deleted)."));
    for (const button of ["list-add-batch", "list-export", "list-backup", "list-import", "list-manage", "list-unlock"]) {
      $(button).hidden = true;
    }
    return;
  }

  listState.list = result.data.list;
  listState.sites = Array.isArray(result.data.sites) ? result.data.sites : [];
  listState.batches = Array.isArray(result.data.batches) ? result.data.batches : [];
  listState.owner = Boolean(result.data.owner);
  listState.management = result.data.management ?? "open";
  // The cached details belong to the previous copy of the list; an import or a
  // bulk change may have replaced them.
  listState.detail.clear();
  listState.detailErrors.clear();
  for (const key of listState.open) {
    if (!listState.sites.some((site) => site.key === key)) listState.open.delete(key);
  }
  renderList();
}

function renderList() {
  const list = listState.list;
  if (!list) return;
  const owner = listState.owner;

  $("list-title").textContent = list.name;
  const description = $("list-description");
  description.textContent = list.description ?? "";
  description.hidden = !description.textContent;

  const bits = [`${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"}`];
  if (list.createdAt) bits.push(`started ${shortDate(list.createdAt)}`);
  if (list.updatedAt) bits.push(`updated ${shortDate(list.updatedAt)}`);
  if (list.visibility !== "public") bits.push(list.visibility);
  $("list-meta").textContent = bits.join(" · ");

  for (const id of ["list-add-batch", "list-export", "list-backup", "list-import", "list-manage", "list-select"]) {
    $(id).hidden = !owner;
  }
  $("list-unlock").hidden = owner || listState.management !== "key";
  $("list-status").hidden = !owner;

  const note = $("list-access");
  note.textContent = accessMessage();
  note.hidden = !note.textContent;

  document.title = `${list.name} — SiteScout`;
  renderListTotals();
  renderListSites();
}

function renderListTotals() {
  const host = $("list-totals");
  clear(host);
  const verdicts = {};
  let attention = 0;
  for (const site of listState.sites) {
    verdicts[site.verdict] = (verdicts[site.verdict] ?? 0) + 1;
    if (site.attention) attention += 1;
  }
  for (const verdict of VERDICTS) {
    const count = verdicts[verdict.key] ?? 0;
    if (count === 0) continue;
    host.append(
      el("span", { class: "tally", "data-verdict": verdict.key }, [
        el("b", { text: String(count) }),
        verdict.label,
      ]),
    );
  }
  if (attention > 0) {
    host.append(
      el("span", { class: "tally", "data-verdict": "attention" }, [
        el("b", { text: String(attention) }),
        "need a re-check",
      ]),
    );
  }
  if (listState.owner) {
    const statuses = {};
    for (const site of listState.sites) {
      const key = site.status ?? "new";
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    for (const status of SITE_STATUSES) {
      const count = statuses[status.key] ?? 0;
      if (count === 0) continue;
      host.append(
        el("span", { class: "tally status-tally", "data-tone": status.tone }, [
          el("b", { text: String(count) }),
          status.label.toLowerCase(),
        ]),
      );
    }
  }
}

function siteHaystack(site) {
  return [
    site.host,
    site.url,
    site.inputUrl,
    site.name,
    site.title,
    site.category,
    site.era,
    site.platform,
    site.email,
    site.phone,
    site.notes,
    ...(site.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function visibleSites() {
  const query = listState.query.trim().toLowerCase();
  const sites = listState.sites.filter((site) => {
    if (listState.verdict === "attention" && !site.attention) return false;
    if (
      listState.verdict !== "all" &&
      listState.verdict !== "attention" &&
      site.verdict !== listState.verdict
    ) {
      return false;
    }
    if (listState.status !== "all" && (site.status ?? "new") !== listState.status) return false;
    if (query && !siteHaystack(site).includes(query)) return false;
    return true;
  });

  const need = (site) => (typeof site.need === "number" ? site.need : -1);
  const visual = (site) => (typeof site.visual === "number" ? site.visual : 99);
  const checked = (site) => Date.parse(site.profileAt ?? site.lastAttemptAt ?? "") || 0;
  const added = (site) => Date.parse(site.firstAddedAt ?? "") || 0;
  const statusRank = (site) =>
    SITE_STATUSES.findIndex((entry) => entry.key === (site.status ?? "new"));

  switch (listState.sort) {
    case "need-asc":
      sites.sort((a, b) => need(a) - need(b) || a.host.localeCompare(b.host));
      break;
    case "visual-asc":
      sites.sort((a, b) => visual(a) - visual(b) || need(b) - need(a));
      break;
    case "checked-desc":
      sites.sort((a, b) => checked(b) - checked(a));
      break;
    case "added-desc":
      sites.sort((a, b) => added(b) - added(a));
      break;
    case "name-asc":
      sites.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
      break;
    case "status":
      sites.sort((a, b) => statusRank(a) - statusRank(b) || need(b) - need(a));
      break;
    default:
      sites.sort((a, b) => need(b) - need(a) || visual(a) - visual(b));
  }
  return sites;
}

function scoreLine(site) {
  const bits = [typeof site.need === "number" ? `need ${num(site.need)}` : "not scored"];
  if (typeof site.visual === "number") bits.push(`visual ${num(site.visual, 1)}/10`);
  if (typeof site.needDelta === "number" && site.needDelta !== 0) {
    bits.push(`${site.needDelta > 0 ? "▲" : "▼"} ${num(Math.abs(site.needDelta))}`);
  }
  return bits.join(" · ");
}

function renderListSites() {
  const host = $("list-sites");
  clear(host);
  const visible = visibleSites();
  for (const site of visible) host.append(siteNode(site));

  $("list-toolbar").hidden = listState.sites.length === 0;

  const empty = $("list-empty");
  if (listState.sites.length === 0) {
    empty.textContent = listState.owner
      ? "This list is empty. Open a finished batch and press “Add to list”, or import a report.json."
      : "This list is empty.";
    empty.hidden = false;
  } else if (visible.length === 0) {
    empty.textContent = "No sites match these filters.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
  renderBulk();
}

function siteNode(site) {
  const verdict = verdictMeta(site.verdict);
  const status = statusMeta(site.status);
  const href = siteHref(site.url);
  const checkedAt = site.profileAt ?? site.lastAttemptAt ?? "";

  const details = el("details", { class: "site", dataset: { site: site.key } });
  details.open = listState.open.has(site.key);

  let picker = null;
  if (listState.selecting && listState.owner) {
    const box = el("input", { type: "checkbox", "aria-label": `Select ${site.host}` });
    box.checked = listState.selected.has(site.key);
    box.addEventListener("change", () => togglePicked(site.key, box.checked));
    picker = el("span", { class: "pick", onclick: (event) => event.stopPropagation() }, box);
  }

  const openLink = href
    ? el("a", {
        class: "result-open",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Open website in a new tab",
        text: "Open ↗",
        onclick: (event) => event.stopPropagation(),
      })
    : null;

  const summary = el("summary", {}, [
    picker,
    el("span", { class: "verdict-tag", "data-tone": verdict.tone, text: verdict.label }),
    el("span", { class: "site-main" }, [
      el("span", { class: "site-host", text: site.host }),
      site.name || site.title
        ? el("span", { class: "site-name", text: site.name || site.title })
        : null,
      site.attention
        ? el("span", {
            class: "flag",
            title: "The latest check failed, so these scores come from the run before it.",
            text: "re-check failed",
          })
        : null,
    ]),
    el("span", {
      class: "site-score",
      title: `${site.runs ?? 0} ${site.runs === 1 ? "check" : "checks"} recorded`,
      text: scoreLine(site),
    }),
    listState.owner
      ? el("span", { class: "status-tag", "data-tone": status.tone, text: status.label })
      : null,
    el("span", {
      class: "site-when mono",
      text: checkedAt ? `checked ${shortDate(checkedAt)}` : "never checked",
    }),
    openLink,
  ]);

  details.append(summary, siteBody(site));
  details.addEventListener("toggle", () => {
    if (details.open) {
      listState.open.add(site.key);
      ensureDetail(site);
    } else {
      listState.open.delete(site.key);
    }
  });
  // Re-rendered rows that were already open do not always fire `toggle`, so
  // ask for their report here as well.
  if (details.open) ensureDetail(site);
  return details;
}

async function ensureDetail(site) {
  const list = listState.list;
  if (!list) return;
  if (listState.detail.has(site.key) || listState.pending.has(site.key)) return;
  const listId = list.id;
  listState.pending.add(site.key);
  const result = await listApi(
    `/v1/lists/${encodeURIComponent(listId)}/sites/${encodeURIComponent(site.key)}`,
  );
  listState.pending.delete(site.key);
  if (listState.list?.id !== listId) return;
  if (!result.ok) {
    listState.detailErrors.set(site.key, apiErrorMessage(result, "Could not load this site."));
  } else {
    listState.detailErrors.delete(site.key);
    listState.detail.set(site.key, result.data.site);
  }
  renderListSites();
}

function siteBody(site) {
  const error = listState.detailErrors.get(site.key);
  const detail = listState.detail.get(site.key);
  if (!detail) {
    return el("div", { class: "result-body" }, [
      el("p", { class: "result-note", text: error ?? "Loading the last report…" }),
    ]);
  }

  const parts = [];
  if (listState.owner) parts.push(siteEditor(detail.summary));
  parts.push(historyBlock(detail.history, detail.summary.runs));
  if (detail.report) parts.push(...resultSections(detail.report));
  else {
    parts.push(
      el("p", {
        class: "result-note",
        text: "No full report was kept for this site. The summary above is all there is.",
      }),
    );
  }
  return el("div", { class: "result-body" }, parts);
}

function siteEditor(site) {
  const status = el("select", { class: "select", "aria-label": "Outreach status" });
  for (const entry of SITE_STATUSES) {
    const option = el("option", { value: entry.key, text: entry.label });
    if (entry.key === (site.status ?? "new")) option.selected = true;
    status.append(option);
  }

  const tags = textInput({
    value: (site.tags ?? []).join(", "),
    placeholder: "bakery, amsterdam",
    "aria-label": "Tags, comma separated",
  });

  const notes = el("textarea", {
    class: "notes",
    rows: "3",
    maxlength: "2000",
    placeholder: "What did you send, and what came back?",
    text: site.notes ?? "",
  });

  const note = el("span", { class: "hint save-note", "aria-live": "polite" });
  const save = el("button", { class: "btn btn-ghost", type: "button", text: "Save" });
  save.addEventListener("click", () => saveSite(site, { status, notes, tags, save, note }));

  return el("div", { class: "site-editor" }, [
    el("div", { class: "editor-row" }, [
      el("label", { class: "editor-field" }, [el("span", { text: "Status" }), status]),
      el("label", { class: "editor-field wide" }, [el("span", { text: "Tags" }), tags]),
    ]),
    el("label", { class: "editor-field" }, [el("span", { text: "Notes" }), notes]),
    el("div", { class: "editor-foot" }, [note, save]),
  ]);
}

async function saveSite(site, controls) {
  const list = listState.list;
  if (!list) return;
  controls.save.disabled = true;
  controls.note.textContent = "Saving…";
  controls.note.classList.remove("bad");

  const body = {
    status: controls.status.value,
    notes: controls.notes.value,
    tags: controls.tags.value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };

  const result = await listApi(
    `/v1/lists/${encodeURIComponent(list.id)}/sites/${encodeURIComponent(site.key)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  controls.save.disabled = false;

  if (!result.ok) {
    controls.note.textContent = apiErrorMessage(result, "Could not save these changes.");
    controls.note.classList.add("bad");
    return;
  }

  const updated = result.data.site;
  const index = listState.sites.findIndex((entry) => entry.key === site.key);
  if (index >= 0) listState.sites[index] = updated;
  const detail = listState.detail.get(site.key);
  if (detail) listState.detail.set(site.key, { ...detail, summary: updated });

  controls.note.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  syncSiteRow(updated);
  renderListTotals();
}

function syncSiteRow(site) {
  const row = [...document.querySelectorAll(".site")].find(
    (node) => node.dataset.site === site.key,
  );
  if (!row) return;
  const tag = row.querySelector("summary .status-tag");
  if (!tag) return;
  const meta = statusMeta(site.status);
  tag.textContent = meta.label;
  tag.dataset.tone = meta.tone;
}

function historyBlock(history, total = 0) {
  const runs = Array.isArray(history) ? history : [];
  if (runs.length === 0) {
    return el("p", { class: "result-note", text: "No checks recorded for this site yet." });
  }
  const count = Math.max(total || 0, runs.length);
  const title =
    count > runs.length
      ? `Run history (${runs.length} shown of ${count})`
      : `Run history (${runs.length})`;

  const rows = runs.map((run) => {
    const verdict = verdictMeta(run.verdict);
    const when = formatDate(run.at, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const score = typeof run.need === "number" ? `need ${num(run.need)}` : "not scored";
    const batchLink =
      listState.owner && run.batch
        ? el("a", {
            class: "mono",
            href: `/j/${run.batch}`,
            text: `#${String(run.batch).slice(0, 8)}`,
            title: "Open this batch",
            onclick: (event) => {
              event.preventDefault();
              openJob(run.batch, { push: true });
            },
          })
        : null;

    return el("li", {}, [
      el("span", { class: "verdict-tag small", "data-tone": verdict.tone, text: verdict.label }),
      el("span", { class: "mono history-when", text: when }),
      el("span", { class: "mono", text: score }),
      batchLink,
      el("span", { class: "history-reason", text: run.reason ?? "" }),
    ]);
  });

  return section(title, el("ol", { class: "history" }, rows));
}

/* ------------------------------------------------------ selection & bulk */

function togglePicked(key, checked) {
  if (checked) listState.selected.add(key);
  else listState.selected.delete(key);
  renderBulk();
}

function renderBulk() {
  const bar = $("list-bulk");
  const active = listState.selecting && listState.owner && listState.sites.length > 0;
  bar.hidden = !active;
  $("list-select").textContent = listState.selecting ? "Stop selecting" : "Select";
  $("bulk-count").textContent = `${listState.selected.size} selected`;
  $("bulk-apply").disabled = listState.selected.size === 0;
  $("bulk-remove").disabled = listState.selected.size === 0;
}

async function bulkStatus() {
  const list = listState.list;
  const keys = [...listState.selected];
  if (!list || keys.length === 0) return;
  const result = await listApi(`/v1/lists/${encodeURIComponent(list.id)}/bulk`, {
    method: "POST",
    body: JSON.stringify({ action: "status", status: $("bulk-status").value, keys }),
  });
  if (!result.ok) {
    showListPageError(apiErrorMessage(result, "Could not update these sites."));
    return;
  }
  listState.selected.clear();
  listState.selecting = false;
  await loadList(list.id);
}

function bulkRemove() {
  const list = listState.list;
  const keys = [...listState.selected];
  if (!list || keys.length === 0) return;
  const which = `${keys.length} ${keys.length === 1 ? "site" : "sites"}`;
  openModal({
    title: "Remove from list",
    body: el("p", {
      class: "hint",
      text: `Remove ${which} from “${list.name}”? Their reports and history are deleted with them. The batch itself is not touched.`,
    }),
    actions: [
      { label: "Cancel" },
      {
        label: "Remove",
        kind: "danger",
        onClick: async () => {
          const result = await listApi(`/v1/lists/${encodeURIComponent(list.id)}/bulk`, {
            method: "POST",
            body: JSON.stringify({ action: "remove", keys }),
          });
          if (!result.ok) {
            modalError(apiErrorMessage(result, "Could not remove these sites."));
            return false;
          }
          listState.selected.clear();
          listState.selecting = false;
          await loadList(list.id);
        },
      },
    ],
  });
}

/* ------------------------------------------------------------- add a batch */

function batchIdFrom(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = /\/j\/([A-Za-z0-9_-]{20,32})/.exec(raw);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{20,32}$/.test(raw) ? raw : "";
}

function batchLabel(job) {
  const bits = [];
  if (job.createdAt) bits.push(shortDate(job.createdAt));
  if (job.total) bits.push(`${job.total} ${job.total === 1 ? "site" : "sites"}`);
  const first = job.firstUrl ? hostOf(job.firstUrl) : "";
  if (first) bits.push(job.total > 1 ? `${first} and ${job.total - 1} more` : first);
  if (job.imported) bits.push(`${job.imported} already in this list`);
  return bits.join(" · ") || job.id.slice(0, 8);
}

async function openAddToList({ jobId = state.jobId, listId = null } = {}) {
  let wanted = jobId ?? "";

  const listsResult = await listApi("/v1/lists");
  if (!listsResult.ok) {
    openModal({
      title: "Add to list",
      body: el("p", { class: "form-error", text: apiErrorMessage(listsResult, "Could not load the lists.") }),
    });
    return;
  }
  listState.owner = Boolean(listsResult.data?.owner);
  listState.management = listsResult.data?.management ?? "open";
  if (!listState.owner) {
    openKeyModal();
    return;
  }
  listState.lists = Array.isArray(listsResult.data.lists) ? listsResult.data.lists : [];

  const currentListId = listId ?? listState.list?.id ?? listState.lists[0]?.id ?? null;
  let jobs = [];
  if (currentListId) {
    const batchResult = await listApi(`/v1/lists/${encodeURIComponent(currentListId)}/batches`);
    if (batchResult.ok) jobs = Array.isArray(batchResult.data.jobs) ? batchResult.data.jobs : [];
  }
  if (wanted && !jobs.some((job) => job.id === wanted)) {
    jobs.unshift({
      id: wanted,
      createdAt: state.job?.id === wanted ? state.job.createdAt : null,
      total: state.job?.id === wanted ? state.job.total : 0,
      firstUrl: state.job?.id === wanted ? (state.job.urls?.[0] ?? "") : "",
    });
  }
  // Opened from a list page there is no current batch, so the picker starts at
  // the newest one this list already knows about.
  if (!wanted) wanted = jobs[0]?.id ?? "";

  const batchSelect = el("select", { class: "select", "aria-label": "Batch to add" });
  if (jobs.length === 0) {
    batchSelect.append(el("option", { value: "", text: "No batches yet — paste a link below" }));
  }
  for (const job of jobs) {
    const option = el("option", { value: job.id, text: batchLabel(job) });
    if (job.id === wanted) option.selected = true;
    batchSelect.append(option);
  }

  const manual = textInput({ placeholder: "or paste a batch link (/j/…)" });
  const choiceHost = el("div", { class: "choice-grid" });
  if (listState.lists.length === 0) {
    choiceHost.append(el("p", { class: "hint", text: "You have no lists yet. Create one below." }));
  }
  for (const list of listState.lists) {
    choiceHost.append(
      choiceRow(
        list,
        list.id === currentListId,
        `${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"}`,
      ),
    );
  }

  const newName = textInput({ placeholder: "New list name" });
  const create = el("button", { class: "btn btn-ghost", type: "button", text: "Create" });
  create.addEventListener("click", async () => {
    const name = newName.value.trim();
    if (!name) {
      newName.focus();
      return;
    }
    create.disabled = true;
    const result = await listApi("/v1/lists", { method: "POST", body: JSON.stringify({ name }) });
    create.disabled = false;
    if (!result.ok) {
      modalError(apiErrorMessage(result, "Could not create the list."));
      return;
    }
    const list = result.data.list;
    listState.lists.push(list);
    if (choiceHost.querySelector("p")) clear(choiceHost);
    choiceHost.append(choiceRow(list, true, "new"));
    newName.value = "";
  });

  openModal({
    title: "Add a batch to a list",
    body: [
      el("p", {
        class: "hint",
        text: "Choose a finished batch and one or more lists. Nothing is added by itself, and the batch itself stays disposable.",
      }),
      field("Batch", batchSelect),
      field("Other batch", manual),
      el("h3", { class: "section-title", text: "Add to these lists" }),
      choiceHost,
      el("div", { class: "inline-create" }, [newName, create]),
    ],
    actions: [
      {
        label: "Add to list",
        kind: "primary",
        onClick: async () => {
          const targetIds = choicesFrom(choiceHost);
          if (targetIds.length === 0) {
            modalError("Choose at least one list.");
            return false;
          }
          const typed = manual.value.trim();
          const manualId = batchIdFrom(typed);
          if (typed && !manualId) {
            modalError("That does not look like a batch link. Copy the address of the batch page.");
            return false;
          }
          const chosen = manualId || batchSelect.value;
          if (!chosen) {
            modalError("Choose a batch.");
            return false;
          }

          const result = await listApi("/v1/lists/import", {
            method: "POST",
            body: JSON.stringify({ jobId: chosen, listIds: targetIds }),
          });
          if (!result.ok) {
            modalError(apiErrorMessage(result, "The batch could not be added."));
            return false;
          }

          const rows = (result.data.results ?? []).map((entry) => ({
            name: listName(entry.listId),
            ok: entry.ok !== false,
            text:
              entry.ok === false
                ? entry.error
                : `${entry.added} added · ${entry.updated} updated · ${entry.unchanged} already there`,
          }));
          const batch = result.data.batch ?? {};
          modalResults(
            "Batch added",
            rows,
            batch.ready !== undefined
              ? `${batch.ready} of ${batch.total} websites in this batch had a report.`
              : null,
          );
          if (listState.list && targetIds.includes(listState.list.id)) {
            await loadList(listState.list.id);
          }
          return false;
        },
      },
    ],
  });
}

/* -------------------------------------------------------------- importing */

async function openImportModal({ listId = listState.list?.id ?? null } = {}) {
  const listsResult = await listApi("/v1/lists");
  if (!listsResult.ok) {
    openModal({
      title: "Import",
      body: el("p", { class: "form-error", text: apiErrorMessage(listsResult, "Could not load the lists.") }),
    });
    return;
  }
  listState.owner = Boolean(listsResult.data?.owner);
  listState.management = listsResult.data?.management ?? "open";
  if (!listState.owner) {
    openKeyModal();
    return;
  }
  listState.lists = Array.isArray(listsResult.data.lists) ? listsResult.data.lists : [];

  if (listState.lists.length === 0) {
    openModal({
      title: "Import",
      body: el("p", { class: "hint", text: "Create a list first, then import reports into it." }),
    });
    return;
  }

  const file = el("input", { type: "file", accept: ".json,application/json" });
  const text = el("textarea", {
    class: "import-text",
    spellcheck: "false",
    placeholder: '[ { "input_url": "https://…", "verdict": "REACH_OUT", … } ]',
  });
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      text.value = String(reader.result ?? "");
    });
    reader.addEventListener("error", () => modalError("That file could not be read."));
    reader.readAsText(chosen);
  });

  const choiceHost = el("div", { class: "choice-grid" });
  for (const list of listState.lists) {
    choiceHost.append(
      choiceRow(
        list,
        list.id === listId,
        `${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"}`,
      ),
    );
  }

  openModal({
    title: "Import",
    body: [
      el("p", {
        class: "hint",
        text: "Load a report.json from the command line tool, or a SiteScout backup file. Reports are merged into the list you choose; nothing is overwritten blindly.",
      }),
      field("File", file),
      text,
      el("h3", { class: "section-title", text: "Import into" }),
      choiceHost,
    ],
    actions: [
      {
        label: "Import",
        kind: "primary",
        onClick: async () => {
          const raw = text.value.trim();
          if (!raw) {
            modalError("Paste the contents of report.json, or choose the file.");
            return false;
          }

          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            modalError("That is not valid JSON.");
            return false;
          }

          const targetIds = choicesFrom(choiceHost);
          if (targetIds.length === 0) {
            modalError("Choose at least one list.");
            return false;
          }

          const reports = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.reports)
              ? parsed.reports
              : null;
          const backup = !reports && parsed && Array.isArray(parsed.sites) ? parsed : null;

          if (!reports && !backup) {
            modalError(
              "Expected an array of reports from report.json, or a SiteScout backup file (with a “sites” array).",
            );
            return false;
          }

          if (backup) {
            await runRestore(backup, targetIds);
            return false;
          }

          const totals = new Map(
            targetIds.map((id) => [id, { added: 0, updated: 0, unchanged: 0, failed: 0, error: null }]),
          );
          const chunkSize = 25;
          for (let index = 0; index < reports.length; index += chunkSize) {
            const chunk = reports.slice(index, index + chunkSize);
            const result = await listApi("/v1/lists/reports", {
              method: "POST",
              body: JSON.stringify({ reports: chunk, listIds: targetIds }),
            });
            if (!result.ok) {
              modalError(apiErrorMessage(result, "The reports could not be imported."));
              return false;
            }
            for (const entry of result.data.results ?? []) {
              const total = totals.get(entry.listId);
              if (!total) continue;
              if (entry.ok === false) total.error = entry.error;
              else {
                total.added += entry.added ?? 0;
                total.updated += entry.updated ?? 0;
                total.unchanged += entry.unchanged ?? 0;
                total.failed += entry.failed ?? 0;
              }
            }
          }

          modalResults(
            "Report.json imported",
            [...totals.entries()].map(([id, row]) => ({
              name: listName(id),
              ok: !row.error,
              text:
                row.error ??
                `${row.added} added · ${row.updated} updated · ${row.unchanged} already there${
                  row.failed ? ` · ${row.failed} skipped` : ""
                }`,
            })),
            `${reports.length} ${reports.length === 1 ? "report" : "reports"} read.`,
          );
          if (listState.list && targetIds.includes(listState.list.id)) {
            await loadList(listState.list.id);
          }
          return false;
        },
      },
    ],
  });
}

async function runRestore(backup, targetIds) {
  const sites = backup.sites ?? [];
  const batches = Array.isArray(backup.batches) ? backup.batches : [];
  const rows = [];
  const chunkSize = 15;

  for (const id of targetIds) {
    let restored = 0;
    let skipped = 0;
    let error = null;

    for (let index = 0; index < sites.length && !error; index += chunkSize) {
      const chunk = sites.slice(index, index + chunkSize);
      const chunkResult = await listApi(`/v1/lists/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        body: JSON.stringify({
          sites: chunk,
          batches: index === 0 ? batches : [],
        }),
      });
      if (!chunkResult.ok) {
        error = apiErrorMessage(chunkResult, "Could not restore this list.");
        break;
      }
      restored += chunkResult.data.restored ?? 0;
      skipped += chunkResult.data.skipped ?? 0;
    }

    rows.push({
      name: listName(id),
      ok: !error,
      text: error ?? `${restored} restored · ${skipped} skipped (already there)`,
    });
  }

  modalResults(
    "Backup restored",
    rows,
    `${sites.length} ${sites.length === 1 ? "site" : "sites"} in this backup.`,
  );
  if (listState.list && targetIds.includes(listState.list.id)) {
    await loadList(listState.list.id);
  }
}

/* --------------------------------------------------------------- exporting */

async function exportCsv() {
  const list = listState.list;
  if (!list) return;
  const button = $("list-export");
  button.disabled = true;
  try {
    const response = await fetch(`/v1/lists/${encodeURIComponent(list.id)}/export.csv`, {
      headers: listHeaders(),
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        if (typeof data?.error === "string") message = data.error;
      } catch {
        // not JSON; keep the status text
      }
      showListPageError(message);
      return;
    }
    downloadBlob(`sitescout-${slug(list.name)}.csv`, await response.blob());
  } catch {
    showListPageError("Could not reach the server to build the CSV.");
  } finally {
    button.disabled = false;
  }
}

async function backupList() {
  const list = listState.list;
  if (!list) return;
  const button = $("list-backup");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing…";

  try {
    const keys = listState.sites.map((site) => site.key);
    const sites = [];
    for (let index = 0; index < keys.length; index += 40) {
      const result = await listApi(`/v1/lists/${encodeURIComponent(list.id)}/sites`, {
        method: "POST",
        body: JSON.stringify({ keys: keys.slice(index, index + 40) }),
      });
      if (!result.ok) {
        showListPageError(apiErrorMessage(result, "Could not read the sites for the backup."));
        return;
      }
      sites.push(...(result.data.sites ?? []));
    }

    const payload = {
      format: "sitescout-list-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      list: {
        name: list.name,
        description: list.description,
        visibility: list.visibility,
      },
      batches: listState.batches,
      sites,
    };
    downloadText(
      `sitescout-${slug(list.name)}-backup.json`,
      JSON.stringify(payload, null, 2),
    );
  } catch {
    showListPageError("Could not reach the server to build the backup.");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ------------------------------------------------------------- create/manage */

function openCreateList() {
  const name = textInput({ placeholder: "Amsterdam bakeries", maxlength: "80" });
  const description = textInput({
    placeholder: "Optional: what this list is for",
    maxlength: "200",
  });
  const visibility = el("select", { class: "select" });
  visibility.append(el("option", { value: "public", text: "Public — shown on the Lists page" }));
  visibility.append(
    el("option", { value: "unlisted", text: "Unlisted — only people with the link" }),
  );
  if (listState.management === "key") {
    visibility.append(
      el("option", { value: "private", text: "Private — management key needed to read" }),
    );
  }

  openModal({
    title: "New list",
    body: [
      field("Name", name),
      field("Description", description),
      field("Who can see it", visibility),
    ],
    actions: [
      {
        label: "Create list",
        kind: "primary",
        onClick: async () => {
          if (!name.value.trim()) {
            modalError("Give the list a name.");
            return false;
          }
          const result = await listApi("/v1/lists", {
            method: "POST",
            body: JSON.stringify({
              name: name.value,
              description: description.value,
              visibility: visibility.value,
            }),
          });
          if (!result.ok) {
            modalError(apiErrorMessage(result, "Could not create the list."));
            return false;
          }
          const list = result.data.list;
          listState.lists.unshift(list);
          await openList(list.id, { push: true });
        },
      },
    ],
  });
  name.focus();
}

function openManageList() {
  const list = listState.list;
  if (!list) return;

  const name = textInput({ value: list.name, maxlength: "80" });
  const description = textInput({ value: list.description ?? "", maxlength: "200" });
  const visibility = el("select", { class: "select" });
  for (const option of [
    { value: "public", label: "Public — shown on the Lists page" },
    { value: "unlisted", label: "Unlisted — only people with the link" },
    ...(listState.management === "key"
      ? [{ value: "private", label: "Private — management key needed to read" }]
      : []),
  ]) {
    const node = el("option", { value: option.value, text: option.label });
    if (option.value === list.visibility) node.selected = true;
    visibility.append(node);
  }

  openModal({
    title: "Manage list",
    body: [
      field("Name", name),
      field("Description", description),
      field("Who can see it", visibility),
      el("div", { class: "danger-zone" }, [
        el("h3", { class: "section-title", text: "Careful" }),
        el("div", { class: "danger-row" }, [
          el("p", { class: "hint", text: "Empty the list but keep it, including its name and settings." }),
          el("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "Remove every site",
            onclick: () =>
              confirmAction({
                title: "Remove every site",
                message: `Remove all ${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"} from “${list.name}”? The reports are deleted; the batches are not touched.`,
                label: "Remove them",
                run: async () => {
                  const result = await listApi(
                    `/v1/lists/${encodeURIComponent(list.id)}/clear`,
                    { method: "POST", body: "{}" },
                  );
                  if (!result.ok) {
                    modalError(apiErrorMessage(result, "Could not empty the list."));
                    return false;
                  }
                  await loadList(list.id);
                },
              }),
          }),
        ]),
        el("div", { class: "danger-row" }, [
          el("p", { class: "hint", text: "Delete the list and everything in it. This cannot be undone." }),
          el("button", {
            class: "btn btn-danger",
            type: "button",
            text: "Delete list",
            onclick: () =>
              confirmAction({
                title: "Delete list",
                message: `Delete “${list.name}” and its ${list.siteCount} ${list.siteCount === 1 ? "site" : "sites"}? This cannot be undone.`,
                label: "Delete",
                run: async () => {
                  const result = await listApi(`/v1/lists/${encodeURIComponent(list.id)}`, {
                    method: "DELETE",
                  });
                  if (!result.ok) {
                    modalError(apiErrorMessage(result, "Could not delete the list."));
                    return false;
                  }
                  await openLists({ push: true });
                },
              }),
          }),
        ]),
      ]),
    ],
    actions: [
      {
        label: "Save changes",
        kind: "primary",
        onClick: async () => {
          if (!name.value.trim()) {
            modalError("The list needs a name.");
            return false;
          }
          const result = await listApi(`/v1/lists/${encodeURIComponent(list.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: name.value,
              description: description.value,
              visibility: visibility.value,
            }),
          });
          if (!result.ok) {
            modalError(apiErrorMessage(result, "Could not save the list."));
            return false;
          }
          listState.list = { ...listState.list, ...result.data.list };
          renderList();
        },
      },
    ],
  });
  name.focus();
}

function confirmAction({ title, message, label, run }) {
  openModal({
    title,
    body: el("p", { class: "hint", text: message }),
    actions: [
      { label: "Cancel" },
      {
        label,
        kind: "danger",
        onClick: async () => {
          const keep = await run();
          return keep === false ? false : undefined;
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ wiring */

$("batch-form").addEventListener("submit", submitBatch);
$("urls").addEventListener("input", updateCount);
$("file").addEventListener("change", (event) => {
  loadFile(event.target.files?.[0]);
  event.target.value = "";
});
$("clear-recent").addEventListener("click", () => {
  saveRecent([]);
  renderRecent();
});
$("retry").addEventListener("click", retryJob);
$("copy-link").addEventListener("click", copyLink);
$("job-add-list").addEventListener("click", () => openAddToList());
$("new-batch").addEventListener("click", () => goHome(true));
$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  if (state.job) renderResults(state.job);
});
$("sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  if (state.job) renderResults(state.job);
});

document.querySelectorAll("[data-home]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    goHome(true);
  });
});

document.querySelectorAll("[data-lists]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openLists({ push: true });
  });
});

/* ------------------------------------------------------------- list wiring */

$("lists-new").addEventListener("click", () => openCreateList());
$("lists-unlock").addEventListener("click", openKeyModal);
$("lists-import").addEventListener("click", () => openImportModal({}));
$("list-add-batch").addEventListener("click", () => openAddToList({}));
$("list-export").addEventListener("click", exportCsv);
$("list-backup").addEventListener("click", backupList);
$("list-import").addEventListener("click", () => openImportModal({}));
$("list-manage").addEventListener("click", openManageList);
$("list-unlock").addEventListener("click", openKeyModal);
$("modal-close").addEventListener("click", closeModal);

$("modal").addEventListener("click", (event) => {
  // Clicking the dimmed area outside the panel closes the dialog.
  if (event.target === $("modal")) closeModal();
});

$("list-search").addEventListener("input", (event) => {
  listState.query = event.target.value;
  renderListSites();
});
$("list-verdict").addEventListener("change", (event) => {
  listState.verdict = event.target.value;
  renderListSites();
});
$("list-status").addEventListener("change", (event) => {
  listState.status = event.target.value;
  renderListSites();
});
$("list-sort").addEventListener("change", (event) => {
  listState.sort = event.target.value;
  renderListSites();
});

$("list-select").addEventListener("click", () => {
  listState.selecting = !listState.selecting;
  listState.selected.clear();
  renderListSites();
});
$("bulk-all").addEventListener("click", () => {
  for (const site of visibleSites()) listState.selected.add(site.key);
  renderListSites();
});
$("bulk-apply").addEventListener("click", bulkStatus);
$("bulk-remove").addEventListener("click", bulkRemove);
$("bulk-cancel").addEventListener("click", () => {
  listState.selecting = false;
  listState.selected.clear();
  renderListSites();
});

window.addEventListener("popstate", () => {
  const listMatch = /^\/l\/([A-Za-z0-9_-]{20,32})\/?$/.exec(location.pathname);
  if (listMatch) {
    openList(listMatch[1]);
    return;
  }
  if (/^\/lists\/?$/.test(location.pathname)) {
    openLists();
    return;
  }
  const match = /^\/j\/([A-Za-z0-9_-]{20,32})\/?$/.exec(location.pathname);
  if (match) {
    openJob(match[1]);
    return;
  }
  stopPolling();
  state.jobId = null;
  state.job = null;
  state.notice = null;
  setView("home");
});

document.addEventListener("visibilitychange", () => {
  if (!state.jobId) return;
  if (document.hidden) stopPolling();
  else tick();
});

/* -------------------------------------------------------------------- boot */

renderRecent();
updateCount();

const listDeepLink = /^\/l\/([A-Za-z0-9_-]{20,32})\/?$/.exec(location.pathname);
const deepLink = /^\/j\/([A-Za-z0-9_-]{20,32})\/?$/.exec(location.pathname);
if (listDeepLink) openList(listDeepLink[1]);
else if (/^\/lists\/?$/.test(location.pathname)) openLists();
else if (deepLink) openJob(deepLink[1]);
else setView("home");
