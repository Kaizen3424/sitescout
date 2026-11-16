/** Error types shared by the API modules. */

export class SiteScoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends SiteScoutError {}

export class InvalidUrlError extends SiteScoutError {}

export class NetworkError extends SiteScoutError {}

/** Every configured key is rejected or out of credits: retrying is pointless. */
export class FatalApiError extends SiteScoutError {}

/**
 * Every key of a pool is cooling down, so no request was sent at all.
 *
 * `retryAfterMs` is how long until the soonest key is usable again; the
 * caller decides whether to wait or to requeue the work.
 */
export class KeyUnavailableError extends SiteScoutError {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = Math.max(1_000, Math.round(retryAfterMs));
  }
}

/** The overall request ran out of its Vercel time budget. */
export class DeadlineError extends SiteScoutError {}

export type CaptureErrorKind = "down" | "blocked" | "failed";

export class CaptureError extends SiteScoutError {
  readonly kind: CaptureErrorKind;

  constructor(message: string, kind: CaptureErrorKind = "failed") {
    super(message);
    this.kind = kind;
  }
}

/**
 * The model is temporarily out of quota.
 *
 * This is retryable: the caller should put the work back in the queue with a
 * delay instead of writing an "unscored" report. `scope` says which limit
 * was hit, `retryAfterMs` says how long to wait.
 */
export class QuotaDeferredError extends SiteScoutError {
  readonly retryAfterMs: number;
  readonly scope: "minute" | "day";

  constructor(message: string, opts: { retryAfterMs: number; scope?: "minute" | "day" }) {
    super(message);
    this.retryAfterMs = Math.max(1_000, Math.round(opts.retryAfterMs));
    this.scope = opts.scope ?? "minute";
  }
}

export type DecisionErrorKind = "failed" | "safety" | "quota";

export class DecisionError extends SiteScoutError {
  readonly kind: DecisionErrorKind;

  constructor(message: string, kind: DecisionErrorKind = "failed") {
    super(message);
    this.kind = kind;
  }
}

/** The model answered a 200 response in a shape we do not understand. */
export class ShapeError extends SiteScoutError {}
