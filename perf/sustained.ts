// Sustained 100 RPS for `--duration` seconds (default 300).
// Mixed workload approximating a realistic customer journey:
//   70% navigate/interact (write-side)
//   20% getState           (read-side)
//   10% session create / destroy

import { evaluatePass, parseArgs, printSummary, runScenario } from './_harness.js';

const { durationOverride } = parseArgs();
const durationSec = durationOverride ?? 300;
// 100 RPS target. autocannon picks the actual rate by saturating connections;
// we cap at 16 concurrent connections so each averages ~6 req/s.
const connections = 16;

async function main(): Promise<void> {
  const result = await runScenario({
    name: 'sustained-100rps',
    durationSec,
    connections,
    sampleEverySec: 5,
    requests: ({ bearer, sessionId }) => [
      // 70% write-side ops
      ...repeat(7, {
        method: 'POST' as const,
        path: `/v1/sessions/${sessionId}/navigate`,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      }),
      // 20% read-side ops
      ...repeat(2, {
        method: 'GET' as const,
        path: `/v1/sessions/${sessionId}/state`,
        headers: { authorization: `Bearer ${bearer}` },
      }),
      // 10% list (cheaper read)
      ...repeat(1, {
        method: 'GET' as const,
        path: `/v1/sessions`,
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ],
  });

  printSummary(result);

  const { pass, reasons } = evaluatePass(result, {
    maxP99Ms: 250,
    max5xx: 0,
    maxRssGrowthFactor: 1.5,
  });

  if (!pass) {
    console.error(`\nFAIL: ${reasons.join('; ')}`);
    process.exit(1);
  }
  console.warn('\nPASS');
}

function repeat<T>(n: number, x: T): T[] {
  return Array.from({ length: n }, () => x);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
