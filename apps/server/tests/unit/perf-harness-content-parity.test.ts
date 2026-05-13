// W613 — drift guard for perf/ harness (5 modules).
// Phase 9 performance + memory-leak harness.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `perf/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W613 perf/ harness content parity', () => {
  it('_harness.ts: shared scenario harness + Fastify-app-same-as-e2e + one-test-account seed + autocannon load + N-second process-metric sampling + structured summary print + Scenario interface pinned', () => {
    const body = read(P('_harness.ts'));
    expect(body).toMatch(
      /^\/\/ Shared harness for perf scenarios\. Boots the same Fastify app as e2e,$/m,
    );
    expect(body).toMatch(
      /^\/\/ seeds one test account, drives load via autocannon, captures process$/m,
    );
    expect(body).toMatch(/^\/\/ metrics every N seconds, prints a structured summary\.$/m);
    expect(body).toMatch(
      /^\/\/ autocannon's CJS default-export typing doesn't resolve cleanly for$/m,
    );
    expect(body).toMatch(
      /^\/\/ typescript-eslint here; runtime usage is correct via NodeNext interop\./m,
    );
    expect(body).toMatch(/^\/\* eslint-disable @typescript-eslint\/no-unsafe-call \*\/$/m);
    expect(body).toMatch(/^import autocannon from 'autocannon';$/m);
    expect(body).toMatch(
      /^import \{ startTestServer, type TestServer \} from '\.\.\/apps\/server\/tests\/e2e\/helpers\/server\.js';$/m,
    );
    expect(body).toMatch(
      /^import \{ seedAccount \} from '\.\.\/apps\/server\/tests\/e2e\/helpers\/seed\.js';$/m,
    );
    expect(body).toMatch(/^export interface Scenario \{$/m);
    expect(existsSync(P('_harness.ts'))).toBe(true);
  });

  it('burst.ts: 1000 RPS burst for --duration (default 60s) + GET-heavy stresses Fastify↔Postgres pool + Redis Lua hot path + pass criteria (no 5xx; p99 ≤ 1s) + 200 connections (1000 RPS / 5 req/s avg) pinned', () => {
    const body = read(P('burst.ts'));
    expect(body).toMatch(/^\/\/ Burst 1000 RPS for `--duration` seconds \(default 60\)\.$/m);
    expect(body).toMatch(
      /^\/\/ GET-heavy: stresses Fastify ↔ Postgres connection pool and Redis Lua hot$/m,
    );
    expect(body).toMatch(/^\/\/ path\. Pass criteria: no 5xx; p99 may degrade to ≤ 1 s\.$/m);
    expect(body).toMatch(
      /^import \{ evaluatePass, parseArgs, printSummary, runScenario \} from '\.\/_harness\.js';$/m,
    );
    expect(body).toMatch(/^const durationSec = durationOverride \?\? 60;$/m);
    expect(body).toMatch(
      /^const connections = 200; \/\/ 1000 RPS \/ 5 req\/s avg per connection$/m,
    );
    expect(body).toMatch(/name: 'burst-1000rps',/);
    expect(existsSync(P('burst.ts'))).toBe(true);
  });

  it('soak.ts: 1-hour soak at 30 RPS + memory-leak detector + first-quarter avg RSS vs last-quarter avg + fail-if-growth>1.5× + 60s sampleEverySec + 6 connections (30 RPS / 5 req/s avg) pinned', () => {
    const body = read(P('soak.ts'));
    expect(body).toMatch(
      /^\/\/ 1-hour soak at 30 RPS\. Memory-leak detector: compares first-quarter$/m,
    );
    expect(body).toMatch(
      /^\/\/ average RSS against last-quarter average\. Fails if growth > 1\.5×\.$/m,
    );
    expect(body).toMatch(/^const durationSec = durationOverride \?\? 3600;$/m);
    expect(body).toMatch(/^const connections = 6; \/\/ 30 RPS \/ 5 req\/s avg per connection$/m);
    expect(body).toMatch(/name: 'soak-30rps',/);
    expect(body).toMatch(/sampleEverySec: 60,/);
    expect(existsSync(P('soak.ts'))).toBe(true);
  });

  it('sustained.ts: 100 RPS for --duration (default 300s) + mixed workload customer-journey approximation (70% navigate/interact write + 20% getState read + 10% session create/destroy) + 16 concurrent connections cap pinned', () => {
    const body = read(P('sustained.ts'));
    expect(body).toMatch(/^\/\/ Sustained 100 RPS for `--duration` seconds \(default 300\)\.$/m);
    expect(body).toMatch(/^\/\/ Mixed workload approximating a realistic customer journey:$/m);
    expect(body).toMatch(/^\/\/\s+70% navigate\/interact \(write-side\)$/m);
    expect(body).toMatch(/^\/\/\s+20% getState\s+\(read-side\)$/m);
    expect(body).toMatch(/^\/\/\s+10% session create \/ destroy$/m);
    expect(body).toMatch(/^const durationSec = durationOverride \?\? 300;$/m);
    expect(body).toMatch(
      /^\/\/ 100 RPS target\. autocannon picks the actual rate by saturating connections;$/m,
    );
    expect(body).toMatch(
      /^\/\/ we cap at 16 concurrent connections so each averages ~6 req\/s\.$/m,
    );
    expect(body).toMatch(/^const connections = 16;$/m);
    expect(existsSync(P('sustained.ts'))).toBe(true);
  });

  it('README.md: Phase 9 perf+memory-leak harness + 3-scenario table (sustained 100RPS-5min / burst 1000RPS-60s / soak 30RPS-1h memory-leak detector with 60s RSS samples + first-vs-last quarter comparison) pinned', () => {
    const body = read(P('README.md'));
    expect(body).toMatch(/^# Perf harness$/m);
    expect(body).toMatch(
      /Phase 9 performance \+ memory-leak harness\. All scripts boot the same Fastify app the e2e suite uses/,
    );
    expect(body).toMatch(/`autocannon`/);
    expect(body).toMatch(/^## Scenarios$/m);
    expect(body).toMatch(
      /\| `perf\/sustained\.ts` \| 100 RPS mixed read\/write \| 5 min default \| does the API hold a sustained load with no degradation/,
    );
    expect(body).toMatch(
      /\| `perf\/burst\.ts`\s+\| 1000 RPS GET-heavy\s+\| 60 s default\s+\| does the API survive a burst/,
    );
    expect(body).toMatch(
      /\| `perf\/soak\.ts`\s+\| 30 RPS mixed\s+\| 1 h default\s+\| memory-leak detector\. RSS \/ heap \/ fd snapshotted every 60 s; first-quarter avg vs last-quarter avg compared/,
    );
    expect(body).toMatch(/^## Running$/m);
    expect(existsSync(P('README.md'))).toBe(true);
  });
});
