// W535.A — drift guard for scripts/check-bench-regression.mjs.
// V-165 perf regression checker. Drift here either changes the
// threshold default (would silently let regressions slip past CI) or
// breaks the advisory-mode rationale (a future decision by the owner
// to flip from advisory to hard-gate has its own V-NNN).
//
//   • V-165 anchor + advisory-mode rationale.
//   • 3-tier exit-code (0/1/2) framing.
//   • 3 env vars: PERF_REGRESSION_THRESHOLD (default 0.50 = 50% slower)
//     + PERF_REGRESSION_RESULTS_PATH (default tmp/bench-results.json)
//     + PERF_REGRESSION_BASELINE_PATH (default docs/benchmarks/
//     baseline.ci.json).
//   • Why-advisory framing: docs/benchmarks/{auth-path,rate-limit,
//     webhook-signature}.md note bench results on shared CI runners
//     are too noisy for hard gates.
//   • Median-normalisation: the threshold applies to the slowdown
//     RELATIVE TO THE REST OF THE RUN, plus the three honesty
//     obligations that come with it (always print the factor, shout
//     when the run is outside the hardware band, refuse to normalise
//     under MIN_SHARED).
//   • PERF_REGRESSION_RECORD_NEW=1 re-records the baseline WITH the
//     hardware it was recorded on.
//   • NOT MEASURED IS NOT PASSED: a baseline benchmark absent from
//     the run, and a pair whose rate is non-finite, are reported as
//     [missing] / [unmeasured] and drop the summary line to "All
//     COMPARED benchmarks within threshold." They never change the
//     exit code.
//   • The blind spot's boundary is HALF (not "most"), and that is the
//     stated reason the speed factor is one GLOBAL median rather than
//     a median per bench file.
//
// 2026-09-20 — this pin was updated deliberately, twice:
//
//   1. `const flag = slowdown >= THRESHOLD` became
//      `normalisedSlowdown >= threshold`. The check had failed on five
//      consecutive main runs because the whole runner was ~2.7x slow,
//      including a bare node:crypto digest that is not our code; a
//      check that always fails is a check everybody ignores, so a real
//      regression would have been invisible. The RAW formula and its
//      sign convention are still pinned below — they are still
//      computed and still printed — and what moved is only which
//      number the threshold is measured against.
//   2. The advisory-stance sentence now names the owner as the one
//      who decides a flip to a hard gate, in the repo's own wording.
//      Same commitment, same decision-maker.
//
// What this pin protects is unchanged: the exit codes, the env names
// and their defaults, and the advisory (never hard-gate-by-default)
// stance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'scripts/check-bench-regression.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W535.A scripts/check-bench-regression.mjs content parity', () => {
  const body = read(LIB);

  it("V-165 framing + 3-tier exit-code commitment pinned: 'V-165 — perf regression checker.' + 'Compares the latest tinybench output (tmp/bench-results.json, produced by `npm run bench:json`) against a checked-in baseline (docs/benchmarks/baseline.ci.json) recorded on the CI runner.' + 'Exit codes: 0 — no regressions exceed the threshold. 1 — at least one regression exceeds the threshold (advisory mode can `continue-on-error: true` to swallow this). 2 — bootstrap mode: baseline file missing. Records the current results as the new baseline (call sites must commit the file).' — pinned so the V-165 anchor + tinybench-output + checked-in-baseline + 3-tier-exit-code (0=clean / 1=regression / 2=bootstrap) commitment survives", () => {
    expect(body).toMatch(/\/\/ V-165 — perf regression checker\./);
    expect(body).toMatch(
      /\/\/ Compares the latest tinybench output \(tmp\/bench-results\.json,\s*\/\/ produced by `npm run bench:json`\) against a checked-in baseline\s*\/\/ \(docs\/benchmarks\/baseline\.ci\.json\) recorded on the CI runner\./,
    );
    expect(body).toMatch(
      /\/\/\s+0 — no regressions exceed the threshold\.\s*\/\/\s+1 — at least one regression exceeds the threshold \(advisory mode\s*\/\/\s+can `continue-on-error: true` to swallow this\)\.\s*\/\/\s+2 — bootstrap mode: baseline file missing\. Records the current\s*\/\/\s+results as the new baseline \(call sites must commit the file\)\./,
    );
  });

  it("3-env-var framing pinned: 'PERF_REGRESSION_THRESHOLD — fractional slowdown to flag. Default 0.50 (i.e. 50% slower than baseline triggers a fail).' + 'PERF_REGRESSION_RESULTS_PATH — override input path. Default tmp/bench-results.json.' + 'PERF_REGRESSION_BASELINE_PATH — override baseline path. Default docs/benchmarks/baseline.ci.json.' — pinned so the 3-env-var + 0.50-default-threshold commitment survives (drift to lowering default threshold without parallel adjustment to noise-tolerance would surface false-positive regressions; drift to raising default would silently let real regressions slip)", () => {
    expect(body).toMatch(
      /\/\/\s+PERF_REGRESSION_THRESHOLD — fractional slowdown to flag\.\s*\/\/\s+Default 0\.50 \(i\.e\. 50% slower than\s*\/\/\s+baseline triggers a fail\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+PERF_REGRESSION_RESULTS_PATH — override input path\. Default\s*\/\/\s+tmp\/bench-results\.json\./,
    );
    expect(body).toMatch(
      /\/\/\s+PERF_REGRESSION_BASELINE_PATH — override baseline path\. Default\s*\/\/\s+docs\/benchmarks\/baseline\.ci\.json\./,
    );
    expect(body).toMatch(
      /const THRESHOLD = Number\(process\.env\.PERF_REGRESSION_THRESHOLD \?\? '0\.50'\);/,
    );
  });

  it("Why-advisory rationale framing pinned: 'Why advisory and not gate-by-default: docs/benchmarks/{auth-path,rate-limit,webhook-signature}.md note that bench results on shared CI runners are too noisy for hard gates. This script lands the infrastructure; flipping to a hard gate is a separate decision for the owner (V-NNN follow-on with sustained low-noise CI runs as evidence).' — pinned so the advisory-not-hard-gate-by-default + 3 noisy-bench-doc cross-refs + owner-decides-before-any-flip-to-gate commitment survives (drift to making this a hard gate without the V-NNN-evidence-decision would break CI on bench-noise alone)", () => {
    expect(body).toMatch(
      /\/\/ Why advisory and not gate-by-default:\s*\/\/\s+docs\/benchmarks\/\{auth-path,rate-limit,webhook-signature\}\.md note\s*\/\/\s+that bench results on shared CI runners are too noisy for hard\s*\/\/\s+gates\. This script lands the infrastructure; flipping to a hard\s*\/\/\s+gate is a separate decision for the owner \(V-NNN follow-on with\s*\/\/\s+sustained low-noise CI runs as evidence\)\./,
    );
  });

  it("Raw slowdown calculation still pinned: '// Slowdown: hz lower than baseline. ratio > 0 means slower.' + 'const slowdown = (base.hz - cur.hz) / base.hz;' — pinned so the hz-lower-means-slower sign convention and the (base-cur)/base raw formula survive. Normalisation changed which number trips the threshold, NOT which numbers are computed and reported: drift that deletes the raw slowdown would delete the only figure in the output that can show a regression every benchmark shared", () => {
    expect(body).toMatch(/\/\/ Slowdown: hz lower than baseline\. ratio > 0 means slower\./);
    expect(body).toMatch(/const slowdown = \(base\.hz - cur\.hz\) \/ base\.hz;/);
    expect(body).toMatch(/slowdownPct: \(slowdown \* 100\)\.toFixed\(1\),/);
  });

  it("Threshold trips on the NORMALISED slowdown: 'const normalisedHz = cur.hz / factor;' + 'const normalisedSlowdown = (base.hz - normalisedHz) / base.hz;' + \"const flag = normalisedSlowdown >= threshold ? '⚠ REGRESSED' : 'ok';\" — pinned so the compare-against-the-run's-own-speed commitment survives. Drift back to tripping on the raw slowdown reinstates the failure this replaced: five consecutive red CI runs where every benchmark, a bare node:crypto digest included, was 54-70% slower together on a slower runner", () => {
    expect(body).toMatch(/const normalisedHz = cur\.hz \/ factor;/);
    expect(body).toMatch(/const normalisedSlowdown = \(base\.hz - normalisedHz\) \/ base\.hz;/);
    expect(body).toMatch(/const flag = normalisedSlowdown >= threshold \? '⚠ REGRESSED' : 'ok';/);
  });

  it('Speed factor is the MEDIAN of (current hz / baseline hz) over shared benchmarks, and the three honesty obligations are pinned with it: MIN_SHARED = 3 refuses to normalise and says so, HARDWARE_BAND = 2 names the different-hardware notice, and the header states what median-normalisation CANNOT see — pinned because each is the part that keeps a normalised check honest. Drift to a MEAN factor would let the single regression in the set drag the factor toward itself and hide; drift that drops the refusal would divide by a factor drawn from one sample; drift that drops the blind-spot statement would let a shared, real regression read as a quiet pass', () => {
    expect(body).toMatch(/export const MIN_SHARED = 3;/);
    expect(body).toMatch(/export const HARDWARE_BAND = 2;/);
    expect(body).toMatch(/export function speedFactor\(current, baseline\) \{/);
    expect(body).toMatch(
      /const factor = shared % 2 === 1 \? ratios\[mid\] : \(ratios\[mid - 1\] \+ ratios\[mid\]\) \/ 2;/,
    );
    expect(body).toMatch(/if \(shared < MIN_SHARED\) \{/);
    expect(body).toMatch(/REFUSING to normalise; the numbers below are RAW/);
    expect(body).toMatch(/return factor > HARDWARE_BAND \|\| factor < 1 \/ HARDWARE_BAND;/);
    expect(body).toMatch(/⚠ WHAT MEDIAN-NORMALISATION CANNOT SEE/);
    expect(body).toMatch(/⚠ DIFFERENT HARDWARE — the baseline does not describe this runner\./);
  });

  it("PERF_REGRESSION_RECORD_NEW=1 re-records the baseline WITH the hardware, documented in the ENV block: 'set to 1 to REPLACE the baseline with the current results and exit 0' + recordedAtIso/node/os/arch/cpu in baselineRecord() — pinned so a runner-class change has a first-class answer. Drift that drops the hardware fields leaves a baseline that cannot tell a later run whether it is comparing across machines, which is the condition that produced the five red runs", () => {
    expect(body).toMatch(
      /\/\/\s+PERF_REGRESSION_RECORD_NEW — set to 1 to REPLACE the baseline\s*\/\/\s+with the current results and exit 0,/,
    );
    expect(body).toMatch(/const RECORD_NEW = process\.env\.PERF_REGRESSION_RECORD_NEW === '1';/);
    expect(body).toMatch(/export function baselineRecord\(current, hardware\) \{/);
    for (const field of ['recordedAtIso', 'node', 'os', 'arch', 'cpu']) {
      expect(body).toMatch(new RegExp(`${field}: hardware\\.${field},`));
    }
  });

  it('main() is guarded so importing the module does not run the check — same entrypoint guard as scripts/bump-gui-version.mjs. Drift that drops it makes every unit test of the pure functions run a real comparison and exit the test process', () => {
    expect(body).toMatch(
      /if \(process\.argv\[1\] !== undefined && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\) \{/,
    );
    expect(body).toMatch(/export function flatten\(report\) \{/);
    expect(body).toMatch(/export function compare\(current, baseline, \{/);
  });

  it("NOT MEASURED IS NOT PASSED: a baseline benchmark absent from the run is collected into `missing` and a pair with a non-finite or non-positive rate becomes an 'unmeasured' row, and the summary downgrades to 'All COMPARED benchmarks within threshold.' whenever either is present — pinned because the arithmetic alone renders both as a pass (NaN >= threshold is false), which is the check's own failure mode in miniature: a question it could not answer, printed as an answer", () => {
    expect(body).toMatch(
      /if \(!Number\.isFinite\(cur\.hz\) \|\| !Number\.isFinite\(base\.hz\) \|\| base\.hz <= 0\) \{/,
    );
    expect(body).toMatch(/status: 'unmeasured'/);
    expect(body).toMatch(
      /const missing = \[\.\.\.new Set\(baseline\.map\(\(b\) => b\.key\)\)\]\.filter\(\(key\) => !seen\.has\(key\)\);/,
    );
    expect(body).toMatch(/return \{ rows, regressed, missing \};/);
    expect(body).toMatch(/'All COMPARED benchmarks within threshold\.'/);
    expect(body).toMatch(/did not appear in this run and were NOT checked/);
    expect(body).toMatch(/⚠ WHAT MEDIAN-NORMALISATION CANNOT SEE/);
    expect(body).toMatch(/NOT MEASURED IS NOT PASSED/);
  });

  it("The blind spot's boundary is stated as HALF and as the reason the factor is one GLOBAL median — 'k == n/2 (even)' lands the factor halfway and flags nothing, and a per-file factor would erase a regression that hit one bench file's whole group. Pinned because a vaguer word ('most') understates it by a benchmark and because a future refactor to per-file factors would be blind to exactly the regressions in our own code this check exists to catch", () => {
    expect(body).toMatch(/A real regression that hit HALF OR MORE of the benchmarks/);
    expect(body).toMatch(/The boundary is exactly half, not "most"/);
    expect(body).toMatch(/why the factor is ONE GLOBAL MEDIAN and not/);
    expect(body).toMatch(/a median per bench file/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
