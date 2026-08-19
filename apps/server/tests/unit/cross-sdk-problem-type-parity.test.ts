// W676 — cross-SDK problem-type URI parity. Third in the cross-SDK
// drift-guard series (W649 verb parity + W675 error-class parity +
// W676 problem-type URI parity).
//
// Asserts every RFC 7807 problem-type URI in `PROBLEM_TYPES` is mapped
// in ALL 3 SDKs' mapping tables:
//
//   - sdk-typescript: TYPE_TO_CTOR (errors.ts) — Record<string, ctor>
//   - sdk-go:         errorBuilders (error_mapping.go) — map[string]builder
//   - sdk-python:     PROBLEM_TYPE_TO_ERROR (errors.py) — dict
//
// Drift here would let a server-emitted problem-type URI silently
// surface as a generic DriftstackError (TS), UnknownError (Go), or
// DriftstackError (Python) instead of the typed subclass. Customer
// code that does `catch (RateLimitError)` would fail to catch a
// rate-limit response that the server emits with the correct URI.
//
// Methodology: extract every `https://errors.driftstack.dev/<slug>`
// occurrence from each SDK's mapping table file, then assert the
// canonical set is a SUBSET of every SDK's mapped URIs. SDK-specific
// extras are allowed but the canonical set MUST be in all 3.
//
// V-1053 — the canonical set is now DERIVED from `PROBLEM_TYPES` rather
// than frozen here. It had been a hand-maintained list of 24 while the
// registry held 32, so the eight newest types — BYOK, both bundled-LLM
// errors, both pair-mode errors, storage-quota, proxy-validation and
// profile-in-use — were mapped by all three SDKs but asserted by none,
// and any type added next would have been unguarded by construction.
// Three different counts (22, 23, 24) appeared in prose across this
// file family, none of them the real one; a derived set cannot go
// stale that way.
//
// NOTE: rate-limited is handled SEPARATELY in sdk-typescript (via
// errorFromProblem's explicit branch so it can pass
// retryAfterSeconds). It IS in the canonical set because Go +
// Python both map it through their mapping table.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const GO_MAPPING = resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');

/**
 * Extract every `https://errors.driftstack.dev/<slug>` URI from a
 * source file. Used as a SDK-agnostic problem-type URI extractor.
 */
