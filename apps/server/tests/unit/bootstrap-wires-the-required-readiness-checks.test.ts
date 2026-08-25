// Production wires the readiness checks that `/ready` relies on existing.
//
// `/ready` is deliberately permissive: with no checks configured it answers 200
// with `checks: []`, documented as "process-up semantics only" and pinned in
// three places — `ready-probe-degradation` calls it "the fixture default every
// other suite relies on". That is a real decision and this file does not touch
// it. Every test fixture builds an app without checks, and every one of them
// gets a 200.
//
// The consequence is what this file is for. Because the endpoint declines to
// fail on an empty list, the entire safety property lives in the BOOTSTRAP
// wiring — and if that wiring were dropped, production `/ready` would answer 200
// forever while Postgres was unreachable, an orchestrator would keep routing to
// the instance, and EVERY EXISTING TEST WOULD STILL PASS, because they all
// exercise the empty-list path that is pinned as correct.
//
// `Array.every` on an empty array returns true. `results.every((c) => c.ok)` is
// therefore satisfied by having checked nothing, which is the same vacuity as an
// absence assertion over an empty collection — here promoted into an
// infrastructure signal that decides whether traffic reaches a broken process.
//
// What existed already: `lib-bootstrap-content-parity` pins the COMMENT
// describing the semantics — that "readinessChecks fire every /ready hit" and
// "/ready 503 on any reachable-but-failing dep". Prose about the behaviour, and
// nothing reading the behaviour. `ready-probe-degradation` covers the endpoint
// thoroughly given checks; it cannot know whether production supplies any.
//
// So: Postgres and Redis are REQUIRED and asserted by name. R2 is conditional by
// design — "R2 only checked if configured" — and is asserted to be conditional
// rather than asserted present, because requiring it would be wrong.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts');

/** Dependencies whose failure must stop traffic reaching this instance. */
const REQUIRED_CHECKS = ['postgres', 'redis'];

const source = (): string => readFileSync(BOOTSTRAP, 'utf8');

/**
 * The `readinessChecks` array literal, sliced from its declaration.
 *
 * Anchors are asserted unique and ordered and the slice is bounded, because a
 * slice taken on a repeated anchor either sweeps the file — making a positive
 * containment pass for the wrong reason — or inverts into an empty string,
 * making one pass for no reason at all.
 */
function readinessArrayLiteral(): string {
  const src = source();
  const anchor = 'const readinessChecks: ReadinessCheck[] = [';
  expect(src.split(anchor).length - 1, 'the declaration anchor is unique').toBe(1);
  const start = src.indexOf(anchor);
  const end = src.indexOf('\n  ];', start);
  expect(start, 'the readinessChecks declaration was located').toBeGreaterThan(-1);
  expect(end, 'and its closing bracket after it').toBeGreaterThan(start);
  const literal = src.slice(start, end);
  expect(literal.length, 'the slice is the array literal, not a swathe of bootstrap').toBeLessThan(
    2000,
  );
  return literal;
}

describe('bootstrap wires the readiness checks /ready depends on', () => {
  it('CRITICAL the array literal was located and is non-trivial. Every assertion below reads this slice, and a slice that came back empty would report the required checks missing — or, inverted, report them present having read nothing.', () => {
    const literal = readinessArrayLiteral();
    expect(literal.length, 'array literal length').toBeGreaterThan(150);
    expect(literal, 'it is the readiness array').toContain('ReadinessCheck[]');
  });

  it('CRITICAL Postgres and Redis readiness checks are constructed. /ready answers 200 on an empty list by design, so nothing about the endpoint notices if these disappear — production would report itself ready with an unreachable database and every existing test would still pass.', () => {
    const literal = readinessArrayLiteral();
    const missing = REQUIRED_CHECKS.filter((name) => !literal.includes(`name: '${name}'`));
    expect(missing, 'required readiness check(s) not constructed in bootstrap:').toEqual([]);
  });

  it('CRITICAL each required check actually probes its dependency. A check whose fn resolves unconditionally is worse than no check: it reports the dependency healthy rather than unknown, and /ready turns that into a 200.', () => {
    const literal = readinessArrayLiteral();
    expect(literal, 'the Postgres check issues a query').toMatch(/SELECT 1/);
    expect(literal, 'the Redis check pings').toMatch(/redis\.ping\(\)/);
  });

  it('CRITICAL the checks reach the app. Constructing them and not passing them through leaves /ready with the empty list it treats as ready — the same outcome as never building them.', () => {
    const src = source();
    expect(src.split('readinessChecks,').length - 1, 'passed to the app deps exactly once').toBe(1);
  });

  it('CRITICAL R2 stays CONDITIONAL. It is checked only when configured — "R2 only checked if configured" — so asserting it is always present would encode the wrong requirement and fail every deployment that does not use R2.', () => {
    const src = source();
    expect(src, 'R2 is pushed behind a configuration test').toMatch(
      /if \(r2 !== null\) \{\s*readinessChecks\.push\(r2ReadinessCheck\(r2\)\);/,
    );
    expect(readinessArrayLiteral(), 'and is not in the unconditional literal').not.toContain(
      'r2ReadinessCheck',
    );
  });
});
