// W570.B — drift guard for /docs/load-test/methodology.md.
// V-495 load-test methodology. Drift here either swaps the autocannon
// tooling choice, drops the 4-target harness (status/health/version/
// sessions), or unsets the 3 safety rails (i-know-what-im-doing +
// staging-key-required + 10min-default-max).
//
//   • V-495. Standing methodology.
//   • autocannon (pure-Node), k6 as future fallback.
//   • Harness: scripts/load-test/run.mjs.
//   • 4 targets, only status/health/version production-safe.
//   • Profile: 5s warmup + 5s ramp + 30s sustained (10 connections).
//   • Mutating endpoints refuse production unless --i-know-what-im-doing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/load-test/methodology.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W570.B /docs/load-test/methodology.md content parity', () => {
  const body = read(LIB);

  it('Header + V-495-standing-methodology + autocannon-tooling + k6-future + 4-target harness framing pinned', () => {
    expect(body).toMatch(/^# V-495 — Load-test methodology$/m);
    expect(body).toMatch(/Standing methodology for running load tests against the Driftstack/);
    expect(body).toMatch(/control plane\. Pre-launch this is forward-looking; numbers shift/);
    expect(body).toMatch(/once real customer traffic shapes the workload\./);
    expect(body).toMatch(/## Tooling/);
    expect(body).toMatch(/`autocannon` \(already in root `package\.json` dev deps\)\. Reasons:/);
    expect(body).toMatch(/- Pure-Node — no extra binary dependency on the Hetzner ops box\./);
    expect(body).toMatch(/- Outputs JSON summaries that integrate cleanly with downstream/);
    expect(body).toMatch(/perf-tracking tooling\./);
    expect(body).toMatch(/- HTTP\/1\.1 \+ HTTP\/2 support; pipelining knob for hot endpoints\./);
    expect(body).toMatch(/`k6` is the alternative when we need scripted multi-step scenarios/);
    expect(body).toMatch(/\(login → mint API key → run sessions → collect timings\)\./);
    expect(body).toMatch(/## Harness/);
    expect(body).toMatch(/`scripts\/load-test\/run\.mjs`\. Targets named in the harness:/);
    expect(body).toMatch(/\| `status`\s+\| `GET \/v1\/status`\s+\| No\s+\| ✅ Yes\s+\|/);
    expect(body).toMatch(/\| `health`\s+\| `GET \/health`\s+\| No\s+\| ✅ Yes\s+\|/);
    expect(body).toMatch(/\| `version`\s+\| `GET \/version`\s+\| No\s+\| ✅ Yes\s+\|/);
    expect(body).toMatch(/\| `sessions` \| `POST \/v1\/sessions` \| Yes\s+\| ❌ Staging only\s+\|/);
    expect(body).toMatch(
      /Mutating endpoints \(`sessions`, future `webhooks` create, etc\.\) refuse/,
    );
    expect(body).toMatch(/to run against production unless the explicit/);
    expect(body).toMatch(/`--i-know-what-im-doing=true` flag is set\./);
    expect(body).toMatch(/Customer traffic shouldn't/);
    expect(body).toMatch(/get drowned by load-test artifacts\./);
  });

  it('Profile (5s warmup + 5s ramp + 30s sustained) + reporting JSON + safety rails framing pinned', () => {
    expect(body).toMatch(/## Profile/);
    expect(body).toMatch(/Standing profile for a baseline run:/);
    expect(body).toMatch(/- \*\*Warm-up\*\*: 5-second 1-connection run, discarded\./);
    expect(body).toMatch(/Fresh nginx \+/);
    expect(body).toMatch(/Fastify caches don't reflect steady state\./);
    expect(body).toMatch(/- \*\*Ramp\*\*: 5-second 5-connection run, recorded but not gated\./);
    expect(body).toMatch(
      /- \*\*Sustained\*\*: 30-second 10-connection run, recorded \+ the headline/,
    );
    expect(body).toMatch(/number\./);
    expect(body).toMatch(/For high-load probes \(capacity planning\), bump `connections` to/);
    expect(body).toMatch(/50\/100\/250 with `pipelining=10` and a 60-second duration\./);
    expect(body).toMatch(/Monitor$/m);
    expect(body).toMatch(/Hetzner CPU \+ Postgres connection counts during the run; shed load/);
    expect(body).toMatch(/if Postgres `max_connections` is approaching the cap\./);
    expect(body).toMatch(/## Reporting/);
    expect(body).toMatch(/"target": "status",/);
    expect(body).toMatch(/"env": "staging",/);
    expect(body).toMatch(/"url": "https:\/\/staging\.driftstack\.dev\/v1\/status",/);
    expect(body).toMatch(/"duration_seconds": 30,/);
    expect(body).toMatch(/"connections": 10,/);
    expect(body).toMatch(/"total": 12345,/);
    expect(body).toMatch(/"per_sec_avg": 411\.5,/);
    expect(body).toMatch(/"avg": 24\.1,/);
    expect(body).toMatch(/"p50": 22\.0,/);
    expect(body).toMatch(/"p90": 41\.0,/);
    expect(body).toMatch(/"p99": 88\.0,/);
    expect(body).toMatch(/"max": 320/);
    expect(body).toMatch(
      /Pipe to `jq` for inspection or persist to `docs\/load-test\/baselines\/`/,
    );
    expect(body).toMatch(/p50 \/ p90 \/ p99 are the headline numbers; we look/);
    expect(body).toMatch(/at p99 \+ max to catch tail-latency regressions a p50 average would/);
    expect(body).toMatch(/hide\./);
    expect(body).toMatch(/## Safety rails/);
    expect(body).toMatch(/The harness refuses to:/);
    expect(body).toMatch(/- Run against production with a mutating target unless/);
    expect(body).toMatch(/`--i-know-what-im-doing=true` is set\./);
    expect(body).toMatch(/- Run an auth-requiring target without `DRIFTSTACK_LOAD_TEST_API_KEY`/);
    expect(body).toMatch(/exported\. Use a dedicated \*\*staging\*\* key — never production\./);
    expect(body).toMatch(/- Run with `duration > 600` \(10 min\) by default\./);
    expect(body).toMatch(/Long-duration runs/);
    expect(body).toMatch(/go through a separate slice \+ scheduled window so on-call knows\./);
  });

  it('Baseline-pre-launch + p50/p90/p99 expectations + sessions target + trend tracking + related framing pinned', () => {
    expect(body).toMatch(/## Baseline run — pre-launch \(2026-05-10\)/);
    expect(body).toMatch(/Captured before any customer traffic exists; numbers are/);
    expect(body).toMatch(/architectural-floor only\./);
    expect(body).toMatch(/### Target: `status` \(GET \/v1\/status, public, no auth\)/);
    expect(body).toMatch(/node scripts\/load-test\/run\.mjs --target=status --env=staging/);
    expect(body).toMatch(/--duration=30 --connections=10 --pipelining=1/);
    expect(body).toMatch(/Latency p50 \/ p90 \/ p99 baseline expectation \(Cloudflare edge →/);
    expect(body).toMatch(/Hetzner origin, CACHE HIT after first 30s warm-up due to/);
    expect(body).toMatch(/`cache-control: public, max-age=30`\):/);
    expect(body).toMatch(/- p50: < 25ms \(Cloudflare edge cache\)/);
    expect(body).toMatch(/- p90: < 60ms \(occasional miss on the 30s cache cycle\)/);
    expect(body).toMatch(/- p99: < 200ms \(cold-miss to origin \+ Postgres readiness check\)/);
    expect(body).toMatch(/If sustained p99 > 500ms during a status-target run, investigate:/);
    expect(body).toMatch(/- Is the Postgres readiness check timing out\? \(`COMPONENT_TIMEOUT_MS/);
    expect(body).toMatch(/= 1500`; if Postgres responds in > 1\.5s the readiness check returns/);
    expect(body).toMatch(/`degraded`\.\)/);
    expect(body).toMatch(
      /### Target: `sessions` \(POST \/v1\/sessions, auth required; staging only\)/,
    );
    expect(body).toMatch(/This run mutates state \(creates session rows\)\./);
    expect(body).toMatch(/Default duration: 30s/);
    expect(body).toMatch(/× 10 connections × 1 pipelining\./);
    expect(body).toMatch(/DRIFTSTACK_LOAD_TEST_API_KEY=ds_test_<staging-key>/);
    expect(body).toMatch(/node scripts\/load-test\/run\.mjs --target=sessions --env=staging/);
    expect(body).toMatch(/--duration=30 --connections=5/);
    expect(body).toMatch(/Cleanup: every session created during a load run lands in the/);
    expect(body).toMatch(/staging Neon project\. Delete via the dashboard or/);
    expect(body).toMatch(/`DELETE \/v1\/sessions\/<id>` post-run; truncate/);
    expect(body).toMatch(/`apps\/server\/src\/db\/schema\.ts::sessions` rows where/);
    expect(body).toMatch(/`label = 'load-test'` if the count exceeds 1000\./);
    expect(body).toMatch(/### Trend tracking/);
    expect(body).toMatch(
      /Per-run summaries land at `docs\/load-test\/baselines\/<YYYY-MM-DD>-<target>\.json`\./,
    );
    expect(body).toMatch(/Quarterly review compares `p50 \/ p99 \/ max` deltas — sustained/);
    expect(body).toMatch(/regression > 25% on p99 triggers a perf investigation slice\./);
    expect(body).toMatch(/## Related/);
    expect(body).toMatch(
      /- \[DR runbook\]\(\/docs\/deployment\/dr-runbook\.md\) — recovery procedures/,
    );
    expect(body).toMatch(/- \[Slow-query log\]\(\/docs\/deployment\/env-vars\.md\) —/);
    expect(body).toMatch(/`SLOW_QUERY_LOG_THRESHOLD_MS` correlates with elevated p99\./);
    expect(body).toMatch(
      /- \[Status endpoint\]\(\/docs\/architecture\/status-architecture\.md\) —/,
    );
    expect(body).toMatch(/the `\/v1\/status` source-of-truth for component readiness\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
