// A slower CI runner is one fact about the machine, not nine regressions in
// code that did not change.
//
// The 'Perf regression check (advisory)' job had failed on five consecutive
// main runs, including commits that touched none of the benchmarked code. In
// the last of them all nine benchmarks came back 54-70% slower than baseline
// TOGETHER — including a bare `node:crypto` sha256 digest, which lives in Node
// and cannot regress because of anything in this repo. The numbers in
// FAILING_CI_RUN_HZ below are that run, verbatim; BASELINE_HZ is the committed
// docs/benchmarks/baseline.ci.json it was compared against.
//
// A check that always fails is a check everybody learns to scroll past, so the
// real regression it exists to catch would have arrived invisible. These arms
// are about the CHECKER: the fixtures are synthetic apart from the one real
// run, so they keep meaning the same thing when the baseline is re-recorded.
//
// Every arm has its negative control, because the failure mode being fixed —
// a check that reports the same verdict no matter what it is shown — is
// exactly what a one-sided test cannot tell from a working check.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from '../../apps/server/tests/unit/_helpers/code-only.js';
import {
  baselineRecord,
  compare,
  currentHardware,
  flatten,
  formatReport,
  speedFactor,
  HARDWARE_BAND,
  MIN_SHARED,
} from '../check-bench-regression.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/check-bench-regression.mjs');
const REAL_BASELINE = resolve(REPO_ROOT, 'docs/benchmarks/baseline.ci.json');

const THRESHOLD = 0.5;

/** The nine benchmark keys, exactly as `flatten()` builds them. */
const KEYS = [
  'apps/server/tests/bench/auth-cache.bench.ts > sha256(plaintext) — cache key derivation :: createHash sha256 hex digest',
  'apps/server/tests/bench/auth-cache.bench.ts > InMemoryAuthCache — hot path :: get() — cache hit',
  'apps/server/tests/bench/auth-cache.bench.ts > InMemoryAuthCache — cold path :: miss → set → hit roundtrip',
  'apps/server/tests/bench/rate-limit.bench.ts > MemoryRateLimitStore.consume — happy path (bucket has tokens) :: consume(cost=1) when bucket has capacity',
  'apps/server/tests/bench/rate-limit.bench.ts > MemoryRateLimitStore.consume — refill + consume :: consume(cost=1) with refill math on existing bucket',
  'apps/server/tests/bench/rate-limit.bench.ts > MemoryRateLimitStore.consume — denied path (over budget) :: consume(cost=1) when bucket is empty (allowed=false)',
  'packages/sdk-typescript/tests/bench/webhook-signature.bench.ts > verifyWebhookSignature — small body (~70 bytes) :: valid signature, small body',
  'packages/sdk-typescript/tests/bench/webhook-signature.bench.ts > verifyWebhookSignature — small body (~70 bytes) :: invalid signature, small body (constant-time compare still runs)',
  'packages/sdk-typescript/tests/bench/webhook-signature.bench.ts > verifyWebhookSignature — large body (~10 KB) :: valid signature, large body',
];

/** docs/benchmarks/baseline.ci.json, verbatim. */
const BASELINE_HZ = [
  2278838.5233126148, 9353869.120737243, 1624187.6036982234, 1589599.997104036, 7337645.970648556,
  8531387.812310802, 53209.89022785315, 56118.97414514967, 35215.10321218051,
];

/** The run that failed CI on 2026-09-20 — 54-70% down, all nine together. */
const FAILING_CI_RUN_HZ = [855000, 3268000, 669000, 737000, 3032000, 3011000, 16000, 19000, 15000];

type Bench = { key: string; hz: number; mean: number };

function benches(keys: readonly string[], hzs: readonly number[]): Bench[] {
  return keys.map((key, i) => ({ key, hz: hzs[i], mean: 1 / hzs[i] }));
}

const BASELINE = benches(KEYS, BASELINE_HZ);
const FAILING_RUN = benches(KEYS, FAILING_CI_RUN_HZ);

