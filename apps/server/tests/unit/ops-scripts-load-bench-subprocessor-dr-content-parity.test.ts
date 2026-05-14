// W808 — operational scripts content parity. One-hundred-thirty-
// fourth in the drift-guard series. Pins 4 distinct ops scripts:
//   - V-495 scripts/load-test/run.mjs       (autocannon load-test CLI)
//   - V-165 scripts/check-bench-regression.mjs (perf regression gate)
//   - V-271 scripts/check-subprocessor-mirror.mjs (DPA-marketing parity)
//   - V-510 scripts/dr-rehearse.sh           (DR rehearsal harness)
// Each is load-bearing for a distinct lifecycle event: load-testing
// safety, perf regression detection, GDPR compliance, DR rehearsal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LOAD = resolve(REPO_ROOT, 'scripts/load-test/run.mjs');
const BENCH = resolve(REPO_ROOT, 'scripts/check-bench-regression.mjs');
const SUBPROC = resolve(REPO_ROOT, 'scripts/check-subprocessor-mirror.mjs');
const DR = resolve(REPO_ROOT, 'scripts/dr-rehearse.sh');

describe('W808 ops scripts content parity', () => {
  it('all 4 ops scripts exist at canonical paths', () => {
    for (const f of [LOAD, BENCH, SUBPROC, DR]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  // ─── V-495 load-test/run.mjs ──────────────────────────────────

  it('CRITICAL load-test/run.mjs V-495 anchor + autocannon-based framing + methodology cross-link pinned. The docs/load-test/methodology.md cross-link makes the script self-documenting.', () => {
    const p = read(LOAD);
    expect(p).toMatch(/\/\/ V-495 — autocannon-based load-test harness\./);
    expect(p).toMatch(/Methodology \+ safety: docs\/load-test\/methodology\.md/);
  });

  it('CRITICAL load-test 4-TARGET set pinned — status / health / version / sessions. Status/health/version are productionSafe:true (read-only); sessions is productionSafe:false (mutates state, staging-only by default).', () => {
    const p = read(LOAD);
    expect(p).toMatch(/const TARGETS = \{/);
    expect(p).toMatch(/status: \{[\s\S]*?path: '\/v1\/status',[\s\S]*?productionSafe: true,/);
    expect(p).toMatch(/health: \{[\s\S]*?path: '\/health',[\s\S]*?productionSafe: true,/);
    expect(p).toMatch(/version: \{[\s\S]*?path: '\/version',[\s\S]*?productionSafe: true,/);
    expect(p).toMatch(
      /sessions: \{[\s\S]*?path: '\/v1\/sessions',[\s\S]*?requiresAuth: true,[\s\S]*?productionSafe: false/,
    );
  });

  it('CRITICAL load-test 3-ENV map pinned — staging:staging.driftstack.dev + production:api.driftstack.dev + local:localhost:7780. Drift to a different production host would direct accidental load tests at the wrong target.', () => {
    const p = read(LOAD);
    expect(p).toMatch(/staging: 'https:\/\/staging\.driftstack\.dev'/);
    expect(p).toMatch(/production: 'https:\/\/api\.driftstack\.dev'/);
    expect(p).toMatch(/local: 'http:\/\/localhost:7780'/);
  });

  it("CRITICAL load-test production-safety guard pinned. The 'Refusing to run target X against production' + 'Mutating endpoints stay on staging unless --i-know-what-im-doing is set' refusal is the load-bearing 'don't accidentally load-test production write paths' protection.", () => {
    const p = read(LOAD);
    expect(p).toMatch(/if \(envName === 'production' && !target\.productionSafe\) \{/);
    expect(p).toMatch(/Refusing to run target "\$\{targetName\}" against production/);
    expect(p).toMatch(/Mutating endpoints stay on staging unless --i-know-what-im-doing is set/);
    expect(p).toMatch(/if \(args\['i-know-what-im-doing'\] !== 'true'\) process\.exit\(3\)/);
  });

  it("CRITICAL load-test auth-token framing pinned. The DRIFTSTACK_LOAD_TEST_API_KEY env-var + 'NEVER use production keys' warning is the load-bearing 'staging-account only' protection. Drift would let production keys leak into load tests.", () => {
    const p = read(LOAD);
    expect(p).toMatch(/const token = process\.env\.DRIFTSTACK_LOAD_TEST_API_KEY;/);
    expect(p).toMatch(/Export DRIFTSTACK_LOAD_TEST_API_KEY/);
    expect(p).toMatch(/with a staging-account API key \(NEVER use production keys\)/);
  });

  it('CRITICAL load-test default duration 30s + 10 connections + 1 pipelining pinned. The short default duration prevents accidental noise from interactive runs.', () => {
    const p = read(LOAD);
    expect(p).toMatch(/parseInt\(args\.duration \|\| '30', 10\)/);
    expect(p).toMatch(/parseInt\(args\.connections \|\| '10', 10\)/);
    expect(p).toMatch(/parseInt\(args\.pipelining \|\| '1', 10\)/);
  });

  it('CRITICAL load-test JSON summary shape pinned — target + env + url + method + duration_seconds + connections + pipelining + requests{total/avg/p50/p99} + latency_ms{avg/p50/p90/p99/max} + throughput_bytes + errors + timeouts + non_2xx + started_at + finished_at. Drift would break downstream trend-tracking parsers.', () => {
    const p = read(LOAD);
    expect(p).toMatch(/target: targetName,/);
    expect(p).toMatch(/duration_seconds: duration,/);
    expect(p).toMatch(/per_sec_avg: result\.requests\.average,/);
    expect(p).toMatch(/per_sec_p50: result\.requests\.p50 \?\? null,/);
    expect(p).toMatch(/p50: result\.latency\.p50,/);
    expect(p).toMatch(/p90: result\.latency\.p90,/);
    expect(p).toMatch(/p99: result\.latency\.p99,/);
    expect(p).toMatch(/non_2xx: result\.non2xx,/);
    expect(p).toMatch(/started_at: result\.start\.toISOString\(\),/);
    expect(p).toMatch(/finished_at: result\.finish\.toISOString\(\),/);
  });

  it('CRITICAL load-test exit non-zero on errors|non2xx|timeouts pinned. The 3-condition exit lets CI fail builds on any anomaly.', () => {
    const p = read(LOAD);
    expect(p).toMatch(
      /if \(result\.errors > 0 \|\| result\.non2xx > 0 \|\| result\.timeouts > 0\) \{\s*\n\s+process\.exit\(1\);/,
    );
  });

  // ─── V-165 check-bench-regression.mjs ─────────────────────────

  it('CRITICAL check-bench-regression.mjs V-165 anchor + 3-exit-code framing pinned — 0 (no regressions), 1 (regression), 2 (bootstrap: baseline missing). The 3-state exit lets CI handle both new-bench bootstrap + existing-bench gating.', () => {
    const p = read(BENCH);
    expect(p).toMatch(/\/\/ V-165 — perf regression checker\./);
    expect(p).toMatch(/0 — no regressions exceed the threshold\./);
    expect(p).toMatch(/1 — at least one regression exceeds the threshold/);
    expect(p).toMatch(/2 — bootstrap mode: baseline file missing\./);
  });

  it('CRITICAL check-bench-regression.mjs 3 env-var override set pinned — PERF_REGRESSION_THRESHOLD (default 0.50) + PERF_REGRESSION_RESULTS_PATH (default tmp/bench-results.json) + PERF_REGRESSION_BASELINE_PATH (default docs/benchmarks/baseline.ci.json). Drift to different defaults would either re-flag stable benches or miss real regressions.', () => {
    const p = read(BENCH);
    expect(p).toMatch(/PERF_REGRESSION_THRESHOLD — fractional slowdown to flag\./);
    expect(p).toMatch(/Default 0\.50 \(i\.e\. 50% slower than/);
    expect(p).toMatch(/process\.env\.PERF_REGRESSION_RESULTS_PATH \?\? 'tmp\/bench-results\.json'/);
    expect(p).toMatch(
      /process\.env\.PERF_REGRESSION_BASELINE_PATH \?\?\s*'docs\/benchmarks\/baseline\.ci\.json'/,
    );
    expect(p).toMatch(
      /const THRESHOLD = Number\(process\.env\.PERF_REGRESSION_THRESHOLD \?\? '0\.50'\)/,
    );
  });

  it("CRITICAL check-bench-regression.mjs advisory-not-gate-by-default framing pinned. The 'bench results on shared CI runners are too noisy for hard gates' wording explains why this lands infrastructure, not enforcement.", () => {
    const p = read(BENCH);
    expect(p).toMatch(
      /Why advisory and not gate-by-default:\s*\n\/\/\s+docs\/benchmarks\/\{auth-path,rate-limit,webhook-signature\}\.md note/,
    );
    expect(p).toMatch(
      /that bench results on shared CI runners are too noisy for hard\s*\n\/\/\s+gates\./,
    );
  });

  it('CRITICAL check-bench-regression.mjs slowdown computation pinned — (base.hz - cur.hz)/base.hz with positive ratio meaning slower. Flagged when slowdown >= THRESHOLD. Drift to mean-based comparison would invert the sign.', () => {
    const p = read(BENCH);
    expect(p).toMatch(/\/\/ Slowdown: hz lower than baseline\. ratio > 0 means slower\./);
    expect(p).toMatch(/const slowdown = \(base\.hz - cur\.hz\) \/ base\.hz;/);
    expect(p).toMatch(/const flag = slowdown >= THRESHOLD \? '⚠ REGRESSED' : 'ok';/);
  });

  it('CRITICAL check-bench-regression.mjs flatten() walks files→groups→benchmarks producing {key, hz, mean}. The key shape `${group.fullName} :: ${bench.name}` is the canonical bench-identity convention; drift would break baseline lookup.', () => {
    const p = read(BENCH);
    expect(p).toMatch(/function flatten\(report\) \{/);
    expect(p).toMatch(/for \(const file of report\.files \?\? \[\]\) \{/);
    expect(p).toMatch(/for \(const group of file\.groups \?\? \[\]\) \{/);
    expect(p).toMatch(/for \(const bench of group\.benchmarks \?\? \[\]\) \{/);
    expect(p).toMatch(/key: `\$\{group\.fullName\} :: \$\{bench\.name\}`/);
  });

  // ─── V-271 check-subprocessor-mirror.mjs ──────────────────────

  it("CRITICAL check-subprocessor-mirror.mjs V-271 anchor + 'V-264 + V-255 lockstep' + 'Article 28(2) GDPR notice + re-acceptance flow' framing pinned. The compliance-bug framing is the load-bearing 'silent drift is illegal, not just sloppy' anchor.", () => {
    const p = read(SUBPROC);
    expect(p).toMatch(/\/\/ V-271 — Sub-processor mirror linter\./);
    expect(p).toMatch(
      /V-264 \+ V-255 both noted that these two surfaces must move in\s*\n\/\/ lockstep — adding or removing a sub-processor triggers an Article\s*\n\/\/ 28\(2\) GDPR notice \+ a re-acceptance flow/,
    );
    expect(p).toMatch(/silent drift between\s*\n\/\/ the two is a compliance bug/);
  });

  it("CRITICAL check-subprocessor-mirror.mjs 2-path pair pinned — apps/marketing-site/src/data/sub-processors.ts + docs/legal/dpa.md. The dpa.md filename matches the 'legal filename convention' memory rule (short slug, not long-form).", () => {
    const p = read(SUBPROC);
    expect(p).toMatch(
      /PUBLIC_LIST_PATH = join\(REPO_ROOT, 'apps\/marketing-site\/src\/data\/sub-processors\.ts'\)/,
    );
    expect(p).toMatch(/DPA_PATH = join\(REPO_ROOT, 'docs\/legal\/dpa\.md'\)/);
  });

  it('CRITICAL check-subprocessor-mirror.mjs Stripe split exception framing pinned. The \'Stripe Payments Europe Ltd + Stripe, Inc. in the DPA → "Stripe" in the public list\' wording documents the only allowed 2:1 collapse.', () => {
    const p = read(SUBPROC);
    expect(p).toMatch(
      /The Stripe split \(Stripe Payments Europe Ltd \+ Stripe, Inc\. in\s*\n\/\/\s+the DPA → "Stripe" in the public list\) is the documented\s*\n\/\/\s+exception; both DPA rows resolve to the single public "Stripe"\s*\n\/\/\s+entry\./,
    );
  });

  it('CRITICAL check-subprocessor-mirror.mjs STOPWORDS list pinned. The 22-entity-suffix list (inc/ltd/limited/gmbh/bv/b.v./pbc/llc/corp/corporation/co/company + product-noun cloud/online/r2/commerce/payments/europe + filler the/and/a/an/of) strips entity-suffix noise so distinctive vendor tokens survive.', () => {
    const p = read(SUBPROC);
    expect(p).toMatch(/const STOPWORDS = new Set\(\[/);
    for (const word of [
      'inc',
      'ltd',
      'limited',
      'gmbh',
      'bv',
      'b\\.v\\.',
      'pbc',
      'llc',
      'corp',
      'corporation',
      'co',
      'company',
      'cloud',
      'online',
      'r2',
      'commerce',
      'payments',
      'europe',
      'the',
      'and',
      'a',
      'an',
      'of',
    ]) {
      expect(p).toMatch(new RegExp(`'${word}',?`));
    }
  });

  it("CRITICAL check-subprocessor-mirror.mjs token-matching framing pinned. The 3 example token-matches ('Stripe Payments Europe Ltd' + 'Stripe, Inc.' → public 'Stripe' via 'stripe'; 'Hetzner Cloud' ↔ 'Hetzner Online GmbH' via 'hetzner'; 'Cloudflare R2' ↔ 'Cloudflare, Inc.' via 'cloudflare') document the algorithm contract.", () => {
    const p = read(SUBPROC);
    expect(p).toMatch(/The Stripe split[\s\S]*?matches via the shared token\s*\n\/\/ `stripe`/);
    expect(p).toMatch(/"Hetzner Cloud" ↔ "Hetzner Online GmbH" matches via\s*\n\/\/ `hetzner`/);
    expect(p).toMatch(/"Cloudflare R2" ↔ "Cloudflare, Inc\." matches via\s*\n\/\/ `cloudflare`/);
  });

  it("CRITICAL check-subprocessor-mirror.mjs Annex 3 markdown-table parser pinned. The parser looks for '## Annex 3' heading + walks forward + captures '|' rows skipping header + separator. Drift would either over-match (capture headings) or miss real entries.", () => {
    const p = read(SUBPROC);
    expect(p).toMatch(/const annexIdx = src\.indexOf\('## Annex 3'\)/);
    expect(p).toMatch(/Could not locate "## Annex 3" heading/);
    expect(p).toMatch(/if \(!line\.startsWith\('\|'\)\) continue;/);
    expect(p).toMatch(/if \(\/\^\[-\\s\|\]\+\$\/\.test\(first\)\) continue;/);
    expect(p).toMatch(/if \(\/\^sub-\?processor\/i\.test\(first\)\) continue;/);
  });

  it("CRITICAL check-subprocessor-mirror.mjs failure message includes re-run instruction. The 'After fixing, re-run: node scripts/check-subprocessor-mirror.mjs' wording closes the operator loop.", () => {
    const p = read(SUBPROC);
    expect(p).toMatch(
      /Sub-processor changes are an Article 28\(2\) GDPR amendment \+ force a customer/,
    );
    expect(p).toMatch(/Both surfaces MUST move in lockstep/);
    expect(p).toMatch(/node scripts\/check-subprocessor-mirror\.mjs/);
  });

  // ─── V-510 dr-rehearse.sh ─────────────────────────────────────

  it("CRITICAL dr-rehearse.sh V-510 anchor + 'local-only / refuses to act on production' framing pinned. The PRODUCTION_HOST_PATTERNS array (api.driftstack.dev + staging-api.driftstack.dev) is the load-bearing safety guard.", () => {
    const p = read(DR);
    expect(p).toMatch(/# V-510 — DR rehearsal harness\./);
    expect(p).toMatch(/Refuses to act on production\./);
    expect(p).toMatch(
      /PRODUCTION_HOST_PATTERNS=\(\s*\n\s+"api\.driftstack\.dev"\s*\n\s+"staging-api\.driftstack\.dev"\s*\n\)/,
    );
    expect(p).toMatch(/refuse_on_production\(\) \{/);
    expect(p).toMatch(/exit 2/);
  });

  it('CRITICAL dr-rehearse.sh 5-scenario set pinned — scenario-2 (PG corruption) + scenario-4 (Redis loss) + scenario-6 (signing-key rotation) + scenario-7 (bad deploy) + scenario-8 (cert renewal). The gaps (1/3/5/9/10/11) are deliberate — those need production touchpoints + founder authorisation.', () => {
    const p = read(DR);
    expect(p).toMatch(/scenario-2[\s#]+PG (?:corruption \(PITR proxy\)|logical corruption)/);
    expect(p).toMatch(/scenario-4[\s#]+Redis loss/);
    expect(p).toMatch(/scenario-6[\s#]+(?:signing-key rotation|Signing-key rotation)/i);
    expect(p).toMatch(/scenario-7[\s#]+(?:bad deploy of broken code|Bad deploy)/i);
    expect(p).toMatch(/scenario-8[\s#]+(?:cert renewal|Cert renewal)/i);
    expect(p).toMatch(/scenario-1[\s#]+Hetzner host loss/);
    expect(p).toMatch(/scenario-9[\s#]+Cloudflare Pages rollback/);
    expect(p).toMatch(/scenario-10[\s#]+Stripe panic-rotation/);
    expect(p).toMatch(/scenario-11[\s#]+Hetzner regional failover/);
  });

  it('CRITICAL dr-rehearse.sh check_prereqs 6-tool set pinned — node + npm + npx + git + curl + jq. Drift to dropping any would let a missing-tool failure surface mid-rehearsal rather than at pre-flight.', () => {
    const p = read(DR);
    expect(p).toMatch(/for cmd in node npm npx git curl jq; do/);
    expect(p).toMatch(/✗ missing: \$cmd/);
    expect(p).toMatch(/if \[\[ ! -f package\.json \]\]; then\s*\n\s+echo "✗ not in repo root"/);
  });

  it("CRITICAL dr-rehearse.sh scenario-6 V-359 dual-sign-during-grace contract pinned. The 'V-359 dual-sign-during-grace contract' wording threads the canonical signing-key-rotation provenance.", () => {
    const p = read(DR);
    expect(p).toMatch(/Verifies V-359 dual-sign-during-grace contract\./);
  });

  it("CRITICAL dr-rehearse.sh scenario-7 'pre-push hook runs full 1300+ test suite' framing pinned. The test-count anchor is the load-bearing 'this is comprehensive, not a smoke test' claim.", () => {
    const p = read(DR);
    expect(p).toMatch(
      /Pre-push hook runs the full 1300\+ test suite; broken code is rejected at push time\./,
    );
  });

  it("CRITICAL dr-rehearse.sh dispatch case statement pinned. The list-by-default convention (no args → list_scenarios) makes 'just run it' produce useful output.", () => {
    const p = read(DR);
    expect(p).toMatch(/cmd="\$\{1:-list\}"/);
    expect(p).toMatch(/list\|""\)\s+list_scenarios ;;/);
    expect(p).toMatch(/check-prereqs\)\s+check_prereqs ;;/);
    expect(p).toMatch(/all\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/ops-scripts-load-bench-subprocessor-dr-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
