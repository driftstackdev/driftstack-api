#!/usr/bin/env node
// V-165 — perf regression checker.
//
// Compares the latest tinybench output (tmp/bench-results.json,
// produced by `npm run bench:json`) against a checked-in baseline
// (docs/benchmarks/baseline.ci.json) recorded on the CI runner.
// Prints a per-benchmark regression summary.
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
//
// Why advisory and not gate-by-default:
//   docs/benchmarks/{auth-path,rate-limit,webhook-signature}.md note
//   that bench results on shared CI runners are too noisy for hard
//   gates. This script lands the infrastructure; flipping to a hard
//   gate is a separate founder decision (V-NNN follow-on with
//   sustained low-noise CI runs as evidence).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RESULTS_PATH = process.env.PERF_REGRESSION_RESULTS_PATH ?? 'tmp/bench-results.json';
const BASELINE_PATH =
  process.env.PERF_REGRESSION_BASELINE_PATH ?? 'docs/benchmarks/baseline.ci.json';
const THRESHOLD = Number(process.env.PERF_REGRESSION_THRESHOLD ?? '0.50');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function flatten(report) {
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

async function main() {
  const resultsAbs = resolve(process.cwd(), RESULTS_PATH);
  if (!existsSync(resultsAbs)) {
    fail(`Bench results not found at ${RESULTS_PATH}. Run \`npm run bench:json\` first.`);
  }
  const results = JSON.parse(await readFile(resultsAbs, 'utf-8'));
  const current = flatten(results);

  const baselineAbs = resolve(process.cwd(), BASELINE_PATH);
  if (!existsSync(baselineAbs)) {
    console.log(`No baseline at ${BASELINE_PATH}. Recording the current run as the new baseline.`);
    console.log('Commit the baseline file + re-run on a subsequent CI invocation to compare.');
    await mkdir(resolve(baselineAbs, '..'), { recursive: true });
    await writeFile(
      baselineAbs,
      JSON.stringify(
        {
          recordedAtIso: new Date().toISOString(),
          note: 'CI-runner-recorded baseline. Update via PERF_REGRESSION_RECORD_NEW=1 (TODO).',
          benchmarks: current.map((b) => ({ key: b.key, hz: b.hz, mean: b.mean })),
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const baseline = JSON.parse(await readFile(baselineAbs, 'utf-8'));
  const baselineMap = new Map(baseline.benchmarks.map((b) => [b.key, b]));

  const report = [];
  let regressed = 0;
  for (const cur of current) {
    const base = baselineMap.get(cur.key);
    if (!base) {
      report.push({ key: cur.key, status: 'new', hz: cur.hz });
      continue;
    }
    // Slowdown: hz lower than baseline. ratio > 0 means slower.
    const slowdown = (base.hz - cur.hz) / base.hz;
    const flag = slowdown >= THRESHOLD ? '⚠ REGRESSED' : 'ok';
    if (slowdown >= THRESHOLD) regressed += 1;
    report.push({
      key: cur.key,
      status: flag,
      baselineHz: base.hz,
      currentHz: cur.hz,
      slowdownPct: (slowdown * 100).toFixed(1),
    });
  }

  console.log(
    `\nPerformance regression check (threshold: ${(THRESHOLD * 100).toFixed(0)}% slower):\n`,
  );
  for (const r of report) {
    if (r.status === 'new') {
      console.log(`  [new]      ${r.key}  hz=${Math.round(r.hz).toString()}`);
    } else if (r.status === 'ok') {
      console.log(
        `  [ok]       ${r.key}  ${(r.currentHz / 1000).toFixed(0)}k/s vs baseline ${(r.baselineHz / 1000).toFixed(0)}k/s (${r.slowdownPct}%)`,
      );
    } else {
      console.log(
        `  ${r.status}  ${r.key}  ${(r.currentHz / 1000).toFixed(0)}k/s vs baseline ${(r.baselineHz / 1000).toFixed(0)}k/s (${r.slowdownPct}% slower)`,
      );
    }
  }

  if (regressed > 0) {
    console.error(
      `\n${regressed.toString()} benchmark(s) regressed beyond the ${(THRESHOLD * 100).toFixed(0)}% threshold.`,
    );
    process.exit(1);
  }
  console.log('\nAll benchmarks within threshold.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