/** A tinybench `--outputJson` report, so `flatten()` is exercised for real. */
function tinybenchReport(list: readonly Bench[]) {
  const byFile = new Map<string, Map<string, { name: string; hz: number; mean: number }[]>>();
  for (const b of list) {
    const [fullName, name] = b.key.split(' :: ');
    const filepath = fullName.split(' > ')[0];
    const groups = byFile.get(filepath) ?? new Map();
    byFile.set(filepath, groups);
    groups.set(fullName, [...(groups.get(fullName) ?? []), { name, hz: b.hz, mean: b.mean }]);
  }
  return {
    files: [...byFile].map(([filepath, groups]) => ({
      filepath,
      groups: [...groups].map(([fullName, benchmarks]) => ({ fullName, benchmarks })),
    })),
  };
}

function report(current: readonly Bench[], baseline: readonly Bench[] = BASELINE) {
  const speed = speedFactor(current, baseline);
  const { rows, regressed, missing } = compare(current, baseline, {
    threshold: THRESHOLD,
    factor: speed.factor,
  });
  const text = formatReport({ rows, regressed, speed, threshold: THRESHOLD, missing }).join('\n');
  return { speed, rows, regressed, missing, text };
}

/** Flagged means tripped the threshold — never merely "not ok": a row the check
 *  could not compare at all must not be able to pass for a caught regression. */
function flagged(rows: { key: string; status: string }[]): string[] {
  return rows.filter((r) => r.status === '⚠ REGRESSED').map((r) => r.key);
}

describe('the perf check compares each benchmark against the run’s own speed', () => {
  it('nine benchmarks all ~60% slower together flag nothing, and the run is reported as about 2.7x slower than the hardware the baseline came from', () => {
    const { speed, rows, regressed, text } = report(FAILING_RUN);

    // Every raw number is far past the 50% threshold: this is the run that
    // failed CI five times in a row.
    for (const row of rows) expect(Number(row.slowdownPct)).toBeGreaterThan(50);

    expect(regressed).toBe(0);
    expect(flagged(rows)).toEqual([]);
    expect(speed.normalised).toBe(true);
    expect(speed.shared).toBe(9);
    expect(speed.factor).toBeCloseTo(0.375, 3);

    // (a) the factor is always printed.
    expect(text).toContain('Run speed factor: 0.375x');
    expect(text).toContain('median of (current hz / baseline hz) over 9 shared benchmark(s)');
    // (b) and the run is outside the band, so the notice is loud and specific.
    expect(text).toContain('about 2.7x SLOWER');
    expect(text).toContain('⚠ DIFFERENT HARDWARE');
    expect(text).toContain("than the baseline's hardware");
    expect(text).toContain('PERF_REGRESSION_RECORD_NEW=1 npm run bench:check-regression');
    // The raw numbers survive into the output alongside the normalised ones.
    expect(text).toContain('raw 62.5% slower');
    expect(text).toContain('All benchmarks within threshold.');
  });

  it('NEGATIVE CONTROL: a run inside the hardware band prints the factor but no different-hardware notice', () => {
    const { speed, text } = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz) => hz * 0.9),
      ),
    );

    expect(speed.factor).toBeCloseTo(0.9, 6);
    expect(text).toContain('Run speed factor: 0.900x');
    expect(text).not.toContain('⚠ DIFFERENT HARDWARE');
    expect(text).toContain('All benchmarks within threshold.');
  });

  it('the same slow run with ONE benchmark a further 60% slower than the rest flags exactly that one', () => {
    const degraded = [...FAILING_CI_RUN_HZ];
    degraded[6] = FAILING_CI_RUN_HZ[6] * 0.4;
    const { speed, rows, regressed, text } = report(benches(KEYS, degraded));

    // The median is the estimator precisely so the one regression cannot drag
    // the factor toward itself: it is unchanged from the clean run above.
    expect(speed.factor).toBeCloseTo(0.375, 3);
    expect(regressed).toBe(1);
    expect(flagged(rows)).toEqual([KEYS[6]]);
    expect(rows[6].status).toBe('⚠ REGRESSED');
    expect(Number(rows[6].normalisedSlowdownPct)).toBeCloseTo(67.9, 0);
    expect(text).toContain('1 benchmark(s) regressed beyond the 50% threshold');
    // NEGATIVE CONTROL, in the same breath: the other eight are untouched by
    // their neighbour's regression.
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(8);
  });

  it('a faster runner does not hide a real regression that the raw comparison would miss entirely', () => {
    // Eight benchmarks 2.5x faster than baseline, one 20% SLOWER. Raw, that one
    // is 20% down — nowhere near the 50% threshold, so the old check said "ok".
    const hzs = BASELINE_HZ.map((hz, i) => (i === 3 ? hz * 0.8 : hz * 2.5));
    const { speed, rows, regressed, text } = report(benches(KEYS, hzs));

    expect(speed.factor).toBeCloseTo(2.5, 6);
    expect(Number(rows[3].slowdownPct)).toBeCloseTo(20, 0);
    expect(regressed).toBe(1);
    expect(flagged(rows)).toEqual([KEYS[3]]);
    expect(Number(rows[3].normalisedSlowdownPct)).toBeCloseTo(68, 0);
    expect(text).toContain('about 2.5x FASTER');
    expect(text).toContain('⚠ DIFFERENT HARDWARE');
    // A negative slowdown reads as "faster", never as "-150.0% slower".
    expect(text).toContain('raw 150.0% faster');
    expect(text).not.toMatch(/-\d+\.\d% (slower|faster)/);
  });

  it('NEGATIVE CONTROL: on that same fast runner, a benchmark that kept pace is not flagged', () => {
    const { rows, regressed } = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz) => hz * 2.5),
      ),
    );
    expect(regressed).toBe(0);
    expect(flagged(rows)).toEqual([]);
  });
});

