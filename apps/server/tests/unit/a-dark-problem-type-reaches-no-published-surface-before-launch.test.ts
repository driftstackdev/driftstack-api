// A dark problem type reaches no published surface before launch.
//
// AI_CREDITS_PROBLEM_TYPES (packages/api-types/src/ai-credits.ts) is a
// SEPARATE roster from PROBLEM_TYPES precisely so a credits-only problem type
// can exist at runtime — the server constructs it and sends it to a moved
// account — without ever reaching a surface that ships: the OpenAPI document,
// the docs, the marketing error-codes page, the errors.driftstack.dev site,
// or any of the three SDK error-mapping tables.
//
// This guard reads every one of those surfaces from source (or, for the
// OpenAPI document, from the same builder the server's own /openapi.json
// route calls) and asserts none of them names a dark slug. It is the
// invariant that made closing the `KNOWN_LEAK_HANDOFF` hand-off in
// `the-published-api-types-withholds-the-unreleased-pricing.test.ts` sound:
// splitting the roster only helps if nothing downstream still reads the dark
// entry as if it were live.
//
// The converse also holds and is checked here: the type is not a dead
// declaration. `apps/server/src/lib/errors.ts` really does construct it
// (`AiCreditsExhaustedError`), so a moved account really can receive this
// 402 — it just carries no published documentation of its existence until
// the entry moves into PROBLEM_TYPES at launch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CREDITS_PROBLEM_TYPES, PROBLEM_TYPES } from '@driftstack/api-types';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

const SERVER_ERRORS = 'apps/server/src/lib/errors.ts';

/**
 * Every published surface a slug must be absent from, keyed by a short label
 * for failure messages. A function rather than a captured string so the
 * negative control below can re-run it against a mutated file without
 * re-reading every other surface.
 */
function publishedSurfaces(): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ['OpenAPI document (generateOpenApiSpec())', JSON.stringify(generateOpenApiSpec())],
    ['apps/docs reference errors page', read('apps/docs/src/pages/reference/errors.md')],
    ['apps/docs sdk/error-handling page', read('apps/docs/src/pages/sdk/error-handling.md')],
    [
      'marketing /docs/error-codes page',
      read('apps/marketing-site/src/pages/docs/error-codes.astro'),
    ],
    ['errors-site page generator (ERROR_PAGES)', read('apps/errors-site/build.mjs')],
    ['sdk-typescript error-mapping table', read('packages/sdk-typescript/src/errors.ts')],
    ['sdk-python error-mapping table', read('packages/sdk-python/src/driftstack/errors.py')],
    ['sdk-go error-mapping table', read('packages/sdk-go/error_mapping.go')],
    ['sdk-go error sentinels/types', read('packages/sdk-go/errors.go')],
    ['sdk-python published openapi.json', read('packages/sdk-python/openapi.json')],
  ]);
}

/** Every surface (by label) whose text contains `slug`. */
function surfacesNaming(slug: string, surfaces: ReadonlyMap<string, string>): string[] {
  const hits: string[] = [];
  for (const [label, text] of surfaces) {
    if (text.includes(slug)) hits.push(label);
  }
  return hits.sort();
}

describe('a dark problem type reaches no published surface before launch', () => {
  it('CRITICAL AI_CREDITS_PROBLEM_TYPES is non-empty — a passing suite over zero members proves nothing', () => {
    expect(Object.keys(AI_CREDITS_PROBLEM_TYPES).length).toBeGreaterThan(0);
  });

  it('CRITICAL every AI_CREDITS_PROBLEM_TYPES URI uses the canonical host and is NOT a member of PROBLEM_TYPES', () => {
    const liveUris = new Set<string>(Object.values(PROBLEM_TYPES));
    for (const [key, uri] of Object.entries(AI_CREDITS_PROBLEM_TYPES)) {
      expect(uri, `${key} URI`).toMatch(/^https:\/\/errors\.driftstack\.dev\/[a-z-]+$/);
      expect(liveUris.has(uri), `${key} (${uri}) has leaked into PROBLEM_TYPES`).toBe(false);
    }
  });

  it('CRITICAL every AI_CREDITS_PROBLEM_TYPES slug appears on no published surface', () => {
    const surfaces = publishedSurfaces();
    const offenders: string[] = [];
    for (const [key, uri] of Object.entries(AI_CREDITS_PROBLEM_TYPES)) {
      const slug = uri.replace(/^https:\/\/errors\.driftstack\.dev\//, '');
      for (const label of surfacesNaming(slug, surfaces)) {
        offenders.push(`${key} (${slug}) is named in: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CRITICAL every AI_CREDITS_PROBLEM_TYPES member is one the server actually constructs — a dark type nothing sends is not withheld, it is dead', () => {
    // codeOnly, not raw text: a doc comment merely NAMING the constant (this
    // file's own header does) must not count as the server constructing it.
    const code = codeOnly(read(SERVER_ERRORS));
    for (const key of Object.keys(AI_CREDITS_PROBLEM_TYPES)) {
      expect(
        code,
        `${SERVER_ERRORS} never references AI_CREDITS_PROBLEM_TYPES.${key} in code`,
      ).toContain(`AI_CREDITS_PROBLEM_TYPES.${key}`);
    }
  });

  it('NEGATIVE CONTROL: a slug that reaches a docs page is one this guard names — proving the arm above is not vacuously green', () => {
    // In-memory, not a real file write. A first version of this test wrote
    // the plant to apps/docs/src/pages/reference/errors.md on disk and
    // restored the CONTENT byte-for-byte afterwards — but restoring content
    // does not restore an mtime, and this repo has a separate guard
    // (dist-reading-suites-have-fresh-artifacts.test.ts) that compares a
    // built app's dist mtime against its source mtime. The real write made
    // that unrelated guard red for the rest of the run. A shared tree (see
    // this file's neighbours' warnings about concurrent writers) is exactly
    // where an avoidable disk write earns its risk, and the scan under test
    // only needs the TEXT a page would carry, not a real edit to make one.
    const label = 'apps/docs reference errors page';
    const surfaces = publishedSurfaces();
    const original = surfaces.get(label);
    expect(original, `${label} must be a real surface before it can be planted on`).toBeDefined();

    const [firstKey, firstUri] = Object.entries(AI_CREDITS_PROBLEM_TYPES)[0] as [string, string];
    const slug = firstUri.replace(/^https:\/\/errors\.driftstack\.dev\//, '');

    const planted = new Map(surfaces);
    planted.set(label, `${original}\n<!-- planted for a negative control: ${slug} -->\n`);

    const hits = surfacesNaming(slug, planted);
    expect(hits, `planting ${firstKey}'s slug in ${label} must be caught`).toContain(label);

    // cmp: nothing durable happened. A fresh read of every surface still
    // agrees with the pre-plant snapshot above — the Map `planted` was a
    // local copy, and disk was never touched.
    expect(publishedSurfaces().get(label)).toBe(original);
  });
});
