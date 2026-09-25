#!/usr/bin/env node
// V-211 — the matcher every personal-name guard shares. The names themselves
// are NOT in this repository.
//
// A guard that spells out the names it rejects publishes them in every clone.
// Hashing them does not help either: a digest of a first name or a surname is
// reversed in seconds by hashing a public name list. So the list lives outside
// the tree and this file holds only the matcher and a made-up canary word.
//
// WHERE THE LIST COMES FROM, first match wins:
//   1. `DRIFTSTACK_PERSONAL_NAMES` — newline-separated entries. CI sets it from
//      the `DRIFTSTACK_PERSONAL_NAMES` repository secret.
//   2. The file at `DRIFTSTACK_PERSONAL_NAMES_FILE`, defaulting to
//      `~/.config/driftstack/personal-names.txt` — one entry per line; blank
//      lines and lines starting with `#` are ignored.
// An entry is a word, a handle or an email address. When neither source is
// configured the guards still run, with the canary only, and say so once: a
// notice on stderr locally, a GitHub `::warning::` annotation under Actions.
// A missing list is reported, never treated as a pass on real coverage.
//
// MATCHING. Text and entries are normalised the same way — NFKD decomposition,
// combining marks dropped, lower-cased — so an accented spelling, a
// capitalised one and a lower-case one all match. Boundaries depend on the
// entry:
//   - an entry made only of letters (a name) matches when no LETTER touches it
//     on either side: a name inside a longer word is not a hit, while a name
//     beside digits, punctuation, a hyphen or an `@` is — the shape a handle or
//     an address takes;
//   - any other entry (a handle with digits, an email address) matches when no
//     letter or digit touches it.
//
// CANARY. `personalnamecanary` is always on the list. It never occurs in real
// text; it lets a positive control drive the real matcher end to end without
// anyone writing a real name down.
//
// Used by scripts/git-hooks/commit-msg (via the CLI below), by
// scripts/scan-site-prose.mjs, and by the public-app and SDK sweeps in
// apps/server/tests/unit.
//
// CLI:  node scripts/personal-names.mjs <file>
//   exit 0 when the file names nobody, 1 when it does (each hit is printed as
//   `line:column text` on stdout), 2 on a usage or read error.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The made-up canary word that is always on the list. */
export const CANARY_WORD = 'personalnamecanary';

/** Where the list is read from when `DRIFTSTACK_PERSONAL_NAMES_FILE` is unset. */
export const DEFAULT_LIST_PATH = join(homedir(), '.config', 'driftstack', 'personal-names.txt');

/** NFKD, combining marks dropped, lower-cased. */
export function normaliseWord(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Entries from list text: one per line, blank lines and `#` comments skipped. */
export function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The configured list plus the canary.
 *
 * `configured` is false when no real list was found; `source` says where the
 * list came from ('env', the file path, or 'none'). With `announce` (the
 * default) a missing list is reported once per process.
 */
export function loadPersonalNames({ env = process.env, announce = true } = {}) {
  let entries = [];
  let source = 'none';
  const fromEnv = env.DRIFTSTACK_PERSONAL_NAMES;
  if (typeof fromEnv === 'string' && parseList(fromEnv).length > 0) {
    entries = parseList(fromEnv);
    source = 'env';
  } else {
    const path = env.DRIFTSTACK_PERSONAL_NAMES_FILE || DEFAULT_LIST_PATH;
    if (existsSync(path)) {
      const fromFile = parseList(readFileSync(path, 'utf8'));
      if (fromFile.length > 0) {
        entries = fromFile;
        source = path;
      }
    }
  }
  const configured = entries.length > 0;
  if (!configured && announce) announceMissingList(env);
  return { entries: [...new Set([...entries, CANARY_WORD])], configured, source };
}

let announced = false;

/** One notice per process: stderr locally, a GitHub annotation under Actions. */
export function announceMissingList(env = process.env) {
  if (announced) return;
  announced = true;
  if (env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(
      '::warning title=V-211 personal-name list not configured::DRIFTSTACK_PERSONAL_NAMES is not set, so the personal-name guards checked only their canary word. Add the DRIFTSTACK_PERSONAL_NAMES repository secret for real coverage.\n',
    );
  } else {
    const path = env.DRIFTSTACK_PERSONAL_NAMES_FILE || DEFAULT_LIST_PATH;
    process.stderr.write(
      `personal-names: no personal-name list configured (set DRIFTSTACK_PERSONAL_NAMES or create ${path}); checking the canary word only.\n`,
    );
  }
}

let cached = null;

/** The list for this process, loaded once. */
export function defaultEntries() {
  if (cached === null) cached = loadPersonalNames().entries;
  return cached;
}

/** Text normalised per code point, with each output character's source offset. */
function normaliseWithOffsets(text) {
  let out = '';
  const offsets = [];
  let i = 0;
  for (const ch of text) {
    const n = normaliseWord(ch);
    for (let k = 0; k < n.length; k += 1) offsets.push(i);
    out += n;
    i += ch.length;
  }
  offsets.push(i);
  return { out, offsets };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcherFor(entries) {
  const words = [];
  const others = [];
  for (const entry of entries) {
    const n = normaliseWord(entry);
    if (n.length === 0) continue;
    (/^\p{L}+$/u.test(n) ? words : others).push(escapeRe(n));
  }
  // Longest first, so an address is reported whole rather than as the handle
  // at its start.
  words.sort((a, b) => b.length - a.length);
  others.sort((a, b) => b.length - a.length);
  const parts = [];
  if (words.length > 0) parts.push(`(?<!\\p{L})(?:${words.join('|')})(?!\\p{L})`);
  if (others.length > 0) parts.push(`(?<![\\p{L}\\p{N}])(?:${others.join('|')})(?![\\p{L}\\p{N}])`);
  return parts.length === 0 ? null : new RegExp(parts.join('|'), 'gu');
}

/**
 * Every listed name, handle or address in `text`, with its offset and its
 * spelling in `text` as given (not in the normalised form), so a caller can
 * report a real line and column.
 */
export function personalNameHits(text, entries = defaultEntries()) {
  const re = matcherFor(entries);
  if (re === null) return [];
  const { out, offsets } = normaliseWithOffsets(text);
  const hits = [];
  for (const m of out.matchAll(re)) {
    const start = offsets[m.index];
    const end = offsets[m.index + m[0].length];
    hits.push({ index: start, word: text.slice(start, end) });
  }
  return hits;
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('usage: node scripts/personal-names.mjs <file>\n');
    return 2;
  }
  let text;
  try {
    text = readFileSync(argv[0], 'utf8');
  } catch (err) {
    process.stderr.write(`personal-names: cannot read ${argv[0]}: ${err.message}\n`);
    return 2;
  }
  const hits = personalNameHits(text);
  for (const { index, word } of hits) {
    const { line, column } = lineAndColumn(text, index);
    process.stdout.write(`${line}:${column} ${word}\n`);
  }
  return hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