describe('the perf check is honest about what it cannot see', () => {
  it('states the blind spot in the output: a regression that hit most benchmarks together reads as a slow runner', () => {
    const { text } = report(FAILING_RUN);
    expect(text).toContain('Blind spot:');
    expect(text).toContain('a real regression that hit most benchmarks together reads as a slow');
    expect(text).toContain('The raw percentages below are the only thing that shows it.');
  });

  it('the normalisation is in the CODE, not only described in the header comment', () => {
    // Read as code: a guard that searched raw source could be satisfied by a
    // header paragraph promising normalisation over a body that never does it.
    const source = readFileSync(SCRIPT, 'utf8');
    const code = codeOnly(source);

    expect(code).toContain('const normalisedHz = cur.hz / factor;');
    expect(code).toContain('const normalisedSlowdown = (base.hz - normalisedHz) / base.hz;');
    expect(code).toContain("const flag = normalisedSlowdown >= threshold ? '⚠ REGRESSED' : 'ok';");

    // NEGATIVE CONTROL for the stripper itself: the header prose is gone from
    // what was searched, and present in the file — so the three assertions
    // above could not have been satisfied by a comment. The obligation that
    // the header CARRIES that prose is pinned separately, by
    // apps/server/tests/unit/scripts-check-bench-regression-content-parity.test.ts.
    expect(code).not.toContain('WHAT MEDIAN-NORMALISATION CANNOT SEE');
    expect(source).toContain('⚠ WHAT MEDIAN-NORMALISATION CANNOT SEE');
  });

  it(`refuses to normalise on fewer than ${String(MIN_SHARED)} shared benchmarks, compares RAW, and says so`, () => {
    const two = benches(KEYS.slice(0, 2), [BASELINE_HZ[0] * 0.4, BASELINE_HZ[1] * 0.4]);
    const { speed, rows, regressed, text } = report(two);

    expect(speed.normalised).toBe(false);
    expect(speed.shared).toBe(2);
    expect(speed.factor).toBe(1);
    expect(text).toContain('Run speed factor: 1.000x (NOT normalised)');
    expect(text).toContain('only 2 benchmark(s) usable in both runs (need 3)');
    expect(text).toContain('REFUSING to normalise; the numbers below are RAW');
    // The header measures against baseline, not against "the rest of this run":
    // nothing was divided out, so claiming otherwise would be a lie.
    expect(text).toContain('threshold: 50% slower than baseline');
    expect(text).not.toContain('slower than the rest of this run');
    // NEGATIVE CONTROL for the blind-spot paragraph: it describes what
    // NORMALISATION cannot see, and this run did not normalise, so it is absent
    // here and present on the normalised run above.
    expect(text).not.toContain('Blind spot:');
    // Raw comparison means the 60% slowdown IS flagged, both of them.
    expect(regressed).toBe(2);
    expect(flagged(rows)).toEqual([KEYS[0], KEYS[1]]);
  });

  it(`NEGATIVE CONTROL: exactly ${String(MIN_SHARED)} shared benchmarks normalise, and the refusal is not printed`, () => {
    const three = benches(
      KEYS.slice(0, 3),
      BASELINE_HZ.slice(0, 3).map((hz) => hz * 0.4),
    );
    const { speed, regressed, text } = report(three);

    expect(speed.normalised).toBe(true);
    expect(speed.factor).toBeCloseTo(0.4, 6);
    expect(text).not.toContain('REFUSING to normalise');
    expect(text).toContain('threshold: 50% slower than the rest of this run');
    expect(text).toContain('Blind spot:');
    expect(regressed).toBe(0);
  });

  it(`the hardware band is ${String(HARDWARE_BAND)}x in both directions, and the notice names the re-record command`, () => {
    const slow = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz) => hz / 2.2),
      ),
    ).text;
    const fast = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz) => hz * 2.2),
      ),
    ).text;
    const inside = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz) => hz * 1.9),
      ),
    ).text;

    expect(slow).toContain('⚠ DIFFERENT HARDWARE');
    expect(fast).toContain('⚠ DIFFERENT HARDWARE');
    expect(inside).not.toContain('⚠ DIFFERENT HARDWARE');
    for (const text of [slow, fast]) {
      expect(text).toContain('Re-record the baseline on THIS runner class and commit it');
      expect(text).toContain('PERF_REGRESSION_RECORD_NEW=1 npm run bench:check-regression');
    }
  });
});

