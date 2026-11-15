/**
 * Rule-based HTML signals (no AI): HTTPS, viewport, stale copyright, legacy
 * tech, platform guess and contact discovery. Port of the Python `htmlchecks.py`.
 */
import type { Capture, ContactInfo, HtmlFlag, HtmlSignals } from "./types.js";

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?<![\d.])(\+?\(?\d[\d\s().-]{7,18}\d)(?!\d)/g;
const PHONE_CTX_RE = /call|tel|phone|mob|whatsapp|contact|\bph\b|enquir|book/i;
const COPY_RE = /(?:\u00a9|\(c\)|copyright)\s*(?:(?:19|20)\d{2}\s*[-\u2013\u2014]\s*)?((?:19|20)\d{2})/gi;

const BAD_EMAIL_DOMAINS = new Set([
  "example.com", "domain.com", "email.com", "yoursite.com", "yourdomain.com", "sentry.io",
  "wixpress.com", "sentry-next.wixpress.com", "test.com", "mysite.com",
]);
const BAD_EMAIL_LOCALS = new Set([
  "your", "name", "you", "email", "user", "username", "example", "yourname", "john", "info@info",
]);
const BAD_EMAIL_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".woff", ".woff2", ".ico"];

const SOCIAL: Record<string, string> = {
  "facebook.com": "facebook", "instagram.com": "instagram", "linkedin.com": "linkedin",
  "twitter.com": "x", "x.com": "x", "youtube.com": "youtube", "tiktok.com": "tiktok",
  "wa.me": "whatsapp", "whatsapp.com": "whatsapp", "t.me": "telegram",
};

const PLATFORMS: Array<[string, RegExp]> = [
  ["wix", /wixstatic\.com|parastorage\.com|wix\.com/i],
  ["weebly", /weebly\.com/i],
  ["squarespace", /squarespace/i],
  ["godaddy builder", /godaddy|secureserver\.net/i],
  ["shopify", /cdn\.shopify\.com/i],
  ["webflow", /webflow/i],
  ["framer", /framer\.(?:com|website)/i],
  ["wordpress", /wp-content|wp-includes/i],
];

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(ATTR_RE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    out[match[1]!.toLowerCase()] = value;
  }
  return out;
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, " ")
    .replace(/<script\b.*?<\/script>/gis, " ")
    .replace(/<style\b.*?<\/style>/gis, " ");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

function decodeCfEmail(hex: string): string | null {
  try {
    const key = Number.parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return out;
  } catch {
    return null;
  }
}

