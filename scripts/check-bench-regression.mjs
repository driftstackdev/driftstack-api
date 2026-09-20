#!/usr/bin/env node
// V-165 — perf regression checker.
//
// Compares the latest tinybench output (tmp/bench-results.json,
// produced by `npm run bench:json`) against a checked-in baseline
// (docs/benchmarks/baseline.ci.json) recorded on the CI runner.
// Prints a per-benchmark regression summary.
//
// ── Each benchmark is compared against THE RUN'S OWN SPEED ────────
//
// 2026-09-20: this check had failed on five consecutive main runs,
// including commits that touched none of the benchmarked code. In the
// last of them all 9 benchmarks were 54-70% slower than baseline
// TOGETHER — including a bare `node:crypto` sha256 digest, which is
// not our code and cannot regress because of anything in this repo.
// Nine simultaneous regressions in code that did not change is not
// nine regressions; it is a slower runner. A check that always fails
// teaches everyone to ignore it, and a real regression then arrives
// invisible.
//
// So the run gets a SPEED FACTOR: the MEDIAN of (current hz /
// baseline hz) over the benchmarks present in both runs. Each
// benchmark is then compared as (current hz / factor) against its
// baseline, at the same threshold. A uniformly slow (or fast) runner
// moves every ratio together, the median moves with them, and nothing
// is flagged. One benchmark that slowed down RELATIVE TO THE REST
// still stands out. The estimator is the median and not the mean
// precisely so that the one genuine regression in the set cannot drag
// the factor toward itself and hide. The raw numbers are printed
// alongside the normalised ones: normalisation changes what is
// FLAGGED, never what is reported.
//
// ⚠ WHAT MEDIAN-NORMALISATION CANNOT SEE
//   A real regression that hit HALF OR MORE of the benchmarks
//   together. A Node upgrade, a dependency that slowed every hash, a
//   change to a hot path they all share — the median moves with them,
//   and this check reads it as a slow runner and says nothing. It
//   answers "did anything get slower than the rest of this run", NOT
//   "did anything get slower than it used to be". The raw percentages
//   are the only thing in the output that answers the second
//   question, which is why they are always printed, and why the
//   factor itself is always printed: a factor far from 1.0 is either
//   different hardware or exactly this blind spot, and nothing here
//   can tell you which. A human reading a factor of 0.37 has to ask
//   both questions.
//
//   The boundary is exactly half, not "most" — measured, with the
//   default 50% threshold and k of n benchmarks 60% slower:
//     k <  n/2        the median sits on an unaffected benchmark, the
//                     factor does not move, and all k are flagged
//                     (4 of 9 → 4 flagged).
//     k == n/2 (even) the median averages one affected and one
//                     unaffected ratio and lands halfway: 4 of 8 at
//                     60% normalises to 42.9%, under the threshold,
//                     and NOTHING is flagged.
//     k >  n/2        the median sits on an affected benchmark, the
//                     regression normalises to 0% and the healthy
//                     ones read as faster (5 of 9 → nothing flagged).
//   With the repo's nine benchmarks, five have to move together
//   before the check goes quiet.
//
//   That boundary is also why the factor is ONE GLOBAL MEDIAN and not
//   a median per bench file. Per file, the three
//   webhook-signature.bench.ts benchmarks would be normalised against
//   each other: our own change slowing all three by 60% is k == n for
//   that file, the per-file factor becomes 0.4, and all three read as
//   0% slower — a real regression, ours, erased. The same three
//   inside the global nine are k = 3 of 9, the global median does not
//   move, and all three are flagged at 60%. Per-file factors make
//   this check blind to exactly the regressions it exists to catch;
//   the smaller the group a factor is drawn from, the more of a
//   shared regression it swallows.
//
//   The other direction — crying wolf. Normalisation assumes the
//   machine moves every benchmark by roughly the same ratio. It does
//   not, quite: in the 2026-09-20 CI run the nine ratios spanned
//   0.301 to 0.464 around a median of 0.375, so the slowest benchmark
//   normalised to 19.9% slower and the fastest to 23.6% faster on a
//   run where no code had changed. That is ~2.5x of headroom under
//   the 50% threshold, but it is ONE observation of ONE pair of
//   machines: a runner class whose relative profile differs more (a
//   different crypto implementation, a smaller cache against the
//   10 KB body benchmark) can flag a benchmark with no code change
//   behind it. Re-recording the baseline on the runner class being
//   compared is what shrinks that spread; the notice below asks for
//   it by name.
//
//   NOT MEASURED IS NOT PASSED. A benchmark in the baseline that did
//   not appear in the run at all, and a pair whose hz is non-finite
//   on either side, are REPORTED as [missing] / [unmeasured] and are
//   never silently folded into "all benchmarks within threshold".
//   They do not change the exit code — a rename legitimately makes
//   one benchmark [missing] and one [new] — so the line that says
//   nothing was compared is the whole signal, and it is printed last.
//
//   HARDWARE_BAND (2x) is where that ambiguity gets loud. Outside
//   [0.5, 2.0] the run is more than 2x slower or faster than the
//   machine the baseline was recorded on; the comparison is across
//   hardware classes, every raw percentage is mostly a machine
//   difference, and the output says so loudly and names the command
//   to re-record (PERF_REGRESSION_RECORD_NEW, below).
//
//   MIN_SHARED (3) benchmarks are the minimum for a median worth
//   trusting. Below that the script REFUSES to normalise, compares
//   the RAW numbers, and says so in the output rather than quietly
//   dividing by a factor drawn from one or two samples.
//
// Exit codes:
//   0 — no regressions exceed the threshold.
//   1 — at least one regression exceeds the threshold (advisory mode
//       can `continue-on-error: true` to swallow this).
//   2 — bootstrap mode: baseline file missing. Records the current
//       results as the new baseline (call sites must commit the file).
//
// ENV:
//   PERF_REGRESSION_THRESHOLD — fractional slowdown to flag.
//                               Default 0.50 (i.e. 50% slower than
//                               baseline triggers a fail).
//   PERF_REGRESSION_RESULTS_PATH — override input path. Default
//                                  tmp/bench-results.json.
//   PERF_REGRESSION_BASELINE_PATH — override baseline path. Default
//                                   docs/benchmarks/baseline.ci.json.
//   PERF_REGRESSION_RECORD_NEW — set to 1 to REPLACE the baseline
//                                with the current results and exit 0,
//                                comparing nothing. The record carries
//                                recordedAtIso, the node version and
//                                os/arch/cpu, so the hardware the
//                                numbers belong to is part of the
//                                record and a later run can say when
//                                it is comparing across machines.
//                                Run it on the runner class the
//                                baseline should describe, then commit
//                                docs/benchmarks/baseline.ci.json:
//
//                                  npm run bench:json
//                                  PERF_REGRESSION_RECORD_NEW=1 \
//                                    npm run bench:check-regression
//
// Why advisory and not gate-by-default:
//   docs/benchmarks/{auth-path,rate-limit,webhook-signature}.md note
//   that bench results on shared CI runners are too noisy for hard
//   gates. This script lands the infrastructure; flipping to a hard
//   gate is a separate decision for the owner (V-NNN follow-on with
//   sustained low-noise CI runs as evidence).
//
// main() is guarded at the bottom of the file, the way
// scripts/bump-gui-version.mjs does it, so the pure parts — flatten,
// speedFactor, compare, formatReport, baselineRecord — import without
// running the check. They are covered by
// scripts/tests/a-uniformly-slower-runner-is-not-nine-regressions.test.ts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, cpus, platform, release } from 'node:os';

