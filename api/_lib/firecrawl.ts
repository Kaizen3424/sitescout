/**
 * Capture: scrape a site with Firecrawl (raw HTML + three 1440x900 frames of
 * the page). The frames are never cropped, resized or recompressed by this code.
 *
 * Firecrawl's full-page mode uses a 100,000 px tall viewport. Sites with
 * viewport-based layout or scroll animations react to it, stretching sections
 * and pasting panels over the hero; Gemini then downsizes the tall strip to
 * ~1,100 vision tokens, so text is unreadable. Three real viewport-sized
 * frames - top, middle and bottom - keep the same cost per image and remove the
 * capture variance. One scrape, one Firecrawl credit.
 */
import { createHash } from "node:crypto";
import { CaptureError, DeadlineError, FatalApiError, NetworkError } from "./errors.js";
import type { Settings } from "./env.js";
import { USER_AGENT } from "./env.js";
import { errorMessage, fetchWithKeys, fetchWithRetry, safeJson } from "./http.js";
import type { KeyPool } from "./keys.js";
import type { Capture } from "./types.js";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const FRAME_COUNT = 3;
const MIN_FRAME_BYTES = 12_000;

interface RequestOptions {
  signal?: AbortSignal;
  deadline: number;
}

interface Frame {
  buffer: Buffer;
  digest: string;
}

function asInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function classifyFailure(message: string): CaptureError["kind"] {
  const m = (message || "").toLowerCase();
  if (
    ["dns", "resolve", "name_not_resolved", "ssl", "certificate", "cert_", "err_connection",
      "connection refused", "unreachable", "no such host"].some((k) => m.includes(k))
  ) {
    return "down";
  }
  if (["captcha", "blocked", "forbidden", "access denied", "bot"].some((k) => m.includes(k))) {
    return "blocked";
  }
  return "failed";
}

function classifyStatus(status: number, html: string): CaptureError["kind"] {
  const head = (html || "").slice(0, 4000).toLowerCase();
  if (
    [401, 403, 429, 451].includes(status) ||
    ["captcha", "cf-chl", "just a moment", "access denied", "attention required",
      "verify you are human", "bot detection"].some((k) => head.includes(k))
  ) {
    return "blocked";
  }
  if ([404, 410].includes(status) || status >= 500) return "down";
  return "blocked";
}

// ---- the in-page scripts that prepare the three frames ---------------------
// Animations are frozen and scroll-reveal elements made visible; transforms of
// individual elements are left alone (sliders rely on them).
const PREPARE_JS = [
  "(() => {",
  "const s = document.createElement('style');",
  "s.setAttribute('data-sitescout', 'capture');",
  "s.textContent = [",
  "'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',",
  "'html{scroll-behavior:auto!important}',",
  "'[class*=reveal],[class*=fade],[data-aos],[data-scroll],[data-animate]",
  "{opacity:1!important;visibility:visible!important}'",
  "].join('');",
  "document.head.appendChild(s);",
  "return 'prepared';",
  "})()",
].join("");

const RESET_JS = [
  "(() => {",
  "document.body.style.transform = '';",
  "const s = document.querySelector('style[data-sitescout=\"capture\"]');",
  "if (s) s.remove();",
  "return 'reset';",
  "})()",
].join("");

/** Percentage transforms resolve at render time, after the 1440x900 reflow. */
function frameTransforms(viewportH: number): string[] {
  const half = Math.max(1, Math.floor(viewportH / 2));
  return [
    "translateY(0px)",
    `translateY(min(0px, calc(-50% + ${half}px)))`,
    `translateY(min(0px, calc(-100% + ${viewportH}px)))`,
  ];
}

function captureActions(settings: Settings): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [
    { type: "wait", milliseconds: settings.waitForMs },
    { type: "executeJavascript", script: PREPARE_JS },
    { type: "wait", milliseconds: 300 },
  ];
  for (const transform of frameTransforms(settings.viewportH)) {
    actions.push({
      type: "executeJavascript",
      script: `(() => { document.body.style.transform = '${transform}'; return 'moved'; })()`,
    });
    actions.push({ type: "wait", milliseconds: 250 });
    actions.push({
      type: "screenshot",
      fullPage: false,
      viewport: { width: settings.viewportW, height: settings.viewportH },
    });
  }
  actions.push({ type: "executeJavascript", script: RESET_JS }); // keep the saved HTML clean
  return actions;
}

