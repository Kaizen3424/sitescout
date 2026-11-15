/**
 * Capture: scrape a site with Firecrawl (raw HTML + one full-page screenshot).
 * The screenshot is never cropped, resized or recompressed by this code.
 */
import { CaptureError, DeadlineError, FatalApiError, NetworkError } from "./errors.js";
import type { Settings } from "./env.js";
import { USER_AGENT } from "./env.js";
import { errorMessage, fetchWithKeys, fetchWithRetry, safeJson } from "./http.js";
import type { KeyPool } from "./keys.js";
import type { Capture } from "./types.js";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

interface RequestOptions {
  signal?: AbortSignal;
  deadline: number;
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

async function firecrawlScrape(
  settings: Settings,
  pool: KeyPool,
  url: string,
  waitMs: number,
  fresh: boolean,
  opts: RequestOptions,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    url,
    formats: [
      "rawHtml",
      {
        type: "screenshot",
        fullPage: true,
        viewport: { width: settings.viewportW, height: settings.viewportH },
      },
    ],
    onlyMainContent: false,
    waitFor: waitMs,
    timeout: settings.scrapeTimeoutMs,
  };
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

export async function captureSite(
  url: string,
  settings: Settings,
  pool: KeyPool,
  fresh: boolean,
  opts: RequestOptions,
): Promise<Capture> {
  let lastError: CaptureError | null = null;

  for (let attempt = 1; attempt <= Math.max(1, settings.captureAttempts); attempt += 1) {
    const waitMs = settings.waitForMs * attempt; // give slow pages more time on a retry
    try {
      const data = await firecrawlScrape(settings, pool, url, waitMs, fresh, opts);
      const metadata =
        data.metadata && typeof data.metadata === "object"
          ? (data.metadata as Record<string, unknown>)
          : {};
      const status = asInt(metadata.statusCode);
      const html = typeof data.rawHtml === "string" ? data.rawHtml : typeof data.html === "string" ? data.html : "";
      if (status !== null && status >= 400) {
        throw new CaptureError(`target site returned HTTP ${status}`, classifyStatus(status, html));
      }
      const shotRef = data.screenshot;
      if (typeof shotRef !== "string" || shotRef.trim() === "") {
        throw new CaptureError("Firecrawl returned no screenshot");
      }
      const image = await downloadScreenshot(settings, shotRef, opts);
      const limit = Math.min(settings.maxImageBytes, MAX_INLINE_IMAGE_BYTES);
      if (image.length > limit) {
        throw new CaptureError(
          `screenshot is ${(image.length / 1e6).toFixed(1)} MB, above the ` +
            `${(limit / 1e6).toFixed(1)} MB safety limit (Google's inline limit is 20 MB); ` +
            "it was not resized or cropped",
        );
      }
      return {
        url,
        finalUrl: String(metadata.url ?? metadata.sourceURL ?? url),
        statusCode: status,
        html,
        title: String(metadata.title ?? ""),
        siteName: String(metadata.ogSiteName ?? metadata["og:site_name"] ?? ""),
        image,
        fetchedAt: Date.now(),
      };
    } catch (err) {
      if (err instanceof FatalApiError) throw err;
      if (err instanceof CaptureError) {
        if (err.kind === "down" || err.kind === "blocked") throw err; // retrying will not help
        lastError = err;
        console.warn(`capture attempt ${attempt}/${settings.captureAttempts} failed: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  throw lastError ?? new CaptureError("capture failed");
}