const RESULTS_PATH = process.env.PERF_REGRESSION_RESULTS_PATH ?? 'tmp/bench-results.json';
const BASELINE_PATH =
  process.env.PERF_REGRESSION_BASELINE_PATH ?? 'docs/benchmarks/baseline.ci.json';
const THRESHOLD = Number(process.env.PERF_REGRESSION_THRESHOLD ?? '0.50');
const RECORD_NEW = process.env.PERF_REGRESSION_RECORD_NEW === '1';

/** Fewer benchmarks in both runs than this and a median is not worth trusting. */
export const MIN_SHARED = 3;

/** Outside [1/HARDWARE_BAND, HARDWARE_BAND] the run is a different hardware class. */
export const HARDWARE_BAND = 2;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

export function flatten(report) {
  const out = [];
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const bench of group.benchmarks ?? []) {
        out.push({
          key: `${group.fullName} :: ${bench.name}`,
          hz: bench.hz,
          mean: bench.mean,
        });
      }
    }
  }
  return out;
}

/**
 * How fast this RUN was, relative to the run the baseline came from: the MEDIAN
 * of (current hz / baseline hz) over the benchmarks present in both.
 *
 * Returns `{ factor, shared, ratios, normalised, reason }`. When fewer than
 * MIN_SHARED benchmarks can produce a ratio, `normalised` is false, `factor` is
 * exactly 1 — so every caller downstream keeps working and compares RAW — and
 * `reason` carries the sentence the output prints.
 *
 * A benchmark whose hz is missing, zero or non-finite on either side yields no
 * ratio. It cannot: dividing by zero gives Infinity and treating it as 1.0
 * would pull the median toward "same speed" on exactly the runs whose input is
 * broken. Such a benchmark is still COMPARED below — it just does not vote on
 * how fast the machine was.
 */
