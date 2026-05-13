// W579 — drift guard for /docs/load-test/baselines/2026-05-10-status.json.
// V-495 load-test baseline empirical artifact: 30-second autocannon
// run against the staging /v1/status endpoint. Drift here means a
// new baseline was captured without going through the V-log entry
// + autocannon-harness invocation — the JSON should change only
// alongside a corresponding methodology-side V-NNN entry.
//
//   • V-495. Staging baseline 2026-05-10.
//   • Target: status / staging / /v1/status / GET.
//   • Profile: 30s wallclock × 10 connections × pipelining 1.
//   • 7209 requests sustained / p99 260 req/s / p50 241 req/s.
//   • Latency p50 35ms / p90 44ms / p99 121ms / max 138ms.
//   • Zero-error envelope (errors 0 / timeouts 0 / non_2xx 0).
//   • Wallclock window 2026-05-10T16:01:01.859Z → :31.939Z.
//
// Closes the docs/ parity-sweep run (W538 → W579 every file
// under docs/ pinned).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/load-test/baselines/2026-05-10-status.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

interface BaselineShape {
  target: string;
  env: string;
  url: string;
  method: string;
  duration_seconds: number;
  connections: number;
  pipelining: number;
  requests: {
    total: number;
    per_sec_avg: number;
    per_sec_p50: number;
    per_sec_p99: number;
  };
  latency_ms: {
    avg: number;
    p50: number;
    p90: number;
    p99: number;
    max: number;
  };
  throughput_bytes: {
    avg: number;
    total: number;
  };
  errors: number;
  timeouts: number;
  non_2xx: number;
  started_at: string;
  finished_at: string;
}

describe('W579 /docs/load-test/baselines/2026-05-10-status.json content parity', () => {
  const raw = read(LIB);
  const parsed = JSON.parse(raw) as BaselineShape;

  it('Target + env + URL + method + autocannon-profile (30s × 10 conn × pipelining 1) framing pinned', () => {
    expect(parsed.target).toBe('status');
    expect(parsed.env).toBe('staging');
    expect(parsed.url).toBe('https://staging.driftstack.dev/v1/status');
    expect(parsed.method).toBe('GET');
    expect(parsed.duration_seconds).toBe(30);
    expect(parsed.connections).toBe(10);
    expect(parsed.pipelining).toBe(1);
  });

  it('Request-rate buckets pinned: 7209 total + p50 241 + p99 260 + avg 240.3 req/sec sustained over 30s window', () => {
    expect(parsed.requests.total).toBe(7209);
    expect(parsed.requests.per_sec_avg).toBe(240.3);
    expect(parsed.requests.per_sec_p50).toBe(241);
    expect(parsed.requests.per_sec_p99).toBe(260);
  });

  it('Latency p50 35ms + p90 44ms + p99 121ms + max 138ms + avg 41.17ms pinned + throughput 344763.74 avg / 10343204 total pinned', () => {
    expect(parsed.latency_ms.avg).toBe(41.17);
    expect(parsed.latency_ms.p50).toBe(35);
    expect(parsed.latency_ms.p90).toBe(44);
    expect(parsed.latency_ms.p99).toBe(121);
    expect(parsed.latency_ms.max).toBe(138);
    expect(parsed.throughput_bytes.avg).toBe(344763.74);
    expect(parsed.throughput_bytes.total).toBe(10343204);
  });

  it('Zero-error envelope pinned: errors 0 + timeouts 0 + non_2xx 0 + 2026-05-10T16:01:01.859Z → :31.939Z wallclock window', () => {
    expect(parsed.errors).toBe(0);
    expect(parsed.timeouts).toBe(0);
    expect(parsed.non_2xx).toBe(0);
    expect(parsed.started_at).toBe('2026-05-10T16:01:01.859Z');
    expect(parsed.finished_at).toBe('2026-05-10T16:01:31.939Z');
  });

  it('Raw JSON pins exact key order + 2-space indentation + trailing newline (drift in serialisation indicates a non-autocannon writer)', () => {
    expect(raw.startsWith('{\n  "target": "status",\n')).toBe(true);
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toMatch(
      /"started_at": "2026-05-10T16:01:01\.859Z",\n {2}"finished_at": "2026-05-10T16:01:31\.939Z"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
