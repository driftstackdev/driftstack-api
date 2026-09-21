#!/usr/bin/env node
// Nothing internal reads as customer prose on a public site.
//
// `scripts/scan-shipped-text.mjs` scans what SHIPS in the four published SDK
// packages (npm/PyPI/Go tarball contents). The single-page parity guard
// `apps/server/tests/unit/a-public-egress-warning-cannot-ship-undocumented.test.ts`
// scans three specific egress-vocabulary documents for the same class of
// word. Neither reads the customer-facing SITES' rendered prose — the docs
// site, the marketing site, the customer dashboard, and the desktop client's
// customer-string tables. This is that scan.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "RENDERED PROSE" MEANS HERE, AND WHY COMMENTS ARE STRIPPED FIRST
//
// A wire value legitimately names an internal mechanism IN CODE — a variable,
// an import path, a design-system token in a source comment ("Fleet v2" as a
// component-library name, say). None of that reaches a customer. What reaches
// a customer is the rendered page: Markdown prose, an Astro template's HTML +
// text, and the literal strings in a desktop-client copy table. So before
// scanning, this strips:
//   - JS/TS comments (`//`, `/* */`) — including inside an `.astro`
//     frontmatter fence, which is JS/TS between its own `---` delimiters.
//   - HTML comments (`<!-- -->`).
//   - Markdown fenced code blocks (``` ``` ```) and inline code spans
//     (`` `...` ``) — wire values legitimately appear in a code sample.
// Stripping BLANKS the matched span (keeps every newline, replaces every
// other character with a space) rather than deleting it, so every remaining
// hit's line:column still points at the real line in the real file.
//
// The JS/TS comment stripper is a straight port of
// `apps/server/tests/unit/_helpers/code-only.ts`'s `codeOnly` — the same
// left-to-right, string/regex/template-aware scanner, chosen over a
// `.replace(/\/\/.*/g, '')` one-liner for the exact reason that file's header
// documents: a route path containing `/*`, a regex literal like `/['"]/`, or a
// template literal nesting `` `${ `yes` : `no` }` `` all break the naive
// version and the diagnosis in each case is "the scanner quietly stopped
// finding anything," not an error.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE LIST
//
// Five rules are the SAME PATTERNS `scan-shipped-text.mjs` already exports
// for this exact vocabulary (`harness`, `fleet`, `control-plane`, `observer`,
// `vantage`) — imported, not restated, so the two scanners cannot quietly
// diverge on what "fleet" means. Three more (`interpose`, `macworker`,
// `undetectable`) have no rule there and are added here. The personal-name
// patterns are `apps/server/tests/unit/public-app-v211-personal-name-sweep
// .test.ts`'s own `PERSONAL_NAME_PATTERNS` (Joel / Theunissen /
// Joeltheunissen) — copied rather than imported, because that file is a
// vitest spec, not an importable module, and pinned identical to it on
// purpose so the two cannot drift. An email pattern is added beside them,
// allowing only `@driftstack.dev` / `@driftstack.io` addresses, which are the
// ones a customer page is allowed to publish.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ALLOWLIST
//
// `scripts/site-prose-allowlist.json` — an array of
// `{ file, rule, text, reason }`. An entry suppresses a finding only when all
// three of `file` (repo-relative), `rule` and `text` (CASE-SENSITIVE) match —
// not "this rule anywhere in this file," which would quietly swallow a
// second, different hit added later, and not "this word in any casing,"
// which would let a review of "fleet" silently cover "Fleet" too. Every
// entry needs a REASON, and the
// vitest guard (`scripts/tests/scan-site-prose.test.ts`) asserts every entry
// still matches at least one live finding: an allowlist entry for a hit that
// was fixed, renamed, or moved is a STALE entry, and a stale entry is a gap
// nobody is looking through.
//
// Usage:
//   node scripts/scan-site-prose.mjs             scan everything
//   node scripts/scan-site-prose.mjs --json       machine-readable output
// Exit 0 clean, 1 on any un-allowlisted hit, 2 on a usage/derivation error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES as SHIPPED_TEXT_RULES } from './scan-shipped-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const ALLOWLIST_PATH = resolve(HERE, 'site-prose-allowlist.json');

// ─────────────────────────────────────────────────────────────────────────────
// codeOnly — a plain-JS port of apps/server/tests/unit/_helpers/code-only.ts.
// Functionally identical; only the TypeScript type annotations are dropped.
// Source with comments removed, every other byte (including newlines) kept.
// ─────────────────────────────────────────────────────────────────────────────

function regexAllowedAfter(prev) {
  if (prev === null) return true;
  return '(,=:[!&|?{};+-*%^~<>'.includes(prev);
}