export function speedFactor(current, baseline) {
  const baselineMap = new Map(baseline.map((b) => [b.key, b]));
  const ratios = [];
  for (const cur of current) {
    const base = baselineMap.get(cur.key);
    if (base === undefined) continue;
    if (!Number.isFinite(cur.hz) || !Number.isFinite(base.hz)) continue;
    if (cur.hz <= 0 || base.hz <= 0) continue;
    ratios.push(cur.hz / base.hz);
  }
  ratios.sort((a, b) => a - b);
  const shared = ratios.length;
  if (shared < MIN_SHARED) {
    return {
      factor: 1,
      shared,
      ratios,
      normalised: false,
      reason: `only ${String(shared)} benchmark(s) usable in both runs (need ${String(MIN_SHARED)}) — REFUSING to normalise; the numbers below are RAW`,
    };
  }
  const mid = Math.floor(shared / 2);
  const factor = shared % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { factor, shared, ratios, normalised: true, reason: null };
}

/**
 * Per-benchmark comparison. `factor` is the run's speed factor (1 = compare
 * raw). Both the raw and the normalised slowdown are reported for every
 * benchmark; only the normalised one is measured against the threshold.
 *
 * Returns `{ rows, regressed, missing }`. `missing` is the baseline keys that
 * did not appear in this run at all: they produce no row because there is no
 * measurement to put in one, and leaving them out of the report entirely would
 * make a benchmark that STOPPED RUNNING indistinguishable from one that passed.
 * `missing` and the `unmeasured` rows are reported, never flagged — see the
 * header's NOT MEASURED IS NOT PASSED.
 */
export function compare(current, baseline, { threshold = THRESHOLD, factor = 1 } = {}) {
  const baselineMap = new Map(baseline.map((b) => [b.key, b]));
  const seen = new Set();
  const rows = [];
  let regressed = 0;
  for (const cur of current) {
    seen.add(cur.key);
    const base = baselineMap.get(cur.key);
    if (!base) {
      // New benchmark: there is nothing to have regressed FROM, so it is
      // reported and never flagged. It votes on no factor either.
      rows.push({ key: cur.key, status: 'new', hz: cur.hz });
      continue;
    }
    if (!Number.isFinite(cur.hz) || !Number.isFinite(base.hz) || base.hz <= 0) {
      // A pair that cannot produce a ratio: hz missing, NaN or Infinity on
      // either side, or a baseline rate of zero. (base.hz - cur.hz)/base.hz
      // would be NaN or -Infinity here, and NaN >= threshold is false, so the
      // arithmetic alone would render an unanswerable question as `ok` — the
      // check's own worst failure mode in miniature. A current hz of exactly 0
      // is NOT this case: it is a real measurement of a benchmark that
      // completed nothing, a 100% slowdown, and it is flagged as one.
      rows.push({ key: cur.key, status: 'unmeasured', baselineHz: base.hz, currentHz: cur.hz });
      continue;
    }
    // Slowdown: hz lower than baseline. ratio > 0 means slower.
    const slowdown = (base.hz - cur.hz) / base.hz;
    // The same thing with the run's own speed divided out. This is the number
    // the threshold applies to; `slowdown` is reported next to it, unchanged.
    const normalisedHz = cur.hz / factor;
    const normalisedSlowdown = (base.hz - normalisedHz) / base.hz;
    const flag = normalisedSlowdown >= threshold ? '⚠ REGRESSED' : 'ok';
    if (normalisedSlowdown >= threshold) regressed += 1;
    rows.push({
      key: cur.key,
      status: flag,
      baselineHz: base.hz,
      currentHz: cur.hz,
      normalisedHz,
      slowdown,
      normalisedSlowdown,
      slowdownPct: (slowdown * 100).toFixed(1),
      normalisedSlowdownPct: (normalisedSlowdown * 100).toFixed(1),
    });
  }
  const missing = [...new Set(baseline.map((b) => b.key))].filter((key) => !seen.has(key));
  return { rows, regressed, missing };
}

/** "6.4% faster" / "62.5% slower" — a signed slowdown read out loud. */
export function pctPhrase(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'unknown';
  return n < 0 ? `${Math.abs(n).toFixed(1)}% faster` : `${n.toFixed(1)}% slower`;
}

