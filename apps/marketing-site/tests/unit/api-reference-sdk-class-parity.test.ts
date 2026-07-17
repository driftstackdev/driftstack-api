// W338.B — drift guard for the "SDK class" column on the
// marketing /api-reference error-taxonomy table. Each cited class
// must be an actual export of the TS SDK; otherwise customers
// `import` the name and get a TypeError. Python + Go SDKs share
// the same class names (see packages/sdk-python/.../errors.py +
// packages/sdk-go/errors.go), so pinning against the TS export is
// load-bearing for all three.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');
const SDK_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W338.B /api-reference SDK class column parity', () => {
  const body = read(PAGE);
  const sdkErrors = read(SDK_ERRORS);

  // The error-taxonomy table cites these class names in the
  // rightmost column. Each must be an `export class <Name>` in
  // the SDK errors module.
  const cited = [
    'ValidationError',
    'AuthError',
    'NotFoundError',
    'ConflictError',
    'SessionDestroyedError',
    'TierLimitError',
    'RateLimitError',
    'ConcurrencyLimitError',
    'FeatureUnavailableError',
    'InternalError',
  ];

  for (const cls of cited) {
    it(`cites ${cls} and the SDK exports it`, () => {
      expect(body).toContain(cls);
      expect(sdkErrors).toMatch(new RegExp(`export class ${cls}\\b`));
    });
  }

  it('does not cite a class name that no longer exists in the SDK', () => {
    // Belt-and-braces: catch any future "PrettyName" rename that
    // drifts away from the TS SDK. We grep the table-body cells
    // for capitalised `<Name>Error` patterns and verify each one
    // is either DriftstackError or has a matching export.
    const tdMatches = [...body.matchAll(/<td class="py-2">([A-Z][A-Za-z]*Error)/g)].map(
      (m) => m[1]!,
    );
    const offenders = [...new Set(tdMatches)].filter(
      (name) => !new RegExp(`export class ${name}\\b`).test(sdkErrors),
    );
    expect(offenders).toEqual([]);
  });

  it('flags RateLimitError as retryable and FeatureUnavailableError as not retryable', () => {
    // The retryable/not-retryable framing is what tells SDK
    // consumers when to use `isRetryable(err)`. Pin it so a
    // future style rewrite doesn't silently drop the cue.
    expect(body).toMatch(/RateLimitError\s*<em[^>]*>\(retryable\)/);
    expect(body).toMatch(/InternalError\s*<em[^>]*>\(retryable\)/);
    expect(body).toMatch(/FeatureUnavailableError\s*<em[^>]*>\(NOT retryable\)/);
  });

  it('maps the internal problem type to InternalError rather than the base transport class', () => {
    expect(body).toMatch(
      /errors\.driftstack\.dev\/internal[\s\S]*?<td class="py-2">InternalError <em/,
    );
    expect(body).not.toMatch(/DriftstackError \(kind: <code>internal<\/code>\)/);
  });
});
