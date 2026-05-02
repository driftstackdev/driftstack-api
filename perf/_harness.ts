// Shared harness for perf scenarios. Boots the same Fastify app as e2e,
// seeds one test account, drives load via autocannon, captures process
// metrics every N seconds, prints a structured summary.
//
// autocannon's CJS default-export typing doesn't resolve cleanly for
// typescript-eslint here; runtime usage is correct via NodeNext interop.
// Suppressing the false-positive lint at the file level.

/* eslint-disable @typescript-eslint/no-unsafe-call */

import autocannon from 'autocannon';
import { startTestServer, type TestServer } from '../apps/server/tests/e2e/helpers/server.js';
import { seedAccount } from '../apps/server/tests/e2e/helpers/seed.js';

export interface Scenario {
  name: string;
  durationSec: number;
  connections: number;
  /** Sample memory + ru_maxrss every N seconds during the run. */
  sampleEverySec: number;
  /** Tier to seed the test account with. Defaults to 'scale'. */
  seedTier?: 'free' | 'starter' | 'solo' | 'builder' | 'scale' | 'enterprise';
  /** Build the request set autocannon will round-robin across. */
  requests: (ctx: { baseUrl: string; bearer: string; sessionId: string }) => autocannon.Request[];
}

export interface ScenarioResult {
  name: string;
  durationActualMs: number;
  totalRequests: number;
  rps: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  errors: number;
  non2xx: number;
  statusCodes: Record<string, number>;
  memorySamples: MemorySample[];
}

export interface MemorySample {
  tSec: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  external: number;
}

interface AutocannonResult {
  duration: number;
  requests: { total: number };
  throughput: { mean: number };
  latency: { p50: number; p97_5: number; p99: number };
  errors: number;
  non2xx: number;
  '1xx': number;
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  console.warn(`\n[harness] booting test server…`);
  const server: TestServer = await startTestServer();
  await server.resetState();

  const tier = scenario.seedTier ?? 'scale';
  console.warn(`[harness] seeding test account (tier=${tier})…`);
  const seed = await seedAccount(server.client, { tier });

  console.warn(`[harness] creating warm-up session…`);
  const warmup = await fetch(`${server.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${seed.plaintext}`,
    },
    body: JSON.stringify({ label: 'perf-warmup' }),
  });
  if (warmup.status !== 201) {
    throw new Error(`warmup session create failed: ${warmup.status.toString()}`);
  }
  const sessionRaw = (await warmup.json()) as { id: string };

  const requests = scenario.requests({
    baseUrl: server.baseUrl,
    bearer: seed.plaintext,
    sessionId: sessionRaw.id,
  });

  const memorySamples: MemorySample[] = [];
  const start = process.hrtime.bigint();
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    const tSec = Number(process.hrtime.bigint() - start) / 1e9;
    memorySamples.push({
      tSec: Number(tSec.toFixed(2)),
      rssMb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
      heapTotalMb: Math.round((m.heapTotal / 1024 / 1024) * 10) / 10,
      external: Math.round((m.external / 1024 / 1024) * 10) / 10,
    });
  }, scenario.sampleEverySec * 1000);

  console.warn(
    `[harness] starting autocannon: ${scenario.name} ` +
      `(${scenario.connections.toString()} conns × ${scenario.durationSec.toString()}s)`,
  );

  const result = (await autocannon({
    url: server.baseUrl,
    connections: scenario.connections,
    duration: scenario.durationSec,
    requests,
    headers: { 'content-type': 'application/json' },
    forever: false,
  })) as unknown as AutocannonResult;

  clearInterval(sampler);
  console.warn(`[harness] cleanup…`);
  await server.cleanup();

  const summary: ScenarioResult = {
    name: scenario.name,
    durationActualMs: result.duration * 1000,
    totalRequests: result.requests.total,
    rps: Math.round(result.throughput.mean / 100) / 10, // rough KB/s? autocannon mean is bytes/s, we'll repurpose this elsewhere; use req/s computed below
    latencyP50Ms: result.latency.p50,
    latencyP95Ms: result.latency.p97_5,
    latencyP99Ms: result.latency.p99,
    errors: result.errors,
    non2xx: result.non2xx,
    statusCodes: {
      '1xx': result['1xx'],
      '2xx': result['2xx'],
      '3xx': result['3xx'],
      '4xx': result['4xx'],
      '5xx': result['5xx'],
    },
    memorySamples,
  };
  // The autocannon throughput.mean is bytes/s; compute the actual req/s from totals.
  summary.rps = Math.round((result.requests.total / result.duration) * 10) / 10;

  return summary;
}

export function parseArgs(): { durationOverride: number | null } {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--duration');
  if (idx >= 0 && args[idx + 1]) {
    const n = Number(args[idx + 1]);
    return { durationOverride: Number.isFinite(n) ? n : null };
  }
  return { durationOverride: null };
}

export function printSummary(result: ScenarioResult): void {
  console.warn('\n=== Result ===');
  console.warn(JSON.stringify(result, null, 2));
}

export interface PassCriteria {
  maxP99Ms: number;
  max5xx: number;
  /** Allowed memory growth as multiple of first-quarter avg RSS (e.g. 1.5 = 50% growth). */
  maxRssGrowthFactor: number;
}

export function evaluatePass(
  result: ScenarioResult,
  criteria: PassCriteria,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.latencyP99Ms > criteria.maxP99Ms) {
    reasons.push(`p99 ${result.latencyP99Ms.toString()}ms > max ${criteria.maxP99Ms.toString()}ms`);
  }
  if (result.statusCodes['5xx'] > criteria.max5xx) {
    reasons.push(
      `5xx count ${result.statusCodes['5xx']?.toString() ?? '?'} > max ${criteria.max5xx.toString()}`,
    );
  }
  if (result.memorySamples.length >= 8) {
    const q = Math.floor(result.memorySamples.length / 4);
    const firstAvg = avg(result.memorySamples.slice(0, q).map((s) => s.rssMb));
    const lastAvg = avg(result.memorySamples.slice(-q).map((s) => s.rssMb));
    if (lastAvg > firstAvg * criteria.maxRssGrowthFactor) {
      reasons.push(
        `RSS grew ${firstAvg.toString()}MB → ${lastAvg.toString()}MB ` +
          `(>${criteria.maxRssGrowthFactor.toString()}× threshold)`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.reduce((a, b) => a + b, 0);
  return Math.round((s / xs.length) * 10) / 10;
}