describe('a benchmark with no baseline entry', () => {
  const NEW_KEY =
    'apps/server/tests/bench/auth-cache.bench.ts > brand new group :: brand new bench';

  it('is reported as new and never flagged, however slow it is', () => {
    const current = [...FAILING_RUN, { key: NEW_KEY, hz: 1, mean: 1 }];
    const { speed, rows, regressed, text } = report(current);

    const row = rows.find((r) => r.key === NEW_KEY);
    expect(row?.status).toBe('new');
    expect(regressed).toBe(0);
    expect(flagged(rows)).toEqual([]);
    expect(text).toContain('[new]');
    expect(text).toContain('(no baseline entry)');
    // It also does not vote on how fast the machine was — there is nothing to
    // compare it to, so a 1 hz newcomer cannot drag the factor to the floor.
    expect(speed.shared).toBe(9);
    expect(speed.factor).toBeCloseTo(0.375, 3);
  });

  it('NEGATIVE CONTROL: the same benchmark WITH a baseline entry is compared, not waved through as new', () => {
    const current = [...FAILING_RUN, { key: NEW_KEY, hz: 1, mean: 1 }];
    const baseline = [...BASELINE, { key: NEW_KEY, hz: 1000, mean: 0.001 }];
    const { rows, regressed } = report(current, baseline);

    const row = rows.find((r) => r.key === NEW_KEY);
    expect(row?.status).toBe('⚠ REGRESSED');
    expect(regressed).toBe(1);
  });
});

