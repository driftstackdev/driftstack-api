// W-34 — the gate names its own blind spots, and those names must be COMMANDS.
//
// ⛔ THE NOTICE WORKED AND THE INSTRUCTION DID NOT. `verify-suite` prints, on every
// green run, that four other CI jobs are not covered here, each with "how to run it
// locally". Accurate, prominent, read every time — and the e2e entry said
//   DATABASE_URL=<disposable db> REDIS_URL=<unused index> node scripts/e2e-local.mjs
// which cannot be pasted. The reader must invent a database name and choose a Redis
// index, at the exact moment they have just been told everything passed.
//
// Measured cost: CI sat red for 22 hours on two route-census bounds held by that
// very job, while the deploy workflow — which does not depend on CI — kept shipping
// green. The blind-spot notice was doing its job; the friction in its remedy was
// doing more.
//
// So the property is not "a local command is documented" but "a local command can
// be RUN". Two of the four entries also silently lacked a `cd`, which no reader
// would have noticed until it failed in their shell.

import { describe, expect, it } from 'vitest';
import { NOT_COVERED_BY_THIS_GATE } from '../../../../scripts/verify-suite.mjs';

/** Anything angle-bracketed is a hole the reader has to fill. */
const PLACEHOLDER = /<[^>]+>/;
/** A runnable line starts with something a shell can execute. */
const RUNNABLE_START = /^(npm |cd |node |bash |npx |\.\/)/;

describe("the gate's blind-spot notice is runnable", () => {
  it('CRITICAL every entry names a command with no placeholders to fill in', () => {
    const holes = NOT_COVERED_BY_THIS_GATE.filter((s) => PLACEHOLDER.test(s.local)).map(
      (s) => `${s.job}: ${s.local}`,
    );
    expect(holes, 'a command with a placeholder is a description of a command').toEqual([]);
  });

  it('CRITICAL every entry starts with something a shell can execute', () => {
    // `packages/sdk-python && …` reads fine and is not a command — the missing `cd`
    // is invisible in prose and obvious the moment it is pasted.
    const unrunnable = NOT_COVERED_BY_THIS_GATE.filter((s) => !RUNNABLE_START.test(s.local)).map(
      (s) => `${s.job}: ${s.local}`,
    );
    expect(unrunnable).toEqual([]);
  });

  it('CRITICAL the e2e entry points at the ONE command that provisions its own target', () => {
    // The e2e harness refuses a non-disposable target — it TRUNCATEs and flushdb()s
    // — so "run e2e locally" is only actionable if something creates the throwaway
    // database for you. That is the whole difference between the old line and this.
    const e2e = NOT_COVERED_BY_THIS_GATE.find((s) => s.job === 'e2e');
    expect(e2e, 'the e2e job must still be declared a blind spot').toBeDefined();
    expect(e2e?.local).toContain('test:e2e:disposable');
  });

  it('VACUITY CONTROL — the list is non-empty and the detectors would fire', () => {
    // Without this, an emptied list satisfies every arm above by having no members.
    expect(NOT_COVERED_BY_THIS_GATE.length).toBeGreaterThanOrEqual(4);
    expect(PLACEHOLDER.test('DATABASE_URL=<disposable db> node x.mjs')).toBe(true);
    expect(RUNNABLE_START.test('packages/sdk-python && pytest')).toBe(false);
  });
});
