/** URL validation and cleanup, mirroring the Python `urls.py`. */
import { isIP } from "node:net";
import { InvalidUrlError } from "./errors.js";

const EDGE_CHARS = new Set(["<", ">", '"', "'", "\u201c", "\u201d", "\u2018", "\u2019"]);

function trimEdges(value: string): string {
  let s = value.trim();
  while (s.length > 0 && EDGE_CHARS.has(s[0]!)) s = s.slice(1);
  while (s.length > 0 && EDGE_CHARS.has(s[s.length - 1]!)) s = s.slice(0, -1);
  return s.replace(/[.,;]+$/, "").trim();
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateHost(host: string): boolean {
  if (host.startsWith("[") || isIP(host) === 6) {
    // Bracketless IPv6 from URL.hostname. Only the obvious local ranges matter here.
    const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
    return bare === "::1" || bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80");
  }
  return isPrivateIpv4(host);
}

/** Adds https:// when missing, rejects non-public or malformed addresses. */
export function normalizeUrl(raw: string): string {
  const s = trimEdges(raw ?? "");
  if (!s || /\s/.test(s)) {
    throw new InvalidUrlError(`'${raw}' is not a valid website address`);
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new InvalidUrlError(`'${raw}' is not a valid website address`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError(`Unsupported URL scheme '${parsed.protocol.replace(":", "")}' (use http/https)`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes(".") || /\.(local|internal|localhost)$/.test(host)) {
    throw new InvalidUrlError(`'${raw}' doesn't look like a public website address`);
  }
  if (isPrivateHost(host)) {
    throw new InvalidUrlError(`'${host}' is a private address; Firecrawl can't reach it`);
  }

  // Keep the input shape close to what the Python CLI reports.
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    return `${parsed.protocol}//${parsed.host}`;
  }
  return parsed.toString();
}