describe('a benchmark the run did not measure is not a benchmark that passed', () => {
  it('a baseline benchmark absent from the results is reported [missing], and the summary stops claiming ALL benchmarks were within threshold', () => {
    const { regressed, missing, text } = report(FAILING_RUN.slice(0, 8));

    expect(regressed).toBe(0);
    expect(missing).toEqual([KEYS[8]]);
    expect(text).toContain('[missing]');
    expect(text).toContain('in the baseline, absent from this run — NOT compared.');
    expect(text).toContain('did not appear in this run and were NOT checked');
    expect(text).toContain('All COMPARED benchmarks within threshold.');
    // The unqualified sentence is the one a reader trusts, so it has to go.
    expect(text).not.toContain('All benchmarks within threshold.');
  });

  it('NEGATIVE CONTROL: with every baseline benchmark present nothing is reported missing and the summary is the unqualified one', () => {
    const { missing, text } = report(FAILING_RUN);

    expect(missing).toEqual([]);
    expect(text).not.toContain('[missing]');
    expect(text).not.toContain('NOT checked');
    expect(text).toContain('All benchmarks within threshold.');
  });

  it('a rate that is not a finite number on either side is reported [unmeasured], because NaN >= threshold is false and would otherwise print as ok', () => {
    const notANumber = [...FAILING_RUN];
    notANumber[0] = { ...notANumber[0], hz: Number.NaN, mean: 0 };
    const { rows, regressed, text } = report(notANumber);

    expect(rows[0].status).toBe('unmeasured');
    expect(flagged(rows)).toEqual([]);
    expect(regressed).toBe(0);
    expect(text).toContain('[unmeasured]');
    expect(text).toContain('NOT compared.');
    expect(text).toContain('non-finite or non-positive rate on one side and were NOT checked');
    expect(text).toContain('All COMPARED benchmarks within threshold.');

    // The other side of the division: a baseline entry of 0 hz makes the raw
    // slowdown -Infinity, which is just as unanswerable.
    const zeroBaseline = [...BASELINE];
    zeroBaseline[0] = { ...zeroBaseline[0], hz: 0, mean: 0 };
    expect(report(FAILING_RUN, zeroBaseline).rows[0].status).toBe('unmeasured');
  });

  it('NEGATIVE CONTROL: a CURRENT rate of exactly 0 is a real measurement — a benchmark that completed nothing — and is flagged as a 100% slowdown, not filed as unmeasured', () => {
    const stopped = [...FAILING_RUN];
    stopped[0] = { ...stopped[0], hz: 0, mean: 0 };
    const { rows, regressed } = report(stopped);

    expect(rows[0].status).toBe('⚠ REGRESSED');
    expect(Number(rows[0].slowdownPct)).toBe(100);
    expect(regressed).toBe(1);
  });
});

