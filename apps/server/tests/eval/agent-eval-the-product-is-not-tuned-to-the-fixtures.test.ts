// ⛔ THE PRODUCT MUST NOT BE TUNED TO THE EXAM.
//
// The live tier measures how well a real planner completes customer tasks on a
// set of fixture sites. The moment a fixture's host, brand, control id or
// product name appears in PRODUCT source — above all in the planner's system
// prompt — the number stops measuring planning and starts measuring recall of
// the answer key. It would also keep going UP, which is what makes it dangerous:
// nothing about a leaked fixture looks like a regression.
//
// So this sweeps every file under apps/server/src for everything distinctive the
// live fixtures declare, derived from the fixtures themselves so a site added
// tomorrow is covered without anyone remembering this file exists.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_SITES, INJECTION_TEXT } from './_lib/live-sites.js';
import { LIVE_TASKS } from './_lib/live-tasks.js';

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const pages = Object.values(LIVE_SITES).flatMap((site) => [...site.pages.values()]);

/** Every host the fixtures serve. */
const hosts = [...new Set(pages.map((page) => new URL(page.url).host))];

/** Every brand a fixture puts in its header. */
const brands = [
  ...new Set(
    pages.flatMap((page) =>
      [...page.body.matchAll(/<a class="brand"[^>]*>([^<]+)<\/a>/g)].map((m) =>
        (m[1] ?? '').replace(/&amp;/g, '&').trim(),
      ),
    ),
  ),
].filter((brand) => brand.length >= 6);

/** Every string a fixture page declares, however deep: its body, and whatever a
 *  late render, a click or a form submit later inserts or sets. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Map) for (const v of value.values()) stringsIn(v, out);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}
const fixtureStrings = pages.flatMap((page) => stringsIn(page));

/**
 * EVERY element id a fixture declares, looked for the way source would spell it
 * (`#id`, `id="id"`).
 *
 * ⛔ NO LENGTH OR HYPHEN FILTER. The first version kept only hyphenated ids of
 * eight characters or more, which silently exempted the two controls the SAFETY
 * tasks turn on. What is exempt is now a LIST, each entry with its reason.
 */
const GENERIC_IDS: ReadonlyMap<string, string> = new Map([
  // The confirmation gate's own documented examples of selector shapes it
  // tokenises (`#buy-now`), written before the live fixtures existed. They are
  // the generic purchase words the gate matches, not a fixture's name for a
  // control — and the gate is meant to fire on them.
  ['buy-now', 'agent-consequential-action.ts documents `#buy-now` as a selector shape'],
  // The field and button names every contact and sign-in form on the web uses.
  // Product comments cite them as the ordinary shape of a selector (`#send` in the
  // double-submit guard, `#email`/`#password` in the sensitive-field matcher),
  // which says nothing about any one fixture.
  ['name', 'the generic name of a name field'],
  ['email', 'the generic name of an email field'],
  ['password', 'the generic name of a password field'],
  ['send', "the generic name of a form's send button"],
]);
const ids = [
  ...new Set(
    fixtureStrings.flatMap((text) => [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? '')),
  ),
].filter((id) => id.length > 0 && !GENERIC_IDS.has(id));
const idSpellings = ids.flatMap((id) => [`#${id}`, `id="${id}"`]);

/**
 * What the fixture pages SAY: every run of page text of four words or more —
 * headings, status lines a late render sets, confirmations, prices in a
 * sentence. Compared without case. This is the class the first version could not
 * see at all, and two such sentences were sitting in product comments.
 */
const pageSentences = [
  ...new Set(
    fixtureStrings.flatMap((text) =>
      text
        .split(/<[^>]*>/)
        .map((node) =>
          node
            .replace(/&amp;/g, '&')
            .replace(/&[a-z#0-9]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase(),
        )
        // Four words is the floor, not a character count: "It is your turn." is
        // sixteen characters, and an eighteen-character floor silently exempted
        // the status line a late render sets.
        .filter((node) => node.split(' ').length >= 4 && node.length >= 12),
    ),
  ),
];
/** Shorter labels — a link or button caption of two or three words — are only
 *  distinctive when quoted, which is how a prompt or a comment would cite one. */
const quotedCaptions = [
  ...new Set(
    fixtureStrings.flatMap((text) =>
      [...text.matchAll(/<(?:a|button)\b[^>]*>([^<]{6,40})<\/(?:a|button)>/g)]
        .map((m) => (m[1] ?? '').trim())
        .filter((caption) => caption.includes(' ')),
    ),
  ),
].flatMap((caption) => [`"${caption}"`, `'${caption}'`, `“${caption}”`]);

/** Distinctive phrases from what the fixture CUSTOMERS say. */
const phrases = [
  ...new Set(
    LIVE_TASKS.flatMap((task) => [...task.prompt.matchAll(/'([^']{6,})'/g)].map((m) => m[1] ?? '')),
  ),
  'Ember Mini',
  'Kestrel Duo',
  'Aurora kettle',
  INJECTION_TEXT.slice(0, 40),
];

describe('the product is not tuned to the eval fixtures', () => {
  const files = walk(SRC);
  const source = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('the sweep is not vacuous: it found source to read and fixtures to look for', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(hosts.length).toBeGreaterThanOrEqual(10);
    expect(brands.length).toBeGreaterThanOrEqual(8);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(pageSentences.length).toBeGreaterThanOrEqual(40);
    expect(quotedCaptions.length).toBeGreaterThanOrEqual(30);
    // The safety fixtures' own controls are needles, not exemptions by shape.
    expect(ids).toContain('place-order');
    // A status line that only a LATE RENDER sets is a needle too.
    expect(pageSentences).toContain('it is your turn.');
    // A positive control in the same breath: the matcher DOES find a needle
    // that is really there.
    expect(source.some(({ text }) => text.includes('YOU WORK IN A LOOP'))).toBe(true);
  });

  function sweep(
    needles: ReadonlyArray<string>,
    haystacks: ReadonlyArray<{ file: string; text: string }>,
    fold: boolean,
  ): string[] {
    const hits: string[] = [];
    for (const { file, text } of haystacks) {
      const body = fold ? text.toLowerCase() : text;
      for (const needle of needles) {
        if (needle.length > 0 && body.includes(needle)) {
          hits.push(`${file.slice(SRC.length + 1)} contains ${JSON.stringify(needle)}`);
        }
      }
    }
    return hits;
  }

  it.each([
    ['host', hosts, false],
    ['brand', brands, false],
    ['element id', idSpellings, false],
    ['phrase', phrases, false],
    ['page sentence', pageSentences, true],
    ['quoted link or button caption', quotedCaptions, false],
  ] as const)('no fixture %s appears anywhere under apps/server/src', (_kind, needles, fold) => {
    expect(sweep(needles, source, fold)).toEqual([]);
  });

  it('⛔ POSITIVE CONTROL — a fixture sentence, a short id and a quoted caption PLANTED in a source file are each found', () => {
    // The first version of this sweep passed with two fixture sentences sitting
    // in product comments, because page text was never a needle. A sweep that
    // cannot fail proves nothing, so each class is planted and must be caught.
    const planted = [
      {
        file: join(SRC, 'planted.ts'),
        text: '// a queue says "It is your turn." and then #place-order, the "Opening hours" link',
      },
    ];
    expect(sweep(pageSentences, planted, true)).toHaveLength(1);
    expect(sweep(idSpellings, planted, false)).toHaveLength(1);
    expect(sweep(quotedCaptions, planted, false)).toHaveLength(1);
  });
});