async function firecrawlScrape(
  settings: Settings,
  pool: KeyPool,
  url: string,
  waitMs: number,
  fresh: boolean,
  frames: boolean,
  opts: RequestOptions,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    url,
    formats: ["rawHtml"],
    onlyMainContent: false,
    timeout: settings.scrapeTimeoutMs,
  };
  if (frames) {
    body.waitFor = 0; // the first action waits instead
    body.actions = captureActions(settings);
  } else {
    body.waitFor = waitMs;
    body.formats = [
      "rawHtml",
      {
        type: "screenshot",
        fullPage: false,
        viewport: { width: settings.viewportW, height: settings.viewportH },
      },
    ];
  }
  if (fresh) body.maxAge = 0; // bypass Firecrawl's own cache too

  let res: Response;
  try {
    res = await fetchWithKeys(FIRECRAWL_SCRAPE_URL, {
      pool,
      buildInit: (key) => ({
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      }),
      label: "Firecrawl",
      retries: settings.httpRetries,
      backoff: settings.backoffBase,
      timeoutMs: settings.scrapeTimeoutMs + 30_000,
      deadline: opts.deadline,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof NetworkError) throw new CaptureError(err.message);
    throw err;
  }

  const payload = await safeJson(res);
  const message = errorMessage(payload, res);

  if (res.status === 401) {
    throw new FatalApiError("All Firecrawl API keys were rejected (401). Check FIRECRAWL_API_KEYS.");
  }
  if (res.status === 402) {
    throw new FatalApiError("All Firecrawl API keys are out of credits (402). Add keys or top up.");
  }
  if (res.status === 429) {
    throw new CaptureError("All Firecrawl API keys are rate-limited (429).");
  }
  if (res.status >= 400) {
    throw new CaptureError(`Firecrawl HTTP ${res.status}: ${message}`, classifyFailure(message));
  }
  if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).success === false) {
    throw new CaptureError(`Firecrawl scrape failed: ${message}`, classifyFailure(message));
  }
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") throw new CaptureError("Firecrawl response had no 'data' object");
  return data as Record<string, unknown>;
}

/** The screenshot URLs of one scrape, in page order. */
function screenshotRefs(data: Record<string, unknown>): string[] {
  const actions = data.actions && typeof data.actions === "object"
    ? (data.actions as Record<string, unknown>)
    : null;
  const shots = actions && Array.isArray(actions.screenshots) ? actions.screenshots : [];
  const refs = shots.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (refs.length) return refs.slice(0, FRAME_COUNT);
  const single = data.screenshot;
  return typeof single === "string" && single.trim() ? [single] : [];
}

/** Firecrawl returns a 24h URL; some clients return base64. Handle both. */
async function downloadScreenshot(
  settings: Settings,
  ref: string,
  opts: RequestOptions,
): Promise<Buffer> {
  const value = ref.trim();
  try {
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      if (comma < 0) throw new CaptureError("screenshot data URL had no payload");
      return Buffer.from(value.slice(comma + 1), "base64");
    }
    if (value.startsWith("http://") || value.startsWith("https://")) {
      // No Authorization header: this is a storage URL, not the Firecrawl API.
      const res = await fetchWithRetry(value, { headers: { "User-Agent": USER_AGENT } }, {
        retries: settings.httpRetries,
        backoff: settings.backoffBase,
        timeoutMs: 60_000,
        label: "screenshot download",
        deadline: opts.deadline,
        signal: opts.signal,
      });
      if (res.status !== 200) throw new CaptureError(`screenshot download failed (HTTP ${res.status})`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw new CaptureError("screenshot download was empty");
      return buffer;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new CaptureError("screenshot reference was not a URL or valid base64");
    }
    const buffer = Buffer.from(value, "base64");
    if (buffer.length === 0) throw new CaptureError("screenshot base64 was empty");
    return buffer;
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    if (err instanceof DeadlineError) throw err;
    if (err instanceof NetworkError) throw new CaptureError(err.message);
    throw new CaptureError("screenshot reference could not be decoded");
  }
}

