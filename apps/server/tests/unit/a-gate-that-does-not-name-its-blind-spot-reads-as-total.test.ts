// `verify-suite --all` is ONE CI job, and its own comment called it CI.
//
// The comment on EXPECTED_TEST_FILES_ALL read "every project, which is what CI
// runs". That is true of the two vitest projects and false of the pipeline: CI has
// five jobs, and this gate is `build-test`. The other four — Playwright e2e,
// Python SDK, Go SDK, bench — are never touched by it.
//
// It matters because of how the green is quoted. Every commit message in this
// repo that says "verified at the CI bar" is citing this gate, so a claim about
// the whole pipeline gets made from a run covering a fifth of it. Measured
// 2026-08-18 and re-run 2026-08-19, all green and none of it by this gate: 199
// Playwright tests over 31 spec files, 365 passing Python tests (4 skipped, each
// wanting a live server), and 236 Go tests. V-1036 executed the Go and Python
// suites rather than citing them and said Playwright could only be enumerated.
// V-1037 ran it: no browsers and no external server are involved, because the
// config declares neither a webServer nor a browser project and every spec starts
// the app in-process. All 199 pass against a throwaway database.
//
// V-992 — the paragraph that stood here said the 29 e2e spec files were the only
// tests exercising `apps/server/src/db/**` against a real Postgres, and concluded
// that this gate never executes the database layer. Both halves were wrong, and
// this file made the claim on 2026-08-18 — four days AFTER `vitest.config.ts`
// recorded the same justification as expired, in a commit titled "53 files sit
// outside the coverage gate on a reason that expired".
//
// 135 integration files import `../../src/db/`, 134 keyed to `DATABASE_URL`. The
// `build-test` job — the job this gate IS — sets `DATABASE_URL`, migrates the
// schema, then runs the suite, so `describe.skipIf(!CI && !DATABASE_URL)` resolves
// to RUN. The db layer is executed by this gate. What it is not is MEASURED:
// `vitest.config.ts` excludes `apps/server/src/db/**` from coverage.
//
// So the blind spot is real but narrower and of a different kind than was written:
// the layer runs here and nothing reports which parts of it ran. Overstating it
// is the failure the second arm below already names — a blind spot described wider
// than it is "excuses nothing while making the blind spot look wider than it is,
// and the next real gap hides behind the noise." That is what happened, in this
// file, about this repo's own verification posture.
//
// So the dispositions are derived against the workflow rather than remembered.
// Every job in ci.yml must be either the job this gate IS, or listed as not
// covered with a way to run it locally. A new CI job fails this until someone
// says which it is — the same reason the cross-account censuses exist: "not run
// here" and "not a test job" must never look identical from a green run.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NOT_COVERED_BY_THIS_GATE,
  THIS_GATE_IS_CI_JOB,
} from '../../../../scripts/verify-suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * Job ids from the workflow: two-space-indented keys under `jobs:`.
 *
 * `on:` triggers (`push:`, `pull_request:`) sit at the same indent, so they are
 * excluded by name — and asserted absent below, because a filter that silently
 * stopped matching would shrink the census rather than fail it.
 */
function ciJobIds(yaml: string): string[] {
  const ids = [...yaml.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_-]*):$/gm)].map((m) => m[1] as string);
  return ids.filter((id) => id !== 'push' && id !== 'pull_request').sort();
}

