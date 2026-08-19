// W202 — drift guard: every `https://errors.driftstack.dev/...` URI
// referenced in a customer-facing docs page must match a real
// PROBLEM_TYPES entry. Catches the bug class where a doc references a
// fictional problem-type URI (e.g. `concurrency-limit-reached` vs the
// real `concurrency-limit`, or a `profile-locked` URI for an
// unimplemented feature) — customers parse `type` to dispatch on the
// error class, so a wrong URI silently breaks their retry logic.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// W206 — broaden the walk to the whole marketing-site pages tree so
// `pages/api-reference.astro` is covered too (it was outside the
// /docs subdir).
const DOCS_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.astro') || entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const REAL_URIS = new Set<string>(Object.values(PROBLEM_TYPES));

// Match every full `https://errors.driftstack.dev/<slug>` URI literal
// in doc bodies. The regex stops at the first non-URL character.
const URI_RE = /https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+/g;

const ERROR_CODES_DOC = readFileSync(resolve(DOCS_DIR, 'docs', 'error-codes.astro'), 'utf8');

describe('W202 docs → PROBLEM_TYPES URI parity', () => {
  it('every problem-type URI cited in a docs page exists in PROBLEM_TYPES', () => {
    const violations: { file: string; uri: string }[] = [];
    for (const file of walk(DOCS_DIR)) {
      const text = readFileSync(file, 'utf8');
      const matches = text.match(URI_RE);
      if (!matches) continue;
      for (const uri of matches) {
        if (!REAL_URIS.has(uri)) {
          violations.push({ file: file.replace(REPO_ROOT + '/', ''), uri });
        }
      }
    }
    expect(
      violations,
      `Docs reference problem-type URIs that don't exist in PROBLEM_TYPES. ` +
        `Real URIs: ${[...REAL_URIS].sort().join(', ')}. ` +
        `Violations:\n${violations.map((v) => `  ${v.file} → ${v.uri}`).join('\n')}`,
    ).toEqual([]);
  });

  it('W203 — every type slug in /docs/error-codes maps to a real PROBLEM_TYPES entry', () => {
    // The reference table uses bare slugs (`rate-limited`,
    // `concurrency-limit`) and the response-shape example builds the
    // full URI via template-literal — `https://errors.driftstack.dev/<slug>`.
    // Extract each slug from the ERRORS array and verify it round-trips
    // to a real URI. Catches the bug where a future edit adds a new
    // table row referencing a slug that doesn't exist.
    const realSlugs = new Set<string>(
      [...REAL_URIS].map((u) => u.replace('https://errors.driftstack.dev/', '')),
    );
    const slugRe = /uri:\s*'([a-z0-9-]+)'/g;
    const docSlugs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = slugRe.exec(ERROR_CODES_DOC)) !== null) {
      docSlugs.add(m[1] as string);
    }
    expect(
      docSlugs.size,
      'problem-type slugs found in the docs — V-1028 ratchet: this was > 0 against a real 32, so a broken extractor could check one slug and pass',
    ).toBeGreaterThanOrEqual(32);
    const fake = [...docSlugs].filter((s) => !realSlugs.has(s));
    expect(
      fake,
      `error-codes.astro lists slug(s) that don't map to a PROBLEM_TYPES URI. ` +
        `Real slugs: ${[...realSlugs].sort().join(', ')}. ` +
        `Fake: ${fake.join(', ')}`,
    ).toEqual([]);
  });
});
