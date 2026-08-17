// An integration test that bails when its dependency is missing must also
// ASSERT the dependency was there.
//
// The idiom across `tests/integration` is a module-level `client` (or `redis`)
// that stays null when the service is unreachable, and every arm opening with
// `if (!client) return;`. That is correct when the suite runs without a
// database — the `describe.skipIf` skips the block and nothing claims to have
// tested anything.
//
// The hole is when the describe DOES run and the service is down. Every arm
// returns early and the file reports as PASSED. Measured on
// `db-pricing-repo-drizzle` before this landed: pointed at a dead Postgres, the
// file reported 2 passed — a green that meant "no database" and was
// indistinguishable from one that meant "the database agreed".
//
// 14 files were in that state. Each now carries one arm asserting the handle is
// non-null, so a missing service is a FAILURE rather than a silent pass. This
// keeps it that way: the fix was mechanical, and so is the regression.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION_DIR = resolve(HERE, '..', 'integration');

/**
 * `if (!client) return;` and its variants — the early bail on a missing service.
 *
 * The condition is matched loosely on purpose. The first version anchored the
 * closing paren directly after the handle, so `if (!dbReachable || !repo) return;`
 * — a perfectly ordinary compound bail — was invisible to it, and a file written
 * that way carried the exact hole this guards while the scan reported it clean.
 * Anything that mentions a handle inside a negated condition counts now.
 */
const BAILS_ON_MISSING_DEPENDENCY =
  /if \(![^)]*\b(?:client|redis|reachable|dbReachable)\b[^)]*\)\s*(?:return|\{[^}]*return)/i;

/**
 * Something in the file asserts the handle was actually there.
 *
 * Deliberately permissive about FORM: an `expect(...).not.toBeNull()`, an
 * `expect(reachable).toBe(true)`, or a `throw` naming the unreachable service
 * all close the hole. Pinning one spelling would reject correct files — the
 * first draft did exactly that, matching a literal `toBe(true)` and flagging
 * three files whose only sin was that prettier had wrapped the call across
 * lines. Whitespace inside the matcher is tolerated for that reason.
 */
const ASSERTS_THE_DEPENDENCY_WAS_THERE =
  /(expect\(\s*\b(client|redis|reachable|dbReachable)\b[^;]*?(not\.toBeNull|toBe\(\s*true\s*,?\s*\)|toBeTruthy)|throw new Error\([^)]*(unreachable|database unreachable|setup failed|not present))/is;

function integrationFiles(): string[] {
  return readdirSync(INTEGRATION_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(INTEGRATION_DIR, f));
}

describe('an integration test cannot pass without the service it integrates with', () => {
  it('CRITICAL the scan finds real integration files, so the check below is not vacuous', () => {
    const files = integrationFiles();
    expect(files.length, 'no integration tests found — the scan is broken').toBeGreaterThan(50);
    expect(
      files.filter((f) => BAILS_ON_MISSING_DEPENDENCY.test(readFileSync(f, 'utf-8'))).length,
      'no file uses the bail idiom — the pattern this guards has changed shape',
    ).toBeGreaterThan(10);
  });

  it('CRITICAL every file that bails on a missing service also asserts the service was there', () => {
    const offenders = integrationFiles()
      .filter((f) => {
        const body = readFileSync(f, 'utf-8');
        return (
          BAILS_ON_MISSING_DEPENDENCY.test(body) && !ASSERTS_THE_DEPENDENCY_WAS_THERE.test(body)
        );
      })
      .map((f) => f.slice(f.lastIndexOf('/') + 1))
      .sort();

    expect(
      offenders,
      'these bail out when the service is missing and never assert it was present, so with the ' +
        'describe running and the service down they report PASSED — add an arm asserting the handle',
    ).toEqual([]);
  });
});