export function codeOnly(src) {
  let out = '';
  let inBlock = false;
  let quote = null;
  let inTemplate = false;
  const templateExpressions = [];
  let prevSignificant = null;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (inBlock) {
      if (ch === '\n') out += '\n';
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inTemplate) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < src.length) {
          out += src[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === '`') {
        inTemplate = false;
        prevSignificant = '`';
        continue;
      }
      if (ch === '$' && next === '{') {
        out += '{';
        i += 1;
        inTemplate = false;
        templateExpressions.push(0);
        prevSignificant = '{';
      }
      continue;
    }

    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < src.length) {
          out += src[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      out += ch;
      prevSignificant = ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      prevSignificant = ch;
      continue;
    }

    if (templateExpressions.length > 0 && (ch === '{' || ch === '}')) {
      const top = templateExpressions.length - 1;
      const depth = templateExpressions[top];
      out += ch;
      if (ch === '{') {
        templateExpressions[top] = depth + 1;
        prevSignificant = ch;
      } else if (depth === 0) {
        templateExpressions.pop();
        inTemplate = true;
      } else {
        templateExpressions[top] = depth - 1;
        prevSignificant = ch;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    if (ch === '/' && regexAllowedAfter(prevSignificant)) {
      let inClass = false;
      out += ch;
      i += 1;
      for (; i < src.length; i += 1) {
        const c = src[i];
        out += c;
        if (c === '\\') {
          if (i + 1 < src.length) {
            out += src[i + 1];
            i += 1;
          }
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
      }
      prevSignificant = '/';
      continue;
    }

    out += ch;
    if (ch === '!' && next !== '=' && /[\w$)\]]/.test(src[i - 1] ?? '')) {
      prevSignificant = ')';
    } else if (!/\s/.test(ch)) prevSignificant = ch;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blanking helpers — remove a span's CONTENT while keeping every newline, so
// line:column of anything found afterwards still points at the real file.
// ─────────────────────────────────────────────────────────────────────────────

function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

/** Markdown: strip fenced code blocks, then inline code spans, then HTML
 *  comments. Order matters — an inline-code pattern must not reach inside an
 *  already-blanked fence (it cannot, since blanking removes the backticks). */
export function stripMarkdownNonProse(text) {
  let out = text.replace(/```[\s\S]*?```/g, blank);
  out = out.replace(/`[^`\n]+`/g, blank);
  out = out.replace(/<!--[\s\S]*?-->/g, blank);
  return out;
}

/**
 * Strip an Astro template BODY's own comment forms:
 *   - HTML comments (`<!-- -->`).
 *   - JSX-style block comments inside a template expression (`{/* ... *\/}`)
 *     — the form Astro templates actually use for an inline dev note.
 *   - The full contents of any `<script>...</script>` block, run through
 *     `codeOnly` (client-side JS shipped inline in the page, same as a `.ts`
 *     file) rather than merely comment-stripped as prose.
 *
 * Measured against this repo's real pages: EVERY current `fleet` / `harness`
 * / `control plane` hit in a template body turned out to be either a
 * `{/* ... *\/}` comment or a `//` comment inside an inline `<script>` block
 * (the "Fleet v2" design-system name, an internal rationale note) — not
 * rendered prose. A first version of this stripper handled only HTML
 * comments and reported all of them as leaks; a second handled `{/* *\/}`
 * but not `<script>` bodies and still reported the `<script>` ones. Neither
 * gap was theoretical — each was a real false positive this scanner produced
 * against this repo before the fix. Not full JS-in-`{}` comment stripping
 * for a bare template expression (a `//` inside `{ }` outside a `<script>`
 * tag is left alone): the two forms above are the ones this codebase's
 * templates actually use for a note.
 */
function stripAstroBodyComments(text) {
  let out = text.replace(/<!--[\s\S]*?-->/g, blank);
  out = out.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank);
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => {
    return blank(open) + codeOnly(body) + blank(close);
  });
  return out;
}

/** `.astro`: the frontmatter fence (JS/TS between the file's own leading
 *  `---` lines) is comment-stripped with `codeOnly`; the template body has
 *  its HTML comments and `{/* *\/}` comments blanked. A file with no
 *  frontmatter fence is treated as template body only. */
export function stripAstroNonProse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m === null) return stripAstroBodyComments(text);
  const frontmatter = m[1];
  const rest = text.slice(m[0].length);
  const strippedFrontmatter = codeOnly(frontmatter);
  const strippedBody = stripAstroBodyComments(rest);
  // Reassemble at the ORIGINAL offsets: the fence delimiter lines themselves
  // carry no prose, so they are blanked rather than dropped, keeping every
  // later line number identical to the source file's.
  const openLine = text.slice(0, m[0].indexOf(frontmatter));
  const closeLine = m[0].slice(m[0].indexOf(frontmatter) + frontmatter.length);
  return blank(openLine) + strippedFrontmatter + blank(closeLine) + strippedBody;
}

