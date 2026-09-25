// W-34 — nothing told anyone CI was red, so the pre-push hook now says.
//
// CI sat red for 22 hours while every deploy shipped green. Two facts made that
// possible and both are deliberate: the local gate runs only the `build-test` job
// (its own notice says so), and the Deploy workflow does not depend on CI. So a
// failing e2e or SDK job produced no signal anywhere a person actually looks.
//
// ⛔ THE THIRD STATE IS THE POINT. A check that goes quiet when it cannot run is
// indistinguishable from a green one — the defect this family of guards keeps
// producing. And two further states masquerade as an answer here, both found by
// probing the real API rather than by reasoning: an IN-PROGRESS run has an EMPTY
// conclusion (not null, so a `// "none"` default never fires), and the most recent
// COMPLETED run is frequently `cancelled`, because a newer push supersedes an
// in-flight one. Either would have been a distinct state wearing another's label.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = readFileSync(resolve(HERE, '..', '..', '..', '..', '.husky', 'pre-push'), 'utf8');
/** The CI-check block: from its W-34 marker to the hook's closing line. */
const BLOCK = HOOK.slice(HOOK.indexOf('# W-34'), HOOK.indexOf('pre-push gate clean'));
/** The script the block runs (2026-09-25: the logic moved there so it can be
 *  EXECUTED by a test — scripts/tests/the-pre-push-ci-line-is-the-verdict-for-
 *  origin-mains-head.test.ts runs it in every state with a stand-in gh). */
const SCRIPT = readFileSync(
  resolve(HERE, '..', '..', '..', '..', 'scripts', 'ci-verdict-on-main.mjs'),
  'utf8',
);
/** What the check says and does: the block and the script it runs. */
const CHECK = `${BLOCK}\n${SCRIPT}`;

describe('the pre-push CI check reports and never blocks', () => {
  it('CRITICAL it is ADVISORY — the block cannot fail the push', () => {
    // Blocking here would put a network call on the push path and hand CI a veto
    // over an urgent fix, which is the opposite of the continuous-deploy design.
    expect(BLOCK.length, 'the CI-check block must exist').toBeGreaterThan(200);
    expect(BLOCK).not.toMatch(/\bexit 1\b/);
    // The script's own exit is 0 in every state, and the block does not trust it.
    expect(BLOCK).toMatch(/node scripts\/ci-verdict-on-main\.mjs \|\| /);
    expect(SCRIPT).toMatch(/process\.exitCode = 0/);
    expect(SCRIPT).not.toMatch(/process\.exit\(1\)|exitCode = 1/);
  });

  it('CRITICAL "could not check" is reported, never silent', () => {
    // Silence on failure is the whole defect: it reads exactly like a green.
    expect(CHECK).toMatch(/COULD NOT CHECK/);
    expect(CHECK).toMatch(/Not a green/);
  });

  it('CRITICAL it reads a real VERDICT — in-progress and cancelled are excluded', () => {
    // Measured against the live API: an in-flight run returns "" and the latest
    // completed run was `cancelled`. Both would have been read as an answer.
    expect(SCRIPT).toContain("'success'");
    expect(SCRIPT).toContain("'failure'");
    expect(SCRIPT).toContain("'timed_out'");
    expect(SCRIPT, 'a cancelled or running result is not a verdict').toMatch(
      /run\.status !== 'completed'/,
    );
  });

  it('CRITICAL a red CI names the jobs the local gate does not run', () => {
    // The warning has to be actionable at the moment it fires, or it becomes the
    // next notice nobody acts on — which is what the placeholder command was.
    expect(SCRIPT).toMatch(/verify-suite/);
  });

  it('CRITICAL the verdict carries the RUN it read', () => {
    // ⛔ The first time this fired for real it said `failure`, and the state was
    // not reproducible a minute later. A verdict with no subject cannot be
    // audited: there is no way to tell a stale read, a race, or a real red apart.
    // Reporting the sha is what makes the warning checkable rather than one more
    // thing to believe.
    // …and since 2026-09-25 the subject is ONE commit, the head of origin/main,
    // and only that commit's runs are admitted: a verdict for another sha was
    // what printed "green (7172d0cc5)" over a head with no verdict yet.
    expect(SCRIPT).toContain('headSha');
    expect(SCRIPT).toMatch(/r\.headSha === head/);
    expect(SCRIPT).toContain('commits/main');
  });

  it('VACUITY CONTROL — the hook is the real file and the block was located', () => {
    expect(HOOK).toContain('refs/tags/gui-v*');
    expect(BLOCK).toContain('ci-verdict-on-main.mjs');
    expect(SCRIPT).toContain("'run',\n          'list'");
  });
});
