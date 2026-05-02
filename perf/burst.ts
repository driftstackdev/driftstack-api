// Burst 1000 RPS for `--duration` seconds (default 60).
// GET-heavy: stresses Fastify ↔ Postgres connection pool and Redis Lua hot
// path. Pass criteria: no 5xx; p99 may degrade to ≤ 1 s.

import { evaluatePass, parseArgs, printSummary, runScenario } from './_harness.js';

const { durationOverride } = parseArgs();
const durationSec = durationOverride ?? 60;
const connections = 200; // 1000 RPS / 5 req/s avg per connection

async function main(): Promise<void> {
  const result = await runScenario({
    name: 'burst-1000rps',
    durationSec,
    connections,
    sampleEverySec: 5,
    // Enterprise tier — global rate limit is 60k capacity / 1000 rps refill,
    // matched to the burst target. Lower tiers exhaust their bucket in
    // seconds at 1000 RPS.
    seedTier: 'enterprise',
    // autocannon takes `baseUrl` at the top level; per-request entries use
    // `path`, not `url`. (V-010 captures the empirical finding that drove this.)
    requests: ({ bearer, sessionId }) => [
      {
        method: 'GET' as const,
        path: `/v1/sessions/${sessionId}/state`,
        headers: { authorization: `Bearer ${bearer}` },
      },
      {
        method: 'GET' as const,
        path: `/v1/sessions`,
        headers: { authorization: `Bearer ${bearer}` },
      },
    ],
  });

  printSummary(result);

  const { pass, reasons } = evaluatePass(result, {
    maxP99Ms: 1000,
    max5xx: 0,
    maxRssGrowthFactor: 1.5,
  });

  if (!pass) {
    console.error(`\nFAIL: ${reasons.join('; ')}`);
    process.exit(1);
  }
  console.warn('\nPASS');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