describe('a gate that does not name its blind spot reads as total', () => {
  it('CRITICAL every CI job is either this gate or named as not covered by it. A green from one job is quoted as "the CI bar"; the only thing that keeps that honest is an enumeration nobody can forget to update, because forgetting produces a passing run rather than a failing one.', () => {
    const jobs = ciJobIds(read('.github/workflows/ci.yml'));
    expect(
      jobs.length,
      'the ci.yml job census parsed as empty — the regex, not the workflow',
    ).toBeGreaterThan(3);
    expect(jobs, 'the parser picked up a workflow trigger as a job').not.toContain('push');

    const accounted = new Set([THIS_GATE_IS_CI_JOB, ...NOT_COVERED_BY_THIS_GATE.map((s) => s.job)]);
    const unaccounted = jobs.filter((j) => !accounted.has(j));
    expect(
      unaccounted,
      `these CI jobs are neither this gate nor listed as outside it:\n  ${unaccounted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the not-covered list cannot rot — every job it names must still exist in ci.yml. An entry for a deleted job excuses nothing while making the blind spot look wider than it is, and the next real gap hides behind the noise.', () => {
    const jobs = new Set(ciJobIds(read('.github/workflows/ci.yml')));
    const gone = NOT_COVERED_BY_THIS_GATE.filter((s) => !jobs.has(s.job)).map((s) => s.job);
    expect(gone, `named as not covered but no longer a CI job:\n  ${gone.join('\n  ')}`).toEqual(
      [],
    );
    expect(jobs.has(THIS_GATE_IS_CI_JOB), 'the job this gate claims to be no longer exists').toBe(
      true,
    );
  });

  it('CRITICAL each not-covered entry carries a way to RUN it. A blind spot you cannot act on is a disclaimer; the whole value of naming these is that someone reading a green can go and close one in a minute.', () => {
    for (const s of NOT_COVERED_BY_THIS_GATE) {
      expect(s.what, `${s.job} has no description`).toBeTruthy();
      expect(s.local, `${s.job} has no local command`).toBeTruthy();
      expect(s.local.length, `${s.job}'s local command is too short to be one`).toBeGreaterThan(10);
    }
  });

  it('CRITICAL the e2e specs really are outside the vitest projects, so naming them is not paranoia. `vitest.node.config.ts` excludes `**/tests/e2e/**` and the gui-client project only collects .tsx under its own tests dir — if e2e were ever folded in, this file would be describing a blind spot that had closed, which is its own kind of wrong.', () => {
    expect(read('vitest.node.config.ts'), 'the node project no longer excludes tests/e2e').toMatch(
      /exclude:\s*\[[^\]]*'\*\*\/tests\/e2e\/\*\*'/,
    );
    expect(
      NOT_COVERED_BY_THIS_GATE.some((s) => s.job === 'e2e'),
      'e2e must stay named while it stays excluded',
    ).toBe(true);
  });

  it('V-992 CRITICAL the database layer is EXECUTED by this gate and merely unmeasured by it, which is a different and narrower blind spot than "e2e is the only thing that touches it". Derived from the three sources that disagreed rather than restated, because the wrong version of this survived four days in two files while a third already recorded it as expired — and a blind spot described wider than it is buries the next real one.', () => {
    const integration = resolve(REPO_ROOT, 'apps/server/tests/integration');
    const dbTests = readdirSync(integration).filter((f) => {
      if (!f.endsWith('.test.ts')) return false;
      const src = readFileSync(resolve(integration, f), 'utf8');
      return src.includes("from '../../src/db/") && src.includes('DATABASE_URL');
    });
    expect(
      dbTests.length,
      'integration files exercising src/db and keyed to DATABASE_URL — if this collapses, the ' +
        'expired "only e2e touches the db layer" justification becomes true again and the ' +
        'paragraph above needs rewriting, not this floor lowering',
    ).toBeGreaterThanOrEqual(100);

    // They RUN in this gate's job, which is the half that was stated backwards.
    const ci = read('.github/workflows/ci.yml');
    const buildTest = ci.slice(ci.indexOf('build-test:'), ci.indexOf('  e2e:'));
    expect(buildTest, 'build-test no longer provides a DATABASE_URL').toMatch(
      /DATABASE_URL:\s*postgres:/,
    );
    expect(
      buildTest,
      'build-test no longer migrates before testing — without this the db tests vacuous-pass',
    ).toMatch(/db:migrate/);

    // And the genuine gap: executed, not measured.
    expect(
      read('vitest.config.ts'),
      'src/db is no longer excluded from coverage — then the db layer IS measured and this arm ' +
        'should be retired along with the paragraph above',
    ).toMatch(/'apps\/server\/src\/db\/\*\*'/);
  });

  it('CRITICAL the skip shares the gate quotes are derived, not remembered. V-1035 found them reading 95 files gated on DATABASE_URL against a real 99, inside the very paragraph that warns a reader against quoting a stale skip count. A disclosure whose own numbers drift teaches the opposite of what it says.', () => {
    const gate = read('scripts/verify-suite.mjs');

    const counted = { db: new Set<string>(), runDb: new Set<string>(), redis: new Set<string>() };
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(rel);
        } else if (/\.(test|spec)\.ts$/.test(entry.name)) {
          const src = read(rel);
          for (const m of src.matchAll(
            /\b(?:describe|it|test)\.skipIf\(([^)]*(?:\([^)]*\))?[^)]*)\)/g,
          )) {
            const cond = m[1] ?? '';
            if (cond.includes('DATABASE_URL')) counted.db.add(rel);
            else if (cond.includes('RUN_DB_TESTS')) counted.runDb.add(rel);
            else if (cond.includes('REDIS_URL')) counted.redis.add(rel);
          }
        }
      }
    };
    walk('apps');

    expect(counted.db.size, 'files gating on DATABASE_URL').toBeGreaterThanOrEqual(90);
    for (const [label, re, actual] of [
      ['DATABASE_URL', /(\d+) test files gate on/, counted.db.size],
      ['RUN_DB_TESTS', /(\d+) on `RUN_DB_TESTS`/, counted.runDb.size],
      ['REDIS_URL', /(\d+) on `REDIS_URL`/, counted.redis.size],
    ] as const) {
      const stated = re.exec(gate);
      expect(stated, `the gate no longer states a ${label} share`).not.toBeNull();
      expect(
        Number(stated?.[1] ?? -1),
        `the gate says ${String(stated?.[1])} files gate on ${label}; there are ${actual}`,
      ).toBe(actual);
    }
  });

  it('CRITICAL the Playwright spec-file count both files quote is derived. The three TEST counts beside it cannot be — they need browsers, a live server and a Go toolchain, so they stay dated snapshots that V-1036 re-ran by hand. The FILE count needs none of that, and a figure that can be checked and is not is the shape this suite keeps finding.', () => {
    const specs = readdirSync(resolve(REPO_ROOT, 'apps/server/tests/e2e'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => typeof f === 'string' && f.endsWith('.spec.ts'));
    expect(specs.length, 'Playwright spec files found').toBeGreaterThanOrEqual(25);

    for (const rel of [
      'scripts/verify-suite.mjs',
      'apps/server/tests/unit/a-gate-that-does-not-name-its-blind-spot-reads-as-total.test.ts',
    ]) {
      const stated = /(\d+) spec files/.exec(read(rel));
      expect(stated, `${rel} no longer states a spec-file count`).not.toBeNull();
      expect(
        Number(stated?.[1] ?? -1),
        `${rel} says ${String(stated?.[1])} Playwright spec files; the tree has ${specs.length}`,
      ).toBe(specs.length);
    }
  });

  it('CRITICAL the reason the e2e suite needs no browser and no external server is pinned. V-1036 claimed it needed both and V-1037 disproved that by running it, so the claim now in this file rests on two facts about the config — no webServer, no browser project — and on the specs starting the app themselves. If any of those changes, the sentence above stops being true and this fails rather than the next person re-deriving it the hard way.', () => {
    const config = read('apps/server/playwright.config.ts');
    expect(config, 'the playwright config declares a webServer now').not.toMatch(/webServer\s*:/);
    expect(config, 'the playwright config declares browser projects now').not.toMatch(
      /projects\s*:|browserName\s*:/,
    );

    const helper = read('apps/server/tests/e2e/helpers/server.ts');
    expect(helper, 'the e2e helper no longer starts a server in-process').toMatch(
      /export async function startTestServer|export function startTestServer/,
    );

    const specs = readdirSync(resolve(REPO_ROOT, 'apps/server/tests/e2e'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => typeof f === 'string' && f.endsWith('.spec.ts'));
    const external = specs.filter((rel) => {
      const src = read(`apps/server/tests/e2e/${rel}`);
      return (
        /startTestServer/.test(src) === false && /request\.(get|post|put|patch|delete)\(/.test(src)
      );
    });
    expect(
      external.sort(),
      'these specs make requests without starting a server, so they depend on something already ' +
        'listening — the suite is no longer self-contained:',
    ).toEqual([]);
  });
});
