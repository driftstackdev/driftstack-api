// Smart cookie IMPORT for the simulator cookies pane (founder #48: "Make cookie
// import really smart so it takes many formats to keep customers happy").
//
// parseCookies(text) AUTO-DETECTS the input format and normalizes every cookie
// to ONE shape — the server CookieSchema that POST /v1/agent-sessions/:id/cookies/set
// validates (so a parsed jar is accepted verbatim by setAgentSessionCookies, and
// an exported cookies.json/cookies.txt round-trips 1:1 back to it).
//
// Formats accepted (sniffed, no caller hint needed):
//   - Netscape / cookies.txt   (TAB-separated; `#` comments; `#HttpOnly_` prefix)
//   - JSON array of cookie objects (EditThisCookie / Puppeteer / a bare array)
//   - JSON single object, or a {cookies:[...]} / Playwright-storageState wrapper
//   - a raw HTTP `Cookie:` header string  ("a=1; b=2")  — name/value pairs
//   - simple `name=value` newline-separated pairs
//
// NEVER throws on bad input: malformed lines/objects are SKIPPED and reported in
// `warnings`. The caller decides whether to import the (possibly partial) jar.
//
// Pure functions, no React/DOM deps (testable in node/jsdom).

/** The normalized cookie shape — EXACTLY the server CookieSchema that
 *  POST /:id/cookies/set accepts (== the GUI's `SessionCookie`). `expires` is
 *  unix MILLISECONDS or null/omitted (session cookie); `sameSite` is the
 *  capitalized policy or null. Optional fields are only present when known so
 *  the route's lenient schema applies its own defaults. */
export interface NormalizedCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | null;
}

/** A detected source format (for the UI to echo "imported N cookies from <fmt>"). */
export type ImportFormat = 'json' | 'netscape' | 'header' | 'keyvalue' | 'empty' | 'unknown';

export interface ParseCookiesOptions {
  /** Domain to stamp on cookies that carry none (a raw `Cookie:` header or bare
   *  `name=value` pairs have no domain). When unset, such cookies are SKIPPED
   *  with a warning (the route requires a domain). */
  defaultDomain?: string;
}

export interface ParseCookiesResult {
  cookies: NormalizedCookie[];
  format: ImportFormat;
  /** Non-fatal issues — skipped lines, missing domains, dropped entries. Empty
   *  when everything parsed cleanly. */
  warnings: string[];
}

const DEFAULT_PATH = '/';

/** Coerce an arbitrary value to a clean string, or null if it isn't usable. */
function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** Normalize a sameSite value from any casing/spelling to the schema's enum.
 *  Accepts 'lax'/'strict'/'none' (any case), the browser-internal
 *  'no_restriction'→None / 'unspecified'→null aliases (EditThisCookie), and
 *  null/absent → null. An unrecognized value → null (dropped, not invalid). */
function normalizeSameSite(v: unknown): 'Strict' | 'Lax' | 'None' | null {
  if (v === null || v === undefined) return null;
  const s = asString(v);
  if (s === null) return null;
  switch (s.trim().toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'none':
    case 'no_restriction':
      return 'None';
    default:
      // 'unspecified' / '' / anything else → unset.
      return null;
  }
}

/** Normalize an expiry from the many shapes exports use into unix MILLISECONDS
 *  (the route's unit), or null for a session cookie. Accepts:
 *   - number in SECONDS (cookies.txt, EditThisCookie `expirationDate`) — the
 *     common case; values < 1e12 are treated as seconds and *1000.
 *   - number already in MILLISECONDS (>= 1e12) — passed through.
 *   - numeric string — parsed as above.
 *   - 0 / null / undefined / non-finite → null (session cookie). */
function normalizeExpires(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim().length > 0) n = Number(v);
  else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Heuristic: a 13-digit epoch is ms; a 10-digit epoch is seconds. 1e12 ms is
  // ~2001, so any plausible future expiry in ms is >= 1e12, and any in seconds
  // is < 1e12 — a clean split.
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

/** Build a NormalizedCookie from already-extracted parts, applying defaults and
 *  only setting optional fields when meaningful. Returns null (with no throw) if
 *  the mandatory name is empty. */
function buildCookie(parts: {
  domain: string;
  name: string;
  value: string;
  path?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | null;
}): NormalizedCookie | null {
  if (parts.name.length === 0) return null;
  const c: NormalizedCookie = {
    domain: parts.domain,
    name: parts.name,
    value: parts.value,
    path: parts.path !== undefined && parts.path.length > 0 ? parts.path : DEFAULT_PATH,
  };
  if (parts.expires !== undefined) c.expires = parts.expires;
  if (parts.httpOnly !== undefined) c.httpOnly = parts.httpOnly;
  if (parts.secure !== undefined) c.secure = parts.secure;
  if (parts.sameSite !== undefined && parts.sameSite !== null) c.sameSite = parts.sameSite;
  return c;
}

