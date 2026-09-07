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

describe('the pre-push CI check reports and never blocks', () => {
  it('CRITICAL it is ADVISORY — the block cannot fail the push', () => {
    // Blocking here would put a network call on the push path and hand CI a veto
    // over an urgent fix, which is the opposite of the continuous-deploy design.
    expect(BLOCK.length, 'the CI-check block must exist').toBeGreaterThan(200);
    expect(BLOCK).not.toMatch(/\bexit 1\b/);
  });

  it('CRITICAL "could not check" is reported, never silent', () => {
    // Silence on failure is the whole defect: it reads exactly like a green.
    expect(BLOCK).toMatch(/COULD NOT CHECK/);
    expect(BLOCK).toMatch(/Not a green/);
  });

  it('CRITICAL it reads a real VERDICT — in-progress and cancelled are excluded', () => {
    // Measured against the live API: an in-flight run returns "" and the latest
    // completed run was `cancelled`. Both would have been read as an answer.
    expect(BLOCK).toContain('"success"');
    expect(BLOCK).toContain('"failure"');
    expect(BLOCK).toContain('"timed_out"');
    expect(BLOCK, 'a cancelled or running result is not a verdict').not.toMatch(
      /select\(\.status == "completed"\)\s*\)\s*\|\s*\.\[0\]/,
    );
  });

  it('CRITICAL a red CI names the jobs the local gate does not run', () => {
    // The warning has to be actionable at the moment it fires, or it becomes the
    // next notice nobody acts on — which is what the placeholder command was.
    expect(BLOCK).toMatch(/verify-suite/);
  });

  it('VACUITY CONTROL — the hook is the real file and the block was located', () => {
    expect(HOOK).toContain('refs/tags/gui-v*');
    expect(BLOCK).toContain('gh run list');
  });
});
