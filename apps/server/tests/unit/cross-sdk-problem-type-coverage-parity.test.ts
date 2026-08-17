// Every problem type the server can emit is mapped by every SDK.
//
// An SDK that does not recognise a problem type falls into its unknown-error
// path, and the three SDKs do NOT agree there. Measured by running a 34-case
// matrix through all three mappers — the 32 canonical types plus an unknown one
// and a body with no `type` field:
//
//   all 32 real types      identical retryability in TS, Python and Go
//   no `type` field, 500   retryable in all three (each treats a non-problem
//                          body as a transport-level contract violation)
//   UNKNOWN type, 500      TS retries it; Python and Go do not
//
// That last row is why this file exists. It is reached exactly when the server
// grows a problem type an installed SDK predates — and the server has 32 and
// adds to them. On a 5xx the customer's retry loop then behaves differently
// depending on which language they chose, and for two of the three a transient
// server error stops being retried at all until they upgrade.
//
// Closing the split itself is a semantics decision about SDK retry behaviour,
// raised on the bus rather than taken here. What this file does is remove the
// way in: a new problem type must be added to all three SDKs, or this fails.
//
// The roster is read from `PROBLEM_TYPES` in api-types rather than restated, so
// a type added there is covered the moment it is added — which is the only
// timing that helps, since the gap opens when the server ships the new type.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

const CANONICAL = 'packages/api-types/src/problem.ts';
const SDKS: ReadonlyArray<readonly [string, string]> = [
  ['sdk-typescript', 'packages/sdk-typescript/src/errors.ts'],
  ['sdk-python', 'packages/sdk-python/src/driftstack/errors.py'],
  ['sdk-go', 'packages/sdk-go/error_mapping.go'],
];

const TYPE_RE = /https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+/g;

/** The problem types the server declares it can emit. */
function canonicalTypes(): string[] {
  const body = read(CANONICAL);
  const block = /PROBLEM_TYPES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(body);
  expect(block, 'the PROBLEM_TYPES table could not be located').not.toBeNull();
  return [...new Set((block?.[1] ?? '').match(TYPE_RE) ?? [])];
}

describe('every problem type the server emits is mapped by every SDK', () => {
  const canonical = canonicalTypes();

  it('CRITICAL the canonical roster parsed to a real population', () => {
    // Without this a rename or reshape turns every check below into a
    // comparison of two empty lists.
    expect(canonical.length, 'PROBLEM_TYPES parsed empty').toBeGreaterThanOrEqual(25);
    expect(canonical, 'a known type must survive the parse').toContain(
      'https://errors.driftstack.dev/rate-limited',
    );
  });

  it.each(SDKS)('CRITICAL %s maps every canonical problem type', (name, path) => {
    const mapped = new Set(read(path).match(TYPE_RE) ?? []);
    const missing = canonical.filter((t) => !mapped.has(t));
    expect(
      missing,
      `${name} does not map these problem types, so a response carrying one lands in its ` +
        'unknown-error path. The three SDKs disagree there — TypeScript retries an unknown type ' +
        'on a 5xx and Python and Go do not — so the customer’s retry behaviour would depend on ' +
        'which language they chose, and for two of the three a transient server error would stop ' +
        'being retried until they upgrade',
    ).toEqual([]);
  });

  it('CRITICAL no SDK maps a type the server does not declare', () => {
    // The other direction: a stale entry is a mapping for something that can
    // never arrive, and usually means a type was renamed on the server without
    // the SDKs following.
    const canonicalSet = new Set(canonical);
    const stale = SDKS.flatMap(([name, path]) =>
      [...new Set(read(path).match(TYPE_RE) ?? [])]
        .filter((t) => !canonicalSet.has(t))
        .map((t) => `${name}: ${t}`),
    );
    expect(
      stale,
      'an SDK maps a problem type the server no longer declares — most likely a server-side ' +
        'rename the SDKs did not follow, which means the real type is now unmapped',
    ).toEqual([]);
  });
});