function extractProblemUris(source: string): Set<string> {
  const out = new Set<string>();
  const matches = source.matchAll(
    /['"`](https:\/\/errors\.driftstack\.dev\/[a-z][a-z0-9-]*)['"`]/g,
  );
  for (const m of matches) {
    out.add(m[1]!);
  }
  return out;
}

// The CANONICAL shared problem-type URIs, derived from the registry the
// server actually emits. Every URI here MUST map to a typed error class
// in every SDK; SDK-specific extras are allowed but not asserted.
const SHARED_PROBLEM_URIS = new Set<string>(Object.values(PROBLEM_TYPES));

describe('W676 cross-SDK problem-type URI parity', () => {
  it('all 3 SDK error-mapping files exist at canonical paths', () => {
    expect(existsSync(TS_ERRORS), `missing ${TS_ERRORS}`).toBe(true);
    expect(existsSync(GO_MAPPING), `missing ${GO_MAPPING}`).toBe(true);
    expect(existsSync(PY_ERRORS), `missing ${PY_ERRORS}`).toBe(true);
  });

  it('sdk-typescript maps every problem-type URI in PROBLEM_TYPES (in TYPE_TO_CTOR + the explicit rate-limited branch in errorFromProblem)', () => {
    const ts = extractProblemUris(read(TS_ERRORS));
    for (const uri of SHARED_PROBLEM_URIS) {
      expect(ts.has(uri), `sdk-typescript missing canonical URI ${uri}`).toBe(true);
    }
  });

  it('sdk-go maps every problem-type URI in PROBLEM_TYPES (in errorBuilders)', () => {
    const go = extractProblemUris(read(GO_MAPPING));
    for (const uri of SHARED_PROBLEM_URIS) {
      expect(go.has(uri), `sdk-go missing canonical URI ${uri}`).toBe(true);
    }
  });

  it('sdk-python maps every problem-type URI in PROBLEM_TYPES (in PROBLEM_TYPE_TO_ERROR)', () => {
    const py = extractProblemUris(read(PY_ERRORS));
    for (const uri of SHARED_PROBLEM_URIS) {
      expect(py.has(uri), `sdk-python missing canonical URI ${uri}`).toBe(true);
    }
  });

  it("CROSS-SDK invariant — every problem-type URI in PROBLEM_TYPES is a SUBSET of every SDK's mapping table. Drift to dropping any URI in any SDK would let a server-emitted problem-type silently surface as a generic DriftstackError on that SDK (customer's `catch (RateLimitError)` would miss a 429 if rate-limited URI was dropped).", () => {
    const ts = extractProblemUris(read(TS_ERRORS));
    const go = extractProblemUris(read(GO_MAPPING));
    const py = extractProblemUris(read(PY_ERRORS));

    for (const uri of SHARED_PROBLEM_URIS) {
      expect(ts.has(uri), `sdk-typescript missing ${uri}`).toBe(true);
      expect(go.has(uri), `sdk-go missing ${uri}`).toBe(true);
      expect(py.has(uri), `sdk-python missing ${uri}`).toBe(true);
    }

    // Drift-detection sanity: every SDK has at least 24 URIs mapped.
    expect(ts.size, 'sdk-typescript URI count').toBeGreaterThanOrEqual(24);
    expect(go.size, 'sdk-go URI count').toBeGreaterThanOrEqual(24);
    expect(py.size, 'sdk-python URI count').toBeGreaterThanOrEqual(24);
  });

  it('All canonical URIs share the `https://errors.driftstack.dev/<slug>` form (no other host, no path-segments). Drift to a different host would force the SDKs to re-route their entire mapping table; drift to multi-segment slugs would require URL parsing in the mapping table key.', () => {
    for (const uri of SHARED_PROBLEM_URIS) {
      expect(
        uri.startsWith('https://errors.driftstack.dev/'),
        `URI ${uri} should use canonical host`,
      ).toBe(true);
      const slug = uri.replace('https://errors.driftstack.dev/', '');
      // Slug must be lowercase + hyphenated (no slashes, no underscores).
      expect(slug, `URI slug ${slug} should be lowercase-hyphenated`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("Cross-SDK URI consistency — the SET of URIs mapped by all 3 SDKs combined includes EVERY canonical URI exactly once. Drift to having SDK-specific URIs the others don't map would fragment the wire contract (server emits URI X → TS surfaces typed X, but Go falls back to UnknownError on X).", () => {
    const ts = extractProblemUris(read(TS_ERRORS));
    const go = extractProblemUris(read(GO_MAPPING));
    const py = extractProblemUris(read(PY_ERRORS));

    // The intersection of all 3 sets must contain the canonical set.
    const intersection = new Set<string>();
    for (const uri of ts) {
      if (go.has(uri) && py.has(uri)) intersection.add(uri);
    }
    for (const uri of SHARED_PROBLEM_URIS) {
      expect(intersection.has(uri), `URI ${uri} should be in intersection of all 3 SDKs`).toBe(
        true,
      );
    }
  });

  it('test file metadata — file exists at canonical path + SHARED_PROBLEM_URIS is derived from PROBLEM_TYPES rather than frozen, so a newly added problem type is guarded the day it lands. Drift to a different count would mean the canonical set itself was modified — review carefully.', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-problem-type-parity.test.ts'),
      ),
    ).toBe(true);
    // Derived, so the count follows the registry. The floor is what stops a
    // registry that failed to load from making every arm above vacuous — a
    // subset assertion over an empty set passes against SDKs that map nothing.
    expect(SHARED_PROBLEM_URIS.size, 'canonical shared URI count').toBe(
      Object.values(PROBLEM_TYPES).length,
    );
    expect(SHARED_PROBLEM_URIS.size, 'PROBLEM_TYPES failed to load').toBeGreaterThanOrEqual(32);
  });
});