async function downloadFrames(
  settings: Settings,
  refs: string[],
  opts: RequestOptions,
): Promise<Buffer[]> {
  const downloaded: Buffer[] = [];
  for (const ref of refs) {
    try {
      downloaded.push(await downloadScreenshot(settings, ref, opts));
    } catch (err) {
      if (err instanceof CaptureError) {
        console.warn(`could not download a frame: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  if (!downloaded.length) throw new CaptureError("screenshot download failed");

  // Drop duplicates (a one-screen page renders the same frame three times) and
  // near-blank bands (a loading state), but never end up with zero frames.
  const seen = new Set<string>();
  const unique: Frame[] = [];
  for (const buffer of downloaded) {
    const digest = createHash("sha1").update(buffer).digest("hex");
    if (seen.has(digest)) {
      console.info("dropping a duplicate frame");
      continue;
    }
    seen.add(digest);
    unique.push({ buffer, digest });
  }
  const biggest = Math.max(...unique.map((f) => f.buffer.length));
  const kept = unique
    .filter((f) => f.buffer.length >= MIN_FRAME_BYTES && f.buffer.length >= biggest * 0.12)
    .map((f) => f.buffer);
  if (!kept.length) {
    console.info("all frames look blank; keeping the first for the page check");
    return [unique[0]!.buffer];
  }
  if (kept.length < unique.length) {
    console.info(`dropped ${unique.length - kept.length} near-blank frame(s)`);
  }
  return kept;
}

function checkSize(buffer: Buffer, settings: Settings): void {
  const limit = Math.min(settings.maxImageBytes, MAX_INLINE_IMAGE_BYTES);
  if (buffer.length > limit) {
    throw new CaptureError(
      `screenshot is ${(buffer.length / 1e6).toFixed(1)} MB, above the ` +
        `${(limit / 1e6).toFixed(1)} MB safety limit (Google's inline limit is 20 MB); ` +
        "it was not resized or cropped",
    );
  }
}

export async function captureSite(
  url: string,
  settings: Settings,
  pool: KeyPool,
  fresh: boolean,
  opts: RequestOptions,
): Promise<Capture> {
  let lastError: CaptureError | null = null;
  const attempts = Math.max(1, settings.captureAttempts);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const waitMs = settings.waitForMs * attempt; // give slow pages more time on a retry
    try {
      const data = await firecrawlScrape(settings, pool, url, waitMs, fresh, true, opts);
      const metadata =
        data.metadata && typeof data.metadata === "object"
          ? (data.metadata as Record<string, unknown>)
          : {};
      const status = asInt(metadata.statusCode);
      const html = typeof data.rawHtml === "string" ? data.rawHtml : typeof data.html === "string" ? data.html : "";
      if (status !== null && status >= 400) {
        throw new CaptureError(`target site returned HTTP ${status}`, classifyStatus(status, html));
      }
      const refs = screenshotRefs(data);
      if (!refs.length) throw new CaptureError("Firecrawl returned no screenshot");
      const images = await downloadFrames(settings, refs, opts);
      images.forEach((image) => checkSize(image, settings));
      if (images.length < FRAME_COUNT) {
        console.info(`capture returned ${images.length} of ${FRAME_COUNT} frames`);
      }
      return {
        url,
        finalUrl: String(metadata.url ?? metadata.sourceURL ?? url),
        statusCode: status,
        html,
        title: String(metadata.title ?? ""),
        siteName: String(metadata.ogSiteName ?? metadata["og:site_name"] ?? ""),
        images,
        fetchedAt: Date.now(),
      };
    } catch (err) {
      if (err instanceof FatalApiError) throw err;
      if (err instanceof CaptureError) {
        if (err.kind === "down" || err.kind === "blocked") throw err; // retrying will not help
        lastError = err;
        console.warn(`multi-frame capture attempt ${attempt}/${attempts} failed: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  // Last resort: one plain first-screen screenshot, the most reliable path.
  console.warn(`falling back to a single first-screen capture for ${url}`);
  try {
    const data = await firecrawlScrape(settings, pool, url, settings.waitForMs * attempts, fresh, false, opts);
    const metadata =
      data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, unknown>)
        : {};
    const status = asInt(metadata.statusCode);
    const html = typeof data.rawHtml === "string" ? data.rawHtml : typeof data.html === "string" ? data.html : "";
    if (status !== null && status >= 400) {
      throw new CaptureError(`target site returned HTTP ${status}`, classifyStatus(status, html));
    }
    const refs = screenshotRefs(data);
    if (!refs.length) throw new CaptureError("Firecrawl returned no screenshot");
    const images = await downloadFrames(settings, refs, opts);
    images.forEach((image) => checkSize(image, settings));
    return {
      url,
      finalUrl: String(metadata.url ?? metadata.sourceURL ?? url),
      statusCode: status,
      html,
      title: String(metadata.title ?? ""),
      siteName: String(metadata.ogSiteName ?? metadata["og:site_name"] ?? ""),
      images,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    if (err instanceof FatalApiError) throw err;
    if (err instanceof CaptureError && (err.kind === "down" || err.kind === "blocked")) throw err;
    throw err instanceof CaptureError ? (lastError ?? err) : err;
  }
}