// ── JSON ──────────────────────────────────────────────────────────────────

/** Pull the cookie array out of any JSON cookie export:
 *   - a bare array → itself
 *   - {cookies:[...]} (EditThisCookie wrapper, Playwright storageState) → .cookies
 *   - a single cookie object → [it]
 *  Returns null when nothing array-like is found. */
function extractJsonCookieArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed as unknown[];
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.cookies)) return obj.cookies as unknown[];
    // A single cookie object — must at least carry a name to qualify.
    if (typeof obj.name === 'string') return [obj];
  }
  return null;
}

/** Normalize one JSON cookie object (EditThisCookie / Puppeteer / Playwright /
 *  our own export). Tolerant of field aliases: `name`/`key`, `value`,
 *  `domain`/`host`, `path`, `expires`/`expirationDate`/`expiry`, `httpOnly`/
 *  `httponly`, `secure`, `sameSite`/`samesite`. Returns null (+ a warning via
 *  the caller's index) when it lacks a name/domain. */
function normalizeJsonCookie(
  raw: unknown,
  defaultDomain: string | undefined,
  warnings: string[],
  index: number,
): NormalizedCookie | null {
  if (raw === null || typeof raw !== 'object') {
    warnings.push(`cookie #${index + 1}: not an object — skipped`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const name = asString(o.name ?? o.key) ?? '';
  if (name.length === 0) {
    warnings.push(`cookie #${index + 1}: missing name — skipped`);
    return null;
  }
  let domain = asString(o.domain ?? o.host) ?? '';
  if (domain.length === 0) {
    if (defaultDomain !== undefined && defaultDomain.length > 0) {
      domain = defaultDomain;
    } else {
      warnings.push(`cookie "${name}": missing domain and no default — skipped`);
      return null;
    }
  }
  const value = asString(o.value) ?? '';
  const pathStr = asString(o.path);
  const httpOnlyRaw = o.httpOnly ?? o.httponly;
  const secureRaw = o.secure;
  const sameSiteRaw = o.sameSite ?? o.samesite;
  const expiresRaw = o.expires ?? o.expirationDate ?? o.expiry;

  return buildCookie({
    domain,
    name,
    value,
    ...(pathStr !== null ? { path: pathStr } : {}),
    expires: normalizeExpires(expiresRaw),
    ...(httpOnlyRaw !== undefined ? { httpOnly: httpOnlyRaw === true } : {}),
    ...(secureRaw !== undefined ? { secure: secureRaw === true } : {}),
    sameSite: normalizeSameSite(sameSiteRaw),
  });
}

function parseJson(
  text: string,
  defaultDomain: string | undefined,
  warnings: string[],
): NormalizedCookie[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push('input looked like JSON but failed to parse');
    return null;
  }
  const arr = extractJsonCookieArray(parsed);
  if (arr === null) {
    warnings.push('JSON did not contain a cookie array or object');
    return [];
  }
  const out: NormalizedCookie[] = [];
  arr.forEach((raw, i) => {
    const c = normalizeJsonCookie(raw, defaultDomain, warnings, i);
    if (c !== null) out.push(c);
  });
  return out;
}

// ── Netscape / cookies.txt ──────────────────────────────────────────────────

function parseNetscape(
  text: string,
  defaultDomain: string | undefined,
  warnings: string[],
): NormalizedCookie[] {
  const out: NormalizedCookie[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    // Comment lines — but `#HttpOnly_` is a DATA line with the httpOnly marker.
    let httpOnly = false;
    let body = line;
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#HttpOnly_')) {
        httpOnly = true;
        // Strip the prefix from the FIRST field (the domain) only.
        body = line.replace(/#HttpOnly_/, '');
      } else {
        return; // ordinary comment / header
      }
    }
    const fields = body.split('\t');
    if (fields.length < 7) {
      warnings.push(`line ${i + 1}: not 7 tab-separated fields — skipped`);
      return;
    }
    // domain  includeSubdomains  path  secure  expiry  name  value
    // value (the last field) may legitimately contain tabs — rejoin the tail.
    const domain = (fields[0] ?? '').trim();
    const path = (fields[2] ?? '').trim();
    const secure = (fields[3] ?? '').trim().toUpperCase() === 'TRUE';
    const expirySec = fields[4] ?? '';
    const name = (fields[5] ?? '').trim();
    const value = fields.slice(6).join('\t');
    let dom = domain;
    if (dom.length === 0) {
      if (defaultDomain !== undefined && defaultDomain.length > 0) dom = defaultDomain;
      else {
        warnings.push(`line ${i + 1}: missing domain — skipped`);
        return;
      }
    }
    const c = buildCookie({
      domain: dom,
      name,
      value,
      path,
      expires: normalizeExpires(expirySec),
      httpOnly,
      secure,
    });
    if (c === null) {
      warnings.push(`line ${i + 1}: missing name — skipped`);
      return;
    }
    out.push(c);
  });
  return out;
}

