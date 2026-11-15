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
