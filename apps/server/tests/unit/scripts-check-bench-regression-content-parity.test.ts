// W535.A — drift guard for scripts/check-bench-regression.mjs.
// V-165 perf regression checker. Drift here either changes the
// threshold default (would silently let regressions slip past CI) or
// breaks the advisory-mode rationale (a future founder decision to
// flip from advisory to hard-gate has its own V-NNN).
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

  it("Why-advisory rationale framing pinned: 'Why advisory and not gate-by-default: docs/benchmarks/{auth-path,rate-limit,webhook-signature}.md note that bench results on shared CI runners are too noisy for hard gates. This script lands the infrastructure; flipping to a hard gate is a separate founder decision (V-NNN follow-on with sustained low-noise CI runs as evidence).' — pinned so the advisory-not-hard-gate-by-default + 3 noisy-bench-doc cross-refs + founder-decision-to-flip-to-gate commitment survives (drift to making this a hard gate without the V-NNN-evidence-decision would break CI on bench-noise alone)", () => {
    expect(body).toMatch(
      /\/\/ Why advisory and not gate-by-default:\s*\/\/\s+docs\/benchmarks\/\{auth-path,rate-limit,webhook-signature\}\.md note\s*\/\/\s+that bench results on shared CI runners are too noisy for hard\s*\/\/\s+gates\. This script lands the infrastructure; flipping to a hard\s*\/\/\s+gate is a separate founder decision \(V-NNN follow-on with\s*\/\/\s+sustained low-noise CI runs as evidence\)\./,
    );
  });

  it("Slowdown calculation + threshold-trip framing pinned: '// Slowdown: hz lower than baseline. ratio > 0 means slower.' + 'const slowdown = (base.hz - cur.hz) / base.hz;' + 'const flag = slowdown >= THRESHOLD ? \"⚠ REGRESSED\" : \"ok\";' — pinned so the hz-lower-means-slower + (base-cur)/base slowdown formula + ⚠-REGRESSED-flag-on-threshold-trip commitment survives", () => {
    expect(body).toMatch(/\/\/ Slowdown: hz lower than baseline\. ratio > 0 means slower\./);
    expect(body).toMatch(/const slowdown = \(base\.hz - cur\.hz\) \/ base\.hz;/);
    expect(body).toMatch(/const flag = slowdown >= THRESHOLD \? '⚠ REGRESSED' : 'ok';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