// ── HTTP Cookie header  ("a=1; b=2")  ────────────────────────────────────────

function parseHeader(
  text: string,
  defaultDomain: string | undefined,
  warnings: string[],
): NormalizedCookie[] {
  if (defaultDomain === undefined || defaultDomain.length === 0) {
    warnings.push(
      'Cookie header has no domain and no default domain was provided — nothing imported',
    );
    return [];
  }
  const out: NormalizedCookie[] = [];
  // Drop a leading "Cookie:" label if the user pasted the whole header.
  const stripped = text.replace(/^\s*cookie\s*:/i, '');
  for (const pair of stripped.split(';')) {
    const seg = pair.trim();
    if (seg.length === 0) continue;
    const eq = seg.indexOf('=');
    if (eq < 1) {
      warnings.push(`cookie segment "${seg}": no name=value — skipped`);
      continue;
    }
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    const c = buildCookie({ domain: defaultDomain, name, value });
    if (c !== null) out.push(c);
  }
  return out;
}

// ── Simple key=value newline pairs ───────────────────────────────────────────

function parseKeyValue(
  text: string,
  defaultDomain: string | undefined,
  warnings: string[],
): NormalizedCookie[] {
  if (defaultDomain === undefined || defaultDomain.length === 0) {
    warnings.push(
      'name=value pairs have no domain and no default domain was provided — nothing imported',
    );
    return [];
  }
  const out: NormalizedCookie[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const seg = line.trim();
    if (seg.length === 0 || seg.startsWith('#')) return;
    const eq = seg.indexOf('=');
    if (eq < 1) {
      warnings.push(`line ${i + 1}: no name=value — skipped`);
      return;
    }
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    const c = buildCookie({ domain: defaultDomain, name, value });
    if (c !== null) out.push(c);
  });
  return out;
}

// ── Format sniffing ──────────────────────────────────────────────────────────

/** Detect the input format from its shape. Order matters: JSON and Netscape are
 *  unambiguous; a single `; `-separated line is a header; otherwise key=value. */
function detectFormat(text: string): ImportFormat {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  const first = trimmed[0];
  if (first === '[' || first === '{') return 'json';
  // The Netscape header comment, or any tab-separated data line → cookies.txt.
  if (/^#\s*Netscape/i.test(trimmed) || trimmed.includes('#HttpOnly_')) return 'netscape';
  // A tab in a non-JSON body is the cookies.txt field separator.
  if (text.includes('\t')) return 'netscape';
  // A `; `-joined single line of name=value pairs is an HTTP Cookie header.
  // (Require a semicolon AND no newline in the data portion so multi-line
  // key=value files aren't misread as a header.)
  const dataLine = trimmed.replace(/^\s*cookie\s*:/i, '').trim();
  if (dataLine.includes(';') && !dataLine.includes('\n')) return 'header';
  // A single line "a=1; b=2" with the label stripped also lands here.
  if (/=/.test(dataLine)) return 'keyvalue';
  return 'unknown';
}

/** Parse a pasted/loaded cookie blob in ANY supported format into the normalized
 *  jar the import route accepts. Never throws — malformed input yields warnings
 *  and whatever cookies could be salvaged. */
export function parseCookies(text: string, options: ParseCookiesOptions = {}): ParseCookiesResult {
  const warnings: string[] = [];
  const defaultDomain = options.defaultDomain;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { cookies: [], format: 'empty', warnings: ['empty input'] };
  }

  const format = detectFormat(text);
  let cookies: NormalizedCookie[];
  switch (format) {
    case 'json': {
      const json = parseJson(text, defaultDomain, warnings);
      if (json === null) {
        // JSON.parse failed despite the leading bracket — fall back to a
        // best-effort line scan rather than dropping everything.
        cookies = parseKeyValue(text, defaultDomain, warnings);
      } else {
        cookies = json;
      }
      break;
    }
    case 'netscape':
      cookies = parseNetscape(text, defaultDomain, warnings);
      break;
    case 'header':
      cookies = parseHeader(text, defaultDomain, warnings);
      break;
    case 'keyvalue':
      cookies = parseKeyValue(text, defaultDomain, warnings);
      break;
    case 'empty':
      cookies = [];
      warnings.push('empty input');
      break;
    default:
      cookies = [];
      warnings.push('could not detect a known cookie format');
      break;
  }

  if (cookies.length === 0 && format !== 'empty' && warnings.length === 0) {
    warnings.push('no cookies found in input');
  }
  return { cookies, format, warnings };
}
