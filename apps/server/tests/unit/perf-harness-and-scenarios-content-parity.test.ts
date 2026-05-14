// W805 — perf/ load-test harness + 3 scenario scripts content
// parity. One-hundred-thirty-first in the drift-guard series. Pins
// the load-testing surface: _harness.ts (shared boot + autocannon
// driver + pass criteria) + burst.ts (1000 rps for 60s) + sustained.
// ts (100 rps mixed for 5min) + soak.ts (30 rps for 1h, memory-leak
// detector). Drift in pass-thresholds would let regressions slip
// through; drift in the harness shape would break all 3 scenarios.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const HARNESS = resolve(REPO_ROOT, 'perf/_harness.ts');
const BURST = resolve(REPO_ROOT, 'perf/burst.ts');
const SUSTAINED = resolve(REPO_ROOT, 'perf/sustained.ts');
const SOAK = resolve(REPO_ROOT, 'perf/soak.ts');

describe('W805 perf/ harness + scenarios content parity', () => {
  it('all 4 perf files exist at canonical paths', () => {
    expect(existsSync(HARNESS)).toBe(true);
    expect(existsSync(BURST)).toBe(true);
    expect(existsSync(SUSTAINED)).toBe(true);
    expect(existsSync(SOAK)).toBe(true);
  });

  // ─── _harness.ts: shared harness contract ─────────────────────

  it("CRITICAL _harness.ts header framing pinned. 'Boots the same Fastify app as e2e, seeds one test account, drives load via autocannon, captures process metrics every N seconds' is the load-bearing 'what this harness does' anchor.", () => {
    const p = read(HARNESS);
    expect(p).toMatch(
      /Boots the same Fastify app as e2e,\s*\n\/\/ seeds one test account, drives load via autocannon, captures process\s*\n\/\/ metrics every N seconds, prints a structured summary\./,
    );
  });

  it('CRITICAL _harness.ts Scenario interface pinned — name + durationSec + connections + sampleEverySec + seedTier + requests fn. Drift to dropping any field would break every scenario script.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/export interface Scenario \{/);
    expect(p).toMatch(/name: string;/);
    expect(p).toMatch(/durationSec: number;/);
    expect(p).toMatch(/connections: number;/);
    expect(p).toMatch(/sampleEverySec: number;/);
    expect(p).toMatch(
      /seedTier\?: 'free' \| 'starter' \| 'solo' \| 'builder' \| 'scale' \| 'enterprise';/,
    );
    expect(p).toMatch(
      /requests: \(ctx: \{ baseUrl: string; bearer: string; sessionId: string \}\) => autocannon\.Request\[\];/,
    );
  });

  it('CRITICAL _harness.ts ScenarioResult interface pinned — name + durationActualMs + totalRequests + rps + 3 latency percentiles + errors + non2xx + statusCodes + memorySamples. Each field drives the structured summary used by check-bench-regression.mjs downstream.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/export interface ScenarioResult \{/);
    expect(p).toMatch(/durationActualMs: number;/);
    expect(p).toMatch(/totalRequests: number;/);
    expect(p).toMatch(/rps: number;/);
    expect(p).toMatch(/latencyP50Ms: number;/);
    expect(p).toMatch(/latencyP95Ms: number;/);
    expect(p).toMatch(/latencyP99Ms: number;/);
    expect(p).toMatch(/errors: number;/);
    expect(p).toMatch(/non2xx: number;/);
    expect(p).toMatch(/statusCodes: Record<string, number>;/);
    expect(p).toMatch(/memorySamples: MemorySample\[\];/);
  });

  it('CRITICAL _harness.ts MemorySample 5-field shape — tSec + rssMb + heapUsedMb + heapTotalMb + external. All in MB (rounded to 0.1MB) for human-readable summaries.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/export interface MemorySample \{/);
    expect(p).toMatch(/tSec: number;/);
    expect(p).toMatch(/rssMb: number;/);
    expect(p).toMatch(/heapUsedMb: number;/);
    expect(p).toMatch(/heapTotalMb: number;/);
    expect(p).toMatch(/external: number;/);
  });

  it("CRITICAL _harness.ts default seedTier = 'scale' pinned. Burst overrides to 'enterprise' for the 1000 RPS run; default scale tier is canonical for sustained + soak.", () => {
    const p = read(HARNESS);
    expect(p).toMatch(/const tier = scenario\.seedTier \?\? 'scale';/);
  });

  it('CRITICAL _harness.ts warm-up session uses label="perf-warmup" + 201 status check. Drift to a different status would let warmup failures pass silently; drift to no label would lose dashboard-visibility.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/body: JSON\.stringify\(\{ label: 'perf-warmup' \}\),/);
    expect(p).toMatch(/if \(warmup\.status !== 201\) \{/);
    expect(p).toMatch(
      /throw new Error\(`warmup session create failed: \$\{warmup\.status\.toString\(\)\}`\);/,
    );
  });

  it('CRITICAL _harness.ts memory-sample math: rssMb = m.rss / 1024 / 1024 rounded to 0.1MB precision. The Math.round(x*10)/10 idiom forces single-decimal display. Drift would lose comparability across runs.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/rssMb: Math\.round\(\(m\.rss \/ 1024 \/ 1024\) \* 10\) \/ 10,/);
    expect(p).toMatch(/heapUsedMb: Math\.round\(\(m\.heapUsed \/ 1024 \/ 1024\) \* 10\) \/ 10,/);
  });

  it('CRITICAL _harness.ts rps computed from totalRequests/durationActual (not from autocannon throughput.mean which is bytes/s). Drift to using throughput.mean would silently report bandwidth instead of req/s — a class of regression the harness explicitly defends against per the inline comment.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(
      /\/\/ The autocannon throughput\.mean is bytes\/s; compute the actual req\/s from totals\./,
    );
    expect(p).toMatch(
      /summary\.rps = Math\.round\(\(result\.requests\.total \/ result\.duration\) \* 10\) \/ 10;/,
    );
  });

  it("CRITICAL _harness.ts --duration CLI override pinned. parseArgs reads --duration <N> and returns { durationOverride } for scenarios to default. Drift would break CHAOS-like 'shorter for CI / longer for nightly' workflows.", () => {
    const p = read(HARNESS);
    expect(p).toMatch(/const idx = args\.indexOf\('--duration'\);/);
    expect(p).toMatch(/if \(idx >= 0 && args\[idx \+ 1\]\)/);
    expect(p).toMatch(/return \{ durationOverride: Number\.isFinite\(n\) \? n : null \};/);
  });

  it('CRITICAL _harness.ts PassCriteria + evaluatePass 3-criterion check — maxP99Ms + max5xx + maxRssGrowthFactor. RSS growth measured as last-quarter avg vs first-quarter avg (requires >= 8 samples). Drift would lose memory-leak detection.', () => {
    const p = read(HARNESS);
    expect(p).toMatch(/export interface PassCriteria \{/);
    expect(p).toMatch(/maxP99Ms: number;/);
    expect(p).toMatch(/max5xx: number;/);
    expect(p).toMatch(/Allowed memory growth as multiple of first-quarter avg RSS/);
    expect(p).toMatch(/maxRssGrowthFactor: number;/);
    expect(p).toMatch(/if \(result\.memorySamples\.length >= 8\) \{/);
    expect(p).toMatch(/const q = Math\.floor\(result\.memorySamples\.length \/ 4\);/);
    expect(p).toMatch(/if \(lastAvg > firstAvg \* criteria\.maxRssGrowthFactor\) \{/);
  });

  // ─── burst.ts: 1000 RPS for 60s ───────────────────────────────

  it('CRITICAL burst.ts default duration 60s + 200 connections pinned. The 200 connections × 5 RPS/conn = 1000 RPS target is documented inline. Drift to different defaults would change the canonical burst-test workload.', () => {
    const p = read(BURST);
    expect(p).toMatch(/const durationSec = durationOverride \?\? 60;/);
    expect(p).toMatch(/const connections = 200; \/\/ 1000 RPS \/ 5 req\/s avg per connection/);
  });

  it("CRITICAL burst.ts scenario name = 'burst-1000rps' + seedTier = 'enterprise' pinned. Enterprise tier has 60k capacity / 1000 rps refill — matched to the burst target. Lower tiers exhaust their bucket in seconds.", () => {
    const p = read(BURST);
    expect(p).toMatch(/name: 'burst-1000rps',/);
    expect(p).toMatch(/seedTier: 'enterprise',/);
    expect(p).toMatch(/Enterprise tier — global rate limit is 60k capacity \/ 1000 rps refill/);
  });

  it("CRITICAL burst.ts V-010 autocannon-request-shape comment pinned. The 'autocannon takes baseUrl at the top level; per-request entries use path, not url. (V-010 captures the empirical finding that drove this)' wording is the load-bearing anchor for the request-shape quirk.", () => {
    const p = read(BURST);
    expect(p).toMatch(
      /autocannon takes `baseUrl` at the top level; per-request entries use\s*\n\s+\/\/ `path`, not `url`\. \(V-010 captures the empirical finding that drove this\.\)/,
    );
  });

  it('CRITICAL burst.ts pass thresholds — maxP99Ms 1000 + max5xx 0 + maxRssGrowthFactor 1.5. The 1s p99 ceiling acknowledges that 1000 RPS will degrade latency; the 0-5xx ceiling is non-negotiable.', () => {
    const p = read(BURST);
    expect(p).toMatch(/maxP99Ms: 1000,/);
    expect(p).toMatch(/max5xx: 0,/);
    expect(p).toMatch(/maxRssGrowthFactor: 1\.5,/);
  });

  it('CRITICAL burst.ts 2-request set — GET /v1/sessions/:id/state + GET /v1/sessions. Both read-side; bursts stress the connection pool + Redis Lua hot path. Drift would change the workload mix.', () => {
    const p = read(BURST);
    expect(p).toMatch(/path: `\/v1\/sessions\/\$\{sessionId\}\/state`,/);
    expect(p).toMatch(/path: `\/v1\/sessions`,/);
    expect(p).toMatch(/method: 'GET' as const,/);
  });

  // ─── sustained.ts: 100 RPS mixed for 5min ─────────────────────

  it("CRITICAL sustained.ts default duration 300s + 16 connections + 'mixed workload approximating a realistic customer journey' pinned. The 70%/20%/10% mix (navigate + getState + list) is the canonical customer-shape.", () => {
    const p = read(SUSTAINED);
    expect(p).toMatch(/const durationSec = durationOverride \?\? 300;/);
    expect(p).toMatch(/const connections = 16;/);
    expect(p).toMatch(/Mixed workload approximating a realistic customer journey:/);
    expect(p).toMatch(/\/\/\s+70% navigate\/interact \(write-side\)/);
    expect(p).toMatch(/\/\/\s+20% getState\s+\(read-side\)/);
    expect(p).toMatch(/\/\/\s+10% session create \/ destroy/);
  });

  it('CRITICAL sustained.ts request mix uses repeat(N, request) for 7/2/1 split. The repeat helper turns the percentage mix into autocannon entries (7+2+1=10 entries → 70/20/10 distribution via round-robin).', () => {
    const p = read(SUSTAINED);
    expect(p).toMatch(/\.\.\.repeat\(7, \{[\s\S]*?navigate/);
    expect(p).toMatch(/\.\.\.repeat\(2, \{[\s\S]*?\/state/);
    expect(p).toMatch(/\.\.\.repeat\(1, \{[\s\S]*?\/v1\/sessions/);
    expect(p).toMatch(
      /function repeat<T>\(n: number, x: T\): T\[\] \{\s*\n\s+return Array\.from\(\{ length: n \}, \(\) => x\);\s*\n\}/,
    );
  });

  it("CRITICAL sustained.ts navigate body uses 'https://example.com' (IANA-reserved) URL. Matches the W796 quickstart cross-SDK convention; drift to a real site would let perf-test traffic hit production endpoints.", () => {
    const p = read(SUSTAINED);
    expect(p).toMatch(/body: JSON\.stringify\(\{ url: 'https:\/\/example\.com' \}\),/);
  });

  it('CRITICAL sustained.ts pass thresholds — maxP99Ms 250 + max5xx 0 + maxRssGrowthFactor 1.5. The 250ms p99 ceiling is the tight realistic-traffic SLO; drift to relaxing it would let regressions creep in.', () => {
    const p = read(SUSTAINED);
    expect(p).toMatch(/maxP99Ms: 250,/);
    expect(p).toMatch(/max5xx: 0,/);
    expect(p).toMatch(/maxRssGrowthFactor: 1\.5,/);
  });

  // ─── soak.ts: 30 RPS for 1h, memory-leak detector ─────────────

  it('CRITICAL soak.ts 1-hour duration (3600s default) + 30 RPS + 60-second sampleEverySec pinned. The 60s sampler at 1-hour runtime produces exactly 60 samples — well over the 8-sample minimum the memory-growth detector needs.', () => {
    const p = read(SOAK);
    expect(p).toMatch(/const durationSec = durationOverride \?\? 3600;/);
    expect(p).toMatch(/const connections = 6; \/\/ 30 RPS \/ 5 req\/s avg per connection/);
    expect(p).toMatch(/sampleEverySec: 60,/);
  });

  it("CRITICAL soak.ts header framing pinned. '1-hour soak at 30 RPS. Memory-leak detector: compares first-quarter average RSS against last-quarter average. Fails if growth > 1.5×' is the load-bearing 'what this scenario tests' anchor.", () => {
    const p = read(SOAK);
    expect(p).toMatch(
      /\/\/ 1-hour soak at 30 RPS\. Memory-leak detector: compares first-quarter\s*\n\/\/ average RSS against last-quarter average\. Fails if growth > 1\.5×\./,
    );
  });

  it("CRITICAL soak.ts scenario name = 'soak-30rps' + pass thresholds maxP99Ms 500 + max5xx 0 + maxRssGrowthFactor 1.5. The 500ms p99 ceiling is between sustained's 250ms and burst's 1000ms.", () => {
    const p = read(SOAK);
    expect(p).toMatch(/name: 'soak-30rps',/);
    expect(p).toMatch(/maxP99Ms: 500,/);
    expect(p).toMatch(/max5xx: 0,/);
    expect(p).toMatch(/maxRssGrowthFactor: 1\.5,/);
  });

  // ─── Cross-scenario invariants ────────────────────────────────

  it('CRITICAL all 3 scenarios share the import + main shape — runScenario + evaluatePass + parseArgs + printSummary from ./_harness.js + main().catch(process.exit(1)). Drift would let a scenario silently swallow unhandled rejections.', () => {
    for (const f of [BURST, SUSTAINED, SOAK]) {
      const p = read(f);
      expect(p).toMatch(
        /import \{ evaluatePass, parseArgs, printSummary, runScenario \} from '\.\/_harness\.js';/,
      );
      expect(p).toMatch(
        /main\(\)\.catch\(\(err: unknown\) => \{[\s\S]*?process\.exit\(1\);\s*\n\}\);/,
      );
    }
  });

  it("CRITICAL all 3 scenarios pass-or-FAIL exit shape pinned. On evaluatePass fail: console.error('FAIL: …') + process.exit(1); on pass: console.warn('PASS'). Drift would let CI silently treat a regression as success.", () => {
    for (const f of [BURST, SUSTAINED, SOAK]) {
      const p = read(f);
      expect(p).toMatch(/const \{ pass, reasons \} = evaluatePass\(result, \{/);
      expect(p).toMatch(/console\.error\(`\\nFAIL: \$\{reasons\.join\('; '\)\}`\);/);
      expect(p).toMatch(/process\.exit\(1\);/);
      expect(p).toMatch(/console\.warn\('\\nPASS'\);/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/perf-harness-and-scenarios-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