/** "about 2.7x SLOWER" / "about 1.4x FASTER" / "about the same speed". */
export function describeFactor(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return 'unknown speed';
  if (factor < 1) return `about ${(1 / factor).toFixed(1)}x SLOWER`;
  if (factor > 1) return `about ${factor.toFixed(1)}x FASTER`;
  return 'about the same speed';
}

/** True when the run is more than HARDWARE_BAND times slower or faster. */
export function outsideHardwareBand(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return false;
  return factor > HARDWARE_BAND || factor < 1 / HARDWARE_BAND;
}

/**
 * The whole printed report, as lines, so what the operator reads is testable
 * without running a benchmark. Always states the factor; states the
 * different-hardware notice and the refusal-to-normalise separately.
 */
export function formatReport({ rows, regressed, speed, threshold = THRESHOLD, missing = [] }) {
  const pct = (threshold * 100).toFixed(0);
  const unmeasured = rows.filter((r) => r.status === 'unmeasured');
  const notCompared = missing.length + unmeasured.length;
  // In raw mode nothing was divided out, so the threshold is measured against
  // the baseline itself. Saying "than the rest of this run" there would claim a
  // normalisation that the run just refused to do.
  const against = speed.normalised ? 'the rest of this run' : 'baseline';
  // In raw mode the two percentages are the same number (factor 1), so printing
  // both would dress one measurement up as two.
  const verdict = (r) =>
    speed.normalised
      ? `(raw ${pctPhrase(r.slowdownPct)}, ${pctPhrase(r.normalisedSlowdownPct)} than ${against})`
      : `(${pctPhrase(r.slowdownPct)} than ${against})`;
  const lines = [];
  lines.push('');
  lines.push(`Performance regression check (threshold: ${pct}% slower than ${against}):`);
  lines.push('');

  if (speed.normalised) {
    lines.push(
      `  Run speed factor: ${speed.factor.toFixed(3)}x — median of (current hz / baseline hz) over ${String(speed.shared)} shared benchmark(s).`,
    );
    // Stated as a measurement, not as a diagnosis: the factor says this run was
    // slower, it does not say the machine was. Asserting hardware here would
    // contradict the blind-spot paragraph a few lines below, which exists
    // because the script cannot tell the two apart.
    lines.push(
      `  This run was ${describeFactor(speed.factor)}, overall, compared with the run the baseline came from —`,
    );
    lines.push(
      '  either different hardware, or something that moved most benchmarks at once. Both look like this.',
    );
  } else {
    lines.push(
      `  Run speed factor: 1.000x (NOT normalised) — ${speed.reason ?? 'unknown reason'}.`,
    );
  }

  if (speed.normalised && outsideHardwareBand(speed.factor)) {
    lines.push('');
    lines.push('  ⚠ DIFFERENT HARDWARE — the baseline does not describe this runner.');
    lines.push(
      `    The run is ${describeFactor(speed.factor)} than the baseline's hardware, outside the`,
    );
    lines.push(
      `    ${String(HARDWARE_BAND)}x band, so the raw percentages below are mostly a machine difference and`,
    );
    lines.push('    not a code change. Re-record the baseline on THIS runner class and commit it:');
    lines.push('      npm run bench:json');
    lines.push('      PERF_REGRESSION_RECORD_NEW=1 npm run bench:check-regression');
  }

  if (speed.normalised) {
    lines.push('');
    lines.push('  Blind spot: normalisation compares each benchmark against the rest of THIS run,');
    lines.push('  so a real regression that hit most benchmarks together reads as a slow runner');
    lines.push('  and is not flagged. The raw percentages below are the only thing that shows it.');
    lines.push(
      `  The boundary is half: with ${String(speed.shared)} shared benchmark(s), ${String(Math.ceil(speed.shared / 2))} have to move together before this`,
    );
    lines.push('  check goes quiet. Fewer than that and each of them is still flagged.');
  }
  lines.push('');

  for (const r of rows) {
    if (r.status === 'new') {
      const hz = Number.isFinite(r.hz) ? Math.round(r.hz).toString() : 'unknown';
      lines.push(`  [new]      ${r.key}  hz=${hz} (no baseline entry)`);
    } else if (r.status === 'unmeasured') {
      lines.push(
        `  [unmeasured] ${r.key}  hz=${String(r.currentHz)} vs baseline hz=${String(r.baselineHz)} — NOT compared.`,
      );
    } else if (r.status === 'ok') {
      lines.push(
        `  [ok]       ${r.key}  ${(r.currentHz / 1000).toFixed(0)}k/s vs baseline ${(r.baselineHz / 1000).toFixed(0)}k/s ${verdict(r)}`,
      );
    } else {
      lines.push(
        `  ${r.status}  ${r.key}  ${(r.currentHz / 1000).toFixed(0)}k/s vs baseline ${(r.baselineHz / 1000).toFixed(0)}k/s ${verdict(r)}`,
      );
    }
  }

  for (const key of missing) {
    lines.push(`  [missing]  ${key}  in the baseline, absent from this run — NOT compared.`);
  }

  lines.push('');
  if (regressed > 0) {
    lines.push(
      `${String(regressed)} benchmark(s) regressed beyond the ${pct}% threshold, relative to ${against}.`,
    );
  } else if (notCompared > 0) {
    // Not "All benchmarks within threshold." — some of them were never put to
    // the threshold at all, and the summary line is where that would disappear.
    lines.push('All COMPARED benchmarks within threshold.');
  } else {
    lines.push('All benchmarks within threshold.');
  }
  if (missing.length > 0) {
    lines.push(
      `⚠ ${String(missing.length)} baseline benchmark(s) did not appear in this run and were NOT checked — renamed (look for [new] above), deleted, or they failed to run. A benchmark that stopped running is not a benchmark that passed.`,
    );
  }
  if (unmeasured.length > 0) {
    lines.push(
      `⚠ ${String(unmeasured.length)} benchmark(s) had a non-finite or non-positive rate on one side and were NOT checked.`,
    );
  }
  return lines;
}

