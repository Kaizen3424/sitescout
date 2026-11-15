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
  completed: "Completed",
  failed: "Failed",
};

const SCORE_LABELS = {
  visual_modernity: "Visual modernity",
  layout_hierarchy: "Layout & hierarchy",
  typography_readability: "Typography",
  imagery_quality: "Imagery",
  conversion_clarity: "Offer & call-to-action",
  trust_professionalism: "Professional / trust",
};

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

const $ = (id) => document.getElementById(id);
const views = { home: $("view-home"), job: $("view-job") };

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

  const status = STATUS_LABELS[job.status] ?? job.status;
  const chip = $("job-status");
  chip.textContent = status;
  chip.dataset.tone = job.status;

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
  } else if (done === 0) {
    text.textContent = `0 of ${total} analysed · the first report usually arrives within a minute.`;
  } else {
    const remaining = total - done;
    const average = job.elapsed_s && done > 0 ? job.elapsed_s / done : 0;
    const eta = average > 0 ? ` · about ${formatDuration(average * remaining)} left` : "";
    text.textContent = `${done} of ${total} analysed${eta}. You can close this tab.`;
  }
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
  const unfinished = job.status !== "completed" && (job.done ?? 0) < (job.total ?? 0);

  retry.hidden = !unfinished || !job.canRetry;
  retry.disabled = false;
  retry.textContent = (job.done ?? 0) > 0 ? "Retry missing websites" : "Start analysis";

  if (state.notice) {
    note.textContent = state.notice;
    foot.hidden = false;
  } else if (unfinished) {
    note.textContent = job.canRetry
      ? "The batch is queued in the background. Nothing is lost if you close the tab."
      : "This batch cannot be restarted automatically. Start a new batch instead.";
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
  const scoreText = hasScore
    ? `need ${num(report.need_score)} · design ${num(report.design_quality * 10, 1)}/10`
    : "not scored";

  const summary = el("summary", {}, [
    el("span", { class: "verdict-tag", "data-tone": verdict.tone, text: verdict.label }),
    el("span", { class: "result-url", text: url, title: url }),
    el("span", { class: "result-score", text: scoreText }),
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
    meta.push(kv("Redesign need", `${num(report.need_score)} / 1.00`));
    meta.push(kv("Design quality", `${num(report.design_quality * 10, 1)} / 10`));
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
        return el("div", { class: "scale-row" }, [
          el("span", { text: SCORE_LABELS[key] }),
          el("span", { class: "scale-bar" }, [
            el("span", {
              "data-tone": tone,
              style: `width:${Math.max(2, Math.min(100, value * 10))}%`,
            }),
          ]),
          el("span", { class: "value", text: value.toFixed(1) }),
        ]);
      });
    if (rows.length > 0) sections.push(section("Design scores (0–10)", el("div", { class: "scale" }, rows)));
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

window.addEventListener("popstate", () => {
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

const deepLink = /^\/j\/([A-Za-z0-9_-]{20,32})\/?$/.exec(location.pathname);
if (deepLink) openJob(deepLink[1]);
else setView("home");