describe('the half boundary that decides whether a shared regression is seen', () => {
  it('one whole bench FILE regressing together is still caught, because the factor is a single GLOBAL median and not a median per file', () => {
    // The three webhook-signature benchmarks, and only those, 60% slower —
    // our own change, in our own code, hitting one file's whole group.
    const hzs = BASELINE_HZ.map((hz, i) => (i >= 6 ? hz * 0.4 : hz));
    const { speed, rows, regressed } = report(benches(KEYS, hzs));

    expect(speed.factor).toBe(1);
    expect(regressed).toBe(3);
    expect(flagged(rows)).toEqual([KEYS[6], KEYS[7], KEYS[8]]);

    // NEGATIVE CONTROL, and the reason for the design: normalise those same
    // three against ONLY each other — what a per-file factor would do — and
    // every one of them reads as 0% slower and nothing is flagged. A factor
    // drawn from a group swallows whatever regression that group shares, so
    // the smaller the group, the blinder the check.
    const perFile = report(benches(KEYS.slice(6), hzs.slice(6)), BASELINE.slice(6));
    expect(perFile.speed.normalised).toBe(true);
    expect(perFile.speed.factor).toBeCloseTo(0.4, 6);
    expect(perFile.regressed).toBe(0);
    expect(flagged(perFile.rows)).toEqual([]);
  });

  it('four of nine moving together are each flagged, five of nine are absorbed, and the output states that boundary in this run’s own numbers', () => {
    const four = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz, i) => (i < 4 ? hz * 0.4 : hz)),
      ),
    );
    expect(four.speed.factor).toBe(1);
    expect(four.regressed).toBe(4);

    // NEGATIVE CONTROL for the same mechanism one benchmark further on: the
    // median now sits ON a regressed benchmark, and the check goes quiet. This
    // is the documented blind spot, asserted rather than asserted-about.
    const five = report(
      benches(
        KEYS,
        BASELINE_HZ.map((hz, i) => (i < 5 ? hz * 0.4 : hz)),
      ),
    );
    expect(five.speed.factor).toBeCloseTo(0.4, 6);
    expect(five.regressed).toBe(0);
    // ...and the raw percentages, which normalisation never touches, are still
    // the witness that something moved.
    expect(five.text).toContain('raw 60.0% slower');
    expect(five.text).toContain(
      'The boundary is half: with 9 shared benchmark(s), 5 have to move together',
    );
  });
});

describe('re-recording the baseline', () => {
  it('records the hardware the numbers belong to, not just the numbers', () => {
    const record = baselineRecord(FAILING_RUN, currentHardware());

    expect(record.recordedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.node).toBe(process.version);
    expect(record.os).toBeTruthy();
    expect(record.arch).toBeTruthy();
    expect(record.cpu).toBeTruthy();
    expect(record.benchmarks).toHaveLength(9);
    expect(record.benchmarks[0]).toEqual({
      key: KEYS[0],
      hz: FAILING_CI_RUN_HZ[0],
      mean: 1 / FAILING_CI_RUN_HZ[0],
    });
    expect(record.note).toContain('PERF_REGRESSION_RECORD_NEW=1');
  });

  it('PERF_REGRESSION_RECORD_NEW=1 writes that record and exits 0 without comparing anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-record-'));
    const resultsPath = join(dir, 'bench-results.json');
    const baselinePath = join(dir, 'baseline.ci.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN)));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '1',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: baselinePath,
      },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('recorded 9 benchmark(s) as the new baseline');
    expect(run.stdout).not.toContain('Performance regression check');

    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(written.node).toBe(process.version);
    expect(typeof written.os).toBe('string');
    expect(typeof written.arch).toBe('string');
    expect(typeof written.cpu).toBe('string');
    expect(written.benchmarks).toHaveLength(9);
  });

  it('NEGATIVE CONTROL: without the env var the same invocation compares and leaves the baseline untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-record-'));
    const resultsPath = join(dir, 'bench-results.json');
    const baselinePath = join(dir, 'baseline.ci.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN)));
    writeFileSync(baselinePath, readFileSync(REAL_BASELINE, 'utf8'));
    const before = readFileSync(baselinePath, 'utf8');
    const beforeMtime = statSync(baselinePath).mtimeMs;

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: baselinePath,
      },
    });

    expect(run.stdout).toContain('Performance regression check');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
    expect(statSync(baselinePath).mtimeMs).toBe(beforeMtime);
  });
});