/** The machine these numbers belong to, so the baseline can carry it. */
export function currentHardware() {
  const cores = cpus();
  return {
    recordedAtIso: new Date().toISOString(),
    node: process.version,
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpu: cores.length > 0 ? `${cores[0].model} x${String(cores.length)}` : 'unknown',
  };
}

/**
 * The baseline document. The hardware facts are part of the record, not a
 * comment about it: a baseline whose machine is unknown cannot tell a later run
 * whether it is comparing across hardware classes.
 */
export function baselineRecord(current, hardware) {
  return {
    recordedAtIso: hardware.recordedAtIso,
    node: hardware.node,
    os: hardware.os,
    arch: hardware.arch,
    cpu: hardware.cpu,
    note: 'Recorded by scripts/check-bench-regression.mjs. Re-record with `npm run bench:json && PERF_REGRESSION_RECORD_NEW=1 npm run bench:check-regression`, then commit this file. node/os/arch/cpu say which machine these numbers belong to; the checker prints a different-hardware notice when the run it is comparing against them is more than 2x slower or faster.',
    benchmarks: current.map((b) => ({ key: b.key, hz: b.hz, mean: b.mean })),
  };
}

async function writeBaseline(baselineAbs, current) {
  await mkdir(resolve(baselineAbs, '..'), { recursive: true });
  await writeFile(
    baselineAbs,
    `${JSON.stringify(baselineRecord(current, currentHardware()), null, 2)}\n`,
  );
}

export async function main() {
  const resultsAbs = resolve(process.cwd(), RESULTS_PATH);
  if (!existsSync(resultsAbs)) {
    fail(`Bench results not found at ${RESULTS_PATH}. Run \`npm run bench:json\` first.`);
  }
  const results = JSON.parse(await readFile(resultsAbs, 'utf-8'));
  const current = flatten(results);

  const baselineAbs = resolve(process.cwd(), BASELINE_PATH);

  if (RECORD_NEW) {
    await writeBaseline(baselineAbs, current);
    console.log(
      `PERF_REGRESSION_RECORD_NEW=1 — recorded ${String(current.length)} benchmark(s) as the new baseline at ${BASELINE_PATH}.`,
    );
    console.log('The record carries node/os/arch/cpu. Commit the file. Nothing was compared.');
    process.exit(0);
  }

  if (!existsSync(baselineAbs)) {
    console.log(`No baseline at ${BASELINE_PATH}. Recording the current run as the new baseline.`);
    console.log('Commit the baseline file + re-run on a subsequent CI invocation to compare.');
    await writeBaseline(baselineAbs, current);
    process.exit(2);
  }

  const baseline = JSON.parse(await readFile(baselineAbs, 'utf-8'));
  const speed = speedFactor(current, baseline.benchmarks);
  const { rows, regressed, missing } = compare(current, baseline.benchmarks, {
    threshold: THRESHOLD,
    factor: speed.factor,
  });

  for (const line of formatReport({ rows, regressed, speed, threshold: THRESHOLD, missing })) {
    console.log(line);
  }

  if (regressed > 0) process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