function cleanEmail(raw: string): string | null {
  const email = raw.trim().replace(/^[.,;:()<>[\]"']+|[.,;:()<>[\]"']+$/g, "").toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return null;
  if (BAD_EMAIL_EXTENSIONS.some((ext) => email.endsWith(ext))) return null;
  if (BAD_EMAIL_DOMAINS.has(domain)) return null;
  if (BAD_EMAIL_LOCALS.has(local) || /@\d+x\b/.test(email)) return null;
  return email;
}

export function guessBusinessName(cap: Capture): string {
  let title = cap.siteName || cap.title;
  if (!title) {
    const match = /<title[^>]*>(.*?)<\/title>/is.exec(cap.html);
    title = match ? decodeEntities(match[1]!).trim() : "";
  }
  if (!cap.siteName) {
    const generic = new Set(["home", "welcome", "homepage", "index", "official site", "official website", "main page"]);
    const segments = title
      .split(/\s*[|\u2013\u2014\u00b7\u2022:]\s*|\s+-\s+/)
      .map((s) => s.trim())
      .filter((s) => s && !generic.has(s.toLowerCase()));
    title = segments[0] ?? title;
  }
  return title.replace(/\s+/g, " ").slice(0, 60);
}

function emptyContact(): ContactInfo {
  return { emails: [], phones: [], whatsapp: null, contact_page: null, social: {}, has_form: false, best: null };
}

export function analyzeHtml(cap: Capture): HtmlSignals {
  const html = cap.html || "";
  const nowYear = new Date().getUTCFullYear();
  const contact = emptyContact();
  const result: HtmlSignals = {
    available: html.length >= 300,
    flags: [],
    checks: [],
    platform: null,
    generator: null,
    copyright_year: null,
    contact,
  };

  if (!result.available) {
    result.note = "HTML too short to analyse (JS-only page or blocked?)";
    return result;
  }

  const flag = (id: string, label: string, phrase: string, weight: number): void => {
    result.flags.push({ id, label, phrase, weight });
    result.checks.push({ ok: false, text: label });
  };
  const ok = (text: string): void => {
    result.checks.push({ ok: true, text });
  };

  // --- HTTPS (use the final URL after redirects) ---
  let servedOverHttp = false;
  try {
    servedOverHttp = new URL(cap.finalUrl).protocol === "http:";
  } catch {
    servedOverHttp = false; // unparseable final URL: don't claim anything
  }
  if (servedOverHttp) {
    flag("no_https", "Served over plain HTTP (browsers show 'Not secure')", "browsers label the site 'Not secure'", 0.25);
  } else {
    ok("HTTPS");
  }

  // --- meta tags ---
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  if (metas.some((m) => (m.name ?? "").toLowerCase() === "viewport")) {
    ok("Mobile viewport tag present");
  } else {
    flag("no_viewport", "No mobile viewport tag (probably not mobile-friendly)", "it doesn't appear to be optimised for mobile phones", 0.3);
  }

  const generator = metas.find((m) => (m.name ?? "").toLowerCase() === "generator")?.content ?? "";
  result.generator = generator || null;
  if (/frontpage|dreamweaver|microsoft word|joomla!? ?1\.|wordpress [1-4]\./i.test(generator)) {
    flag("legacy_generator", `Built with outdated tooling (${generator})`, "it was built with outdated website tooling", 0.15);
  }

  // --- legacy tech, libraries ---
  const assetUrls = [...html.matchAll(/<(?:script|link)\b[^>]*>/gi)]
    .map((m) => attrs(m[0]))
    .map((a) => `${a.src ?? ""} ${a.href ?? ""}`)
    .join(" ");
  const clean = stripNoise(html);
  const legacyTags = new Set(
    [...clean.matchAll(/<(marquee|blink|frameset|applet|bgsound|font|center)\b/gi)].map((m) => m[1]!.toLowerCase()),
  );
  if (/\.swf\b|shockwave/i.test(html)) legacyTags.add("flash");
  if (legacyTags.size > 0) {
    flag("legacy_tech", `Legacy HTML/tech found: ${[...legacyTags].sort().join(", ")}`, "it relies on legacy web technology", 0.25);
  }
  if (/jquery(?:[-./@])?v?(?:1|2)\.\d+/i.test(assetUrls) || /bootstrap(?:\.min)?[-./@]*v?(?:2|3)\.\d/i.test(assetUrls)) {
    flag("old_libs", "Old jQuery (1.x/2.x) or Bootstrap (2/3) detected", "it runs on old front-end libraries", 0.15);
  }

  const tables = [...clean.matchAll(/<table\b/gi)].length;
  const divs = [...clean.matchAll(/<div\b/gi)].length;
  if (tables >= 4 && divs <= 2 * tables) {
    flag("table_layout", "Likely table-based page layout", "its page layout is built the way sites were in the 2000s", 0.2);
  }

  const head = html.slice(0, 1500);
  if (!/<!doctype\s+html\s*>/i.test(head) && /xhtml|html 4|transitional|^\s*<html/im.test(head)) {
    flag("legacy_doctype", "Old or missing HTML5 doctype", "its underlying code is outdated", 0.1);
  }

  // --- stale copyright year ---
  const text = decodeEntities(clean.replace(/<[^>]+>/g, " "));
  const years = [...text.matchAll(COPY_RE)]
    .map((m) => Number.parseInt(m[1]!, 10))
    .filter((y) => y >= 1995 && y <= nowYear + 1);
  if (years.length > 0) {
    const year = Math.max(...years);
    result.copyright_year = year;
    const age = nowYear - year;
    if (age >= 4) {
      flag("stale_copyright", `Footer copyright is ${year} (${age} years old)`, `the footer still says \u00a9 ${year}, which makes it look unmaintained`, 0.2);
    } else if (age >= 2) {
      flag("stale_copyright", `Footer copyright is ${year}`, `the footer still says \u00a9 ${year}`, 0.1);
    } else {
      ok(`Footer copyright is recent (${year})`);
    }
  }

  // --- platform ---
  for (const [name, pattern] of PLATFORMS) {
    if (pattern.test(html)) {
      result.platform = name;
      break;
    }
  }

  // --- contact discovery ---
  let whatsapp: string | null = null;
  let contactPage: string | null = null;
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = (attrs(match[0]).href ?? "").trim();
    const low = href.toLowerCase();
    if (low.startsWith("mailto:")) {
      const email = cleanEmail(decodeEntities(href.slice(7).split("?")[0] ?? ""));
      if (email && !contact.emails.includes(email)) contact.emails.push(email);
    } else if (low.startsWith("tel:")) {
      const phone = href.slice(4).replace(/[^\d+]/g, "");
      const digits = phone.replace(/\D/g, "").length;
      if (digits >= 8 && digits <= 15 && !contact.phones.includes(phone)) contact.phones.push(phone);
    } else if (low.startsWith("http") || low.startsWith("//")) {
      let host = "";
      try {
        host = new URL(low.startsWith("http") ? href : `https:${href}`).hostname.toLowerCase();
      } catch {
        host = "";
      }
      host = host.startsWith("www.") ? host.slice(4) : host;
      const network = SOCIAL[host];
      if (network && !/sharer|\/share|intent\/|dialog\//.test(low)) {
        contact.social[network] ??= href;
        if (network === "whatsapp") whatsapp ??= href;
      }
    }
    if (
      contactPage === null &&
      /contact|reach-us|get-in-touch|enquir/.test(low) &&
      href &&
      !low.startsWith("mailto:") &&
      !low.startsWith("tel:") &&
      !low.startsWith("#") &&
      !low.startsWith("javascript:")
    ) {
      try {
        contactPage = new URL(href, cap.finalUrl).toString();
      } catch {
        contactPage = null;
      }
    }
  }
  contact.whatsapp = whatsapp;
  contact.contact_page = contactPage;

  for (const match of html.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/gi)) {
    const email = cleanEmail(decodeCfEmail(match[1]!) ?? "");
    if (email && !contact.emails.includes(email)) contact.emails.push(email);
  }

  for (const match of text.matchAll(EMAIL_RE)) {
    const email = cleanEmail(match[0]);
    if (email && !contact.emails.includes(email)) contact.emails.push(email);
  }

  for (const match of text.matchAll(PHONE_RE)) {
    const raw = match[1]!;
    const digits = raw.replace(/\D/g, "");
    const context = text.slice(Math.max(0, match.index - 30), match.index);
    if (digits.length >= 9 && digits.length <= 14 && (raw.startsWith("+") || PHONE_CTX_RE.test(context))) {
      const normalized = (raw.startsWith("+") ? "+" : "") + digits;
      const stripped = normalized.replace(/^\+/, "");
      const duplicate = contact.phones.some((existing) => {
        const e = existing.replace(/^\+/, "");
        return stripped.endsWith(e) || e.endsWith(stripped);
      });
      if (!contact.phones.includes(normalized) && !duplicate) contact.phones.push(normalized);
    }
  }

  contact.has_form = /<form\b/i.test(clean);
  contact.emails = contact.emails.slice(0, 5);
  contact.phones = contact.phones.slice(0, 5);

  if (contact.emails.length > 0) contact.best = `email ${contact.emails[0]}`;
  else if (contact.whatsapp) contact.best = `WhatsApp ${contact.whatsapp}`;
  else if (contact.phones.length > 0) contact.best = `phone ${contact.phones[0]}`;
  else if (contact.contact_page || contact.has_form) contact.best = `contact form/page ${contact.contact_page ?? cap.finalUrl}`;
  else {
    const firstSocial = Object.entries(contact.social)[0];
    contact.best = firstSocial ? `${firstSocial[0]} ${firstSocial[1]}` : null;
  }

  return result;
}