/** `.ts` customer-string tables: comments stripped with `codeOnly`. */
export function stripTsNonProse(text) {
  return codeOnly(text);
}

export function stripNonProse(text, ext) {
  if (ext === '.md' || ext === '.mdx') return stripMarkdownNonProse(text);
  if (ext === '.astro') return stripAstroNonProse(text);
  if (ext === '.ts' || ext === '.tsx') return stripTsNonProse(text);
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rule list
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_RULE_IDS = Object.freeze(['harness', 'fleet', 'control-plane', 'observer', 'vantage']);
const sharedById = new Map(SHIPPED_TEXT_RULES.map((r) => [r.id, r]));
for (const id of SHARED_RULE_IDS) {
  if (!sharedById.has(id)) {
    throw new Error(
      `scan-shipped-text.mjs RULES no longer exports an id '${id}' this scanner shares`,
    );
  }
}

const SITE_ONLY_RULES = Object.freeze([
  {
    id: 'interpose',
    pattern: /interpos\w*/gi,
    why: "names the fork's dyld interpose mechanism",
  },
  {
    id: 'macworker',
    pattern: /\bmacworkers?\b/gi,
    why: 'the internal name for a device host',
  },
  {
    id: 'undetectable',
    pattern: /\bundetectable\b/gi,
    why: 'a claim the product does not make about itself',
  },
]);

// apps/server/tests/unit/public-app-v211-personal-name-sweep.test.ts's own
// PERSONAL_NAME_PATTERNS, pinned identical on purpose — see the header.
const PERSONAL_NAME_RULES = Object.freeze([
  { id: 'personal-name-joel', pattern: /\b[Jj]oel\b/g, why: 'a personal name (V-211)' },
  {
    id: 'personal-name-theunissen',
    pattern: /\b[Tt]heunissen\b/g,
    why: 'a personal name (V-211)',
  },
  {
    id: 'personal-name-joeltheunissen',
    pattern: /\b[Jj]oeltheunissen\b/g,
    why: 'a personal name (V-211)',
  },
  {
    id: 'personal-email',
    // Any email address NOT on a driftstack.dev/.io domain, and not an RFC
    // 2606 reserved placeholder domain (example.com/.net/.org, or anything
    // under .example — "yourcompany.example" included). Docs and forms
    // legitimately show `you@example.com` as a fill-in-the-blank; that is
    // not a personal address and is not a leak.
    pattern:
      /\b[A-Za-z0-9._%+-]+@(?!driftstack\.(?:dev|io)\b)(?![A-Za-z0-9.-]*\.example(?:\.[A-Za-z]{2,})?\b)(?!example\.(?:com|net|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: 'an email address that is not a driftstack.dev / driftstack.io address',
  },
]);

export const RULES = Object.freeze([
  ...SHARED_RULE_IDS.map((id) => {
    const r = sharedById.get(id);
    return Object.freeze({ id: r.id, pattern: r.pattern, why: r.why });
  }),
  ...SITE_ONLY_RULES,
  ...PERSONAL_NAME_RULES,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Scanning
// ─────────────────────────────────────────────────────────────────────────────

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

/** Every rule match in already-stripped `text`. `file` is carried through
 *  onto each finding so the CLI and the allowlist can key on it. */
export function scanText(text, file) {
  const starts = lineStarts(text);
  const findings = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        m = re.exec(text);
        continue;
      }
      const { line, column } = lineOf(starts, m.index);
      findings.push({ file, rule: rule.id, why: rule.why, line, column, text: m[0] });
      m = re.exec(text);
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return findings;
}

function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** Scan one file on disk: read, strip, scan. */
export function scanFile(absPath, repoRelativePath) {
  const text = readFileSync(absPath, 'utf8');
  const stripped = stripNonProse(text, extOf(absPath));
  return scanText(stripped, repoRelativePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// What gets scanned
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.astro') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, pred, out);
    else if (entry.isFile() && pred(entry.name)) out.push(p);
  }
  return out;
}

/**
 * The customer-string tables under apps/gui-client/src/lib: any file whose
 * name suggests a table of user-facing copy rather than ordinary logic —
 * `assistant-templates.ts`, `*-copy.ts`, `*-templates.ts` — matched by NAME
 * rather than hand-listed, so a sixth one added later is picked up the same
 * way `public-apps.ts` derives its roster instead of hand-listing it.
 */
function guiClientCopyTables(repoRoot) {
  const dir = join(repoRoot, 'apps', 'gui-client', 'src', 'lib');
  return walk(dir, (name) => /^(?:.*-copy|.*-templates|.*templates|.*copy)\.ts$/i.test(name));
}

/** The full set of source files this scanner covers, as absolute paths. */
export function siteProseFiles(repoRoot = REPO_ROOT) {
  const files = [];
  files.push(
    ...walk(
      join(repoRoot, 'apps', 'docs', 'src', 'pages'),
      (name) => name.endsWith('.md') || name.endsWith('.mdx'),
    ),
  );
  files.push(
    ...walk(join(repoRoot, 'apps', 'marketing-site', 'src', 'pages'), (name) =>
      name.endsWith('.astro'),
    ),
  );
  files.push(
    ...walk(join(repoRoot, 'apps', 'marketing-site', 'src', 'components'), (name) =>
      name.endsWith('.astro'),
    ),
  );
  files.push(
    ...walk(join(repoRoot, 'apps', 'customer-dashboard', 'src', 'pages'), (name) =>
      name.endsWith('.astro'),
    ),
  );
  files.push(...guiClientCopyTables(repoRoot));
  return [...new Set(files)].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed allowlist entries: `{ file, rule, text, reason }[]`. Empty array —
 *  not an error — when the file does not exist. */
export function readAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`);
  for (const [i, entry] of parsed.entries()) {
    for (const key of ['file', 'rule', 'text', 'reason']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        throw new Error(`${path}[${String(i)}]: missing or empty "${key}"`);
      }
    }
  }
  return parsed;
}

// CASE-SENSITIVE on `text` deliberately: an allowlist entry is a record that
// someone reviewed THIS EXACT string and found it fine, not "this word in any
// casing." "Fleet" and "fleet" are different findings and need their own
// entries — a case-insensitive key would let one review silently cover a
// second, differently-cased string nobody looked at.
function allowlistKey(fileOrEntry, rule, text) {
  if (typeof fileOrEntry === 'object') {
    return allowlistKey(fileOrEntry.file, fileOrEntry.rule, fileOrEntry.text);
  }
  return `${fileOrEntry} ${rule} ${text}`;
}

/**
 * Split findings into `[kept, suppressed]` against the allowlist, plus which
 * allowlist entries suppressed nothing (STALE — a hit that was fixed, moved,
 * or renamed since the entry was written).
 */
export function applyAllowlist(findings, allowlist) {
  const byKey = new Map();
  for (const entry of allowlist) byKey.set(allowlistKey(entry), entry);
  const used = new Set();
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const key = allowlistKey(f.file, f.rule, f.text);
    const entry = byKey.get(key);
    if (entry === undefined) {
      kept.push(f);
    } else {
      used.add(key);
      suppressed.push({ ...f, reason: entry.reason });
    }
  }
  const stale = allowlist.filter((e) => !used.has(allowlistKey(e)));
  return { kept, suppressed, stale };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export function run(repoRoot = REPO_ROOT, allowlistPath = ALLOWLIST_PATH) {
  const files = siteProseFiles(repoRoot);
  const findings = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    findings.push(...scanFile(abs, rel));
  }
  const allowlist = readAllowlist(allowlistPath);
  const { kept, suppressed, stale } = applyAllowlist(findings, allowlist);
  return { files, findings, kept, suppressed, stale };
}

export function main(argv) {
  const asJson = argv.includes('--json');
  let result;
  try {
    result = run();
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { files, kept, suppressed, stale } = result;

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ files: files.length, kept, suppressed, stale }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`scanned ${String(files.length)} files\n`);
    for (const f of kept) {
      process.stdout.write(
        `${f.file}:${String(f.line)}:${String(f.column)}  ${f.rule}  "${f.text}"  — ${f.why}\n`,
      );
    }
    if (suppressed.length > 0) {
      process.stdout.write(`\n${String(suppressed.length)} allowlisted:\n`);
      for (const f of suppressed) {
        process.stdout.write(
          `  ${f.file}:${String(f.line)}  ${f.rule}  "${f.text}"  — ${f.reason}\n`,
        );
      }
    }
    if (stale.length > 0) {
      process.stdout.write(
        `\n${String(stale.length)} STALE allowlist entries (matched nothing):\n`,
      );
      for (const e of stale) {
        process.stdout.write(`  ${e.file}  ${e.rule}  "${e.text}"\n`);
      }
    }
    process.stdout.write(
      `\n${String(kept.length)} unallowlisted hit(s), ${String(stale.length)} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'}\n`,
    );
  }
  return kept.length === 0 && stale.length === 0 ? 0 : 1;
}

/* c8 ignore start — CLI wiring; the exported functions above are what the tests drive. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
