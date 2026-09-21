// W242.D — drift-guard for /docs/error-codes. The page is the
// authoritative reference for every RFC 7807 `type` URI the server
// emits. This guard fails if PROBLEM_TYPES gains a new slug and the
// doc doesn't list it, OR if the doc lists a slug that PROBLEM_TYPES
// no longer defines.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'error-codes.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function slugsFromDoc(doc: string): Set<string> {
  // Pull `uri: 'foo-bar'` rows from the ERRORS array. Tolerate either
  // quote style.
  const matches = Array.from(doc.matchAll(/uri:\s*['"]([a-z][a-z0-9-]+)['"]/g));
  return new Set(matches.map((m) => m[1] as string));
}

function slugsFromPROBLEM_TYPES(): Set<string> {
  const out = new Set<string>();
  for (const uri of Object.values(PROBLEM_TYPES)) {
    const slug = uri.replace(/^https:\/\/errors\.driftstack\.dev\//, '');
    out.add(slug);
  }
  return out;
}

/**
 * Slugs withheld from this public marketing-site doc until their feature
 * launches — same pattern as `docs-metrics-content-parity.test.ts`'s map of
 * the same name.
 */
const WITHHELD_UNTIL_LAUNCH = new Map<string, string>([
  [
    'ai-credits-exhausted',
    'AI credits are built and dark (DRIFTSTACK_AI_CREDITS_MODE defaults to off and no account is ' +
      'on them). Document it, and remove this entry, in the change that makes credits live.',
  ],
]);

describe('W242.D error-codes doc parity', () => {
  const doc = read();
  const docSlugs = slugsFromDoc(doc);
  const liveSlugs = slugsFromPROBLEM_TYPES();

  it('lists at least 20 problem-type rows', () => {
    expect(docSlugs.size).toBeGreaterThanOrEqual(20);
  });

  it('every PROBLEM_TYPES slug is listed in the doc, except the ones withheld until their feature launches', () => {
    const missing = [...liveSlugs].filter((s) => !docSlugs.has(s) && !WITHHELD_UNTIL_LAUNCH.has(s));
    expect(missing).toEqual([]);
  });

  it('CRITICAL every withheld slug really is absent from the doc, and really is a live problem type', () => {
    for (const [slug, why] of WITHHELD_UNTIL_LAUNCH) {
      expect(liveSlugs.has(slug), `${slug} is withheld but not in PROBLEM_TYPES`).toBe(true);
      expect(docSlugs.has(slug), `${slug} is withheld (${why}) and yet appears in the doc`).toBe(
        false,
      );
    }
  });

  it('every doc slug exists in PROBLEM_TYPES', () => {
    const extras = [...docSlugs].filter((s) => !liveSlugs.has(s));
    expect(extras).toEqual([]);
  });

  it('uses the canonical errors.driftstack.dev URI host', () => {
    expect(doc).toContain('https://errors.driftstack.dev/');
  });

  it('does NOT advertise the fictional { "error": { "code", "message" } } envelope', () => {
    // Strip the Astro frontmatter (the file's design-note comment in
    // `---…---` mentions the fictional envelope on purpose).
    const body = doc.replace(/^---[\s\S]*?---/, '');
    expect(body).not.toMatch(/"error":\s*\{[^}]*"code"/);
  });
});
