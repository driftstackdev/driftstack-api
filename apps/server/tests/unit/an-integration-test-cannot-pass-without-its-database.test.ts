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
//
// V-793 — and the first version of this guard certified 18 files whose assertion
// NEVER RAN. It searched the file for the assertion text and found it, but the
// text sat inside `beforeAll`, where `it()` registers nothing: vitest silently
// drops it, the file's registered-test count is one lower than its `it(`
// occurrences, and the hole the arm was added to close stayed wide open. A guard
// that matches text cannot tell a registered test from dead code in a hook —
// which is the same defect it exists to catch, one level up. The scan is now
// POSITION-AWARE: the assertion only counts when it sits inside an `it(`/`test(`
// body. Measured when that landed: 18 offenders, every one of them a file this
// guard had previously reported clean.

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

/**
 * The bodies of every registered `it(` / `test(` in a file, brace-matched.
 *
 * V-793 — this is the whole point. An assertion inside `beforeAll` is text in the
 * file and nothing else; only an assertion inside a registered case can fail.
 * Brace-matched rather than windowed because these bodies run long and a fixed
 * window would spill into the next case, which is how a scan like this reports
 * the wrong answer confidently.
 */
function registeredCaseBodies(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:it|test)(?:\.\w+)*\s*\(/g)) {
    const open = source.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** Bodies of `before*` / `after*` hooks — where an assertion is inert. */
function hookBodies(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g)) {
    const open = source.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** True when the dependency assertion sits inside a case that actually runs. */
function assertsInsideARegisteredCase(source: string): boolean {
  return registeredCaseBodies(source).some((b) => ASSERTS_THE_DEPENDENCY_WAS_THERE.test(b));
}

function integrationFiles(): string[] {
  return readdirSync(INTEGRATION_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(INTEGRATION_DIR, f));
}

describe('an integration test cannot pass without the service it integrates with', () => {
  it('CRITICAL the scan finds real integration files, so the check below is not vacuous', () => {
    const files = integrationFiles();
    // V-937 — floors raised from 50 and 10 to just under measured (351 files, 99
    // of them using the bail idiom). At 50 and 10 this scan could have lost 86%
    // and 90% of its corpus and still reported success, which is the vacuous pass
    // this whole file exists to prevent, aimed at itself.
    expect(files.length, 'no integration tests found — the scan is broken').toBeGreaterThan(320);
    expect(
      files.filter((f) => BAILS_ON_MISSING_DEPENDENCY.test(readFileSync(f, 'utf-8'))).length,
      'no file uses the bail idiom — the pattern this guards has changed shape',
    ).toBeGreaterThan(90);
  });

  it('CRITICAL every file that bails on a missing service also asserts the service was there', () => {
    const offenders = integrationFiles()
      .filter((f) => {
        const body = readFileSync(f, 'utf-8');
        return BAILS_ON_MISSING_DEPENDENCY.test(body) && !assertsInsideARegisteredCase(body);
      })
      .map((f) => f.slice(f.lastIndexOf('/') + 1))
      .sort();

    expect(
      offenders,
      'these bail out when the service is missing and never assert it was present, so with the ' +
        'describe running and the service down they report PASSED — add an arm asserting the handle',
    ).toEqual([]);
  });

  it("CRITICAL no file puts the dependency assertion inside a before/after HOOK, where it never runs. This is reported separately from the case above because the two need different fixes and look identical from a text search: a missing assertion needs one written, an inert one needs it MOVED. vitest drops an it() registered from inside a hook without a word, so the only visible symptom is a registered-test count one lower than the file's it( occurrences — nothing a reader would notice.", () => {
    const inert = integrationFiles()
      .filter((f) => {
        const body = readFileSync(f, 'utf-8');
        const inAHook = hookBodies(body).some((h) => /\b(?:it|test)\s*\(/.test(h));
        return inAHook;
      })
      .map((f) => f.slice(f.lastIndexOf('/') + 1))
      .sort();

    expect(
      inert,
      'these register a case from inside a hook, so it never runs — move the it() out of the hook into the describe:',
    ).toEqual([]);
  });

  it('CRITICAL the position-awareness itself works, asserted on fixtures rather than on the corpus. The corpus is expected to be clean, so a matcher that silently accepted everything would agree with it — the same way the previous version of this guard agreed with 18 broken files.', () => {
    const inACase = [
      "it('x', () => { expect(client).not.toBeNull(); });",
      "it('x', async () => {\n  expect(dbReachable, 'msg').toBe(true);\n});",
    ];
    const inAHook = [
      'beforeAll(async () => { expect(client).not.toBeNull(); });',
      "beforeEach(() => {\n  expect(dbReachable, 'msg').toBe(true);\n});",
    ];
    for (const src of inACase) {
      expect(assertsInsideARegisteredCase(src), `should count: ${src.slice(0, 40)}`).toBe(true);
    }
    for (const src of inAHook) {
      expect(assertsInsideARegisteredCase(src), `must NOT count: ${src.slice(0, 40)}`).toBe(false);
    }
  });
});