describe('the script end to end', () => {
  it('exits 0 on the real run that failed CI five times, against the committed baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
    const resultsPath = join(dir, 'bench-results.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN)));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: REAL_BASELINE,
      },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Run speed factor: 0.375x');
    expect(run.stdout).toContain('about 2.7x SLOWER');
    expect(run.stdout).toContain('⚠ DIFFERENT HARDWARE');
    expect(run.stdout).toContain('All benchmarks within threshold.');
  });

  it('NEGATIVE CONTROL: exits 1 when one benchmark of that same run slowed down relative to the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
    const resultsPath = join(dir, 'bench-results.json');
    const degraded = [...FAILING_CI_RUN_HZ];
    degraded[6] = FAILING_CI_RUN_HZ[6] * 0.4;
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(benches(KEYS, degraded))));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: REAL_BASELINE,
      },
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('⚠ REGRESSED');
    expect(run.stdout).toContain('1 benchmark(s) regressed beyond the 50% threshold');
  });

  it('still exits 0 when a baseline benchmark is absent from the run — the missing one is named in the output, not folded into the exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-missing-'));
    const resultsPath = join(dir, 'bench-results.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN.slice(0, 8))));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: REAL_BASELINE,
      },
    });

    // A rename legitimately produces one [missing] and one [new], so this must
    // not fail the build; the whole signal is that the line is printed.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[missing]');
    expect(run.stdout).toContain('did not appear in this run and were NOT checked');
    expect(run.stdout).toContain('All COMPARED benchmarks within threshold.');
  });

  it('exits 2 and bootstraps a baseline when there is none, which is the third exit code the advisory CI job swallows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-bootstrap-'));
    const resultsPath = join(dir, 'bench-results.json');
    const baselinePath = join(dir, 'does-not-exist-yet.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN)));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: baselinePath,
      },
    });

    expect(run.status).toBe(2);
    expect(run.stdout).toContain('Recording the current run as the new baseline');
    // The bootstrap path writes the same hardware-stamped record as the
    // explicit re-record, so a baseline created by accident still says which
    // machine it came from. NEGATIVE CONTROL for the exit code itself: the two
    // arms above, same script and same results, exit 0 against a baseline that
    // exists.
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(written.node).toBe(process.version);
    expect(written.benchmarks).toHaveLength(9);
  });

  it('importing the module does not run the check — main() is guarded', () => {
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)});`],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('Performance regression check');
    expect(run.stdout.trim()).toBe('');
  });

  it('NEGATIVE CONTROL: running the same file as a script DOES run the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-guard-'));
    const resultsPath = join(dir, 'bench-results.json');
    writeFileSync(resultsPath, JSON.stringify(tinybenchReport(FAILING_RUN)));

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERF_REGRESSION_RECORD_NEW: '',
        PERF_REGRESSION_RESULTS_PATH: resultsPath,
        PERF_REGRESSION_BASELINE_PATH: REAL_BASELINE,
      },
    });

    expect(run.stdout).toContain('Performance regression check');
  });
});

describe('flatten', () => {
  it('builds the `group.fullName :: bench.name` key the baseline is looked up by', () => {
    expect(
      flatten(tinybenchReport(FAILING_RUN))
        .map((b: { key: string }) => b.key)
        .sort(),
    ).toEqual([...KEYS].sort());
  });

  it('NEGATIVE CONTROL: an empty report flattens to nothing rather than throwing', () => {
    expect(flatten({})).toEqual([]);
    expect(flatten({ files: [{ filepath: 'x', groups: [] }] })).toEqual([]);
  });
});

describe('speedFactor', () => {
  it('is the MEDIAN, so one regression in the set cannot drag the factor toward itself', () => {
    // Eight benchmarks at exactly baseline speed, one at a tenth. A MEAN factor
    // would land at 0.9, quietly forgiving 10% of everything; the median is 1.0
    // and the outlier stays visible.
    const hzs = BASELINE_HZ.map((hz, i) => (i === 0 ? hz * 0.1 : hz));
    const { speed, rows } = report(benches(KEYS, hzs));

    expect(speed.factor).toBe(1);
    expect(flagged(rows)).toEqual([KEYS[0]]);
  });

  it('NEGATIVE CONTROL: a benchmark with an unusable hz does not vote on the factor', () => {
    const current = benches(
      KEYS,
      BASELINE_HZ.map((hz) => hz * 0.5),
    );
    current[0].hz = 0;
    const { speed } = report(current);

    expect(speed.shared).toBe(8);
    expect(speed.factor).toBeCloseTo(0.5, 6);
  });
});
