// 1-hour soak at 30 RPS. Memory-leak detector: compares first-quarter
// average RSS against last-quarter average. Fails if growth > 1.5×.

import { evaluatePass, parseArgs, printSummary, runScenario } from './_harness.js';

const { durationOverride } = parseArgs();
const durationSec = durationOverride ?? 3600;
const connections = 6; // 30 RPS / 5 req/s avg per connection

async function main(): Promise<void> {
  const result = await runScenario({
    name: 'soak-30rps',
    durationSec,
    connections,
    sampleEverySec: 60,
    requests: ({ bearer, sessionId }) => [
      {
        method: 'POST' as const,
        path: `/v1/sessions/${sessionId}/navigate`,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      },
      {
        method: 'GET' as const,
        path: `/v1/sessions/${sessionId}/state`,
        headers: { authorization: `Bearer ${bearer}` },
      },
    ],
  });

  printSummary(result);

  const { pass, reasons } = evaluatePass(result, {
    maxP99Ms: 500,
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
