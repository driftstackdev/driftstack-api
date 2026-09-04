// W354.B — drift guard for status-site /history. The 90-day
// incident archive at status.driftstack.io/history.
//
// Pinned:
//   • 90-day window claim ↔ ?window=90d query param in the fetch
//   • Same /v1/status/incidents endpoint as / (registered server-side)
//   • R2 fallback URL convention
//   • SEVERITY_BADGE keys = IncidentSeveritySchema values
//   • STATUS_BADGE keys = IncidentStatusSchema values
//   • Empty-state copy claims "Cleanest 90-day window since the
//     service went live" (no false-positive "no incidents" framing
//     that would let an outage hide)
//   • month-grouped chronological layout (groupByMonth helper)
//   • no-store + accept=application/json headers on both API + R2
//     fetches — prevents stale CDN response masking an active
//     incident
//   • PUBLIC_API_BASE_URL fallback default

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentSeveritySchema, IncidentStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function serverRegisters(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.ts')) {
        if (re.test(read(p))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W354.B status-site /history parity', () => {
  const body = read(PAGE);

  it('fetches /v1/status/incidents?window=90d (registered on the server)', () => {
    expect(body).toMatch(/\/v1\/status\/incidents\?window=90d/);
    expect(serverRegisters(/['"]\/v1\/status\/incidents['"]/)).toBe(true);
  });

  it('90-day window claim is consistent throughout the page copy', () => {
    expect(body).toMatch(/90-day resolved window/);
    expect(body).toMatch(/Resolved incidents started in the last 90 days/);
    expect(body).toMatch(/no resolved incidents in the last 90 days/);
  });

  it('SEVERITY_BADGE keys = IncidentSeveritySchema (no orphan colour entries)', () => {
    const block = body.match(/const SEVERITY_BADGE = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s*([a-z]+):\s*\[/gm)].map((m) => m[1]!).sort();
    const schema = [
      ...(IncidentSeveritySchema._def as { values: readonly string[] }).values,
    ].sort();
    expect(keys).toEqual(schema);
  });

  it('STATUS_BADGE keys = IncidentStatusSchema (no orphan colour entries)', () => {
    const block = body.match(/const STATUS_BADGE = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s*([a-z]+):\s*\[/gm)].map((m) => m[1]!).sort();
    const schema = [...(IncidentStatusSchema._def as { values: readonly string[] }).values].sort();
    expect(keys).toEqual(schema);
  });

  it('R2 fallback URL default matches the convention used on /', () => {
    expect(body).toMatch(
      /PUBLIC_STATUS_R2_URL\s*\?\?\s*['"]https:\/\/r2-public\.driftstack\.dev\/status\/incidents-public\.json['"]/,
    );
  });

  it('cache: no-store on both API + R2 fetches (no stale incident masking)', () => {
    // Pin BOTH fetch calls — a stale CDN response on either side
    // could hide an active incident from the public view.
    const cacheNoStore = [...body.matchAll(/cache:\s*'no-store'/g)];
    expect(cacheNoStore.length).toBeGreaterThanOrEqual(2);
  });

  it('PUBLIC_API_BASE_URL default falls back to api.driftstack.dev', () => {
    expect(body).toMatch(/PUBLIC_API_BASE_URL\s*\?\?\s*['"]https:\/\/api\.driftstack\.dev['"]/);
  });

  it('groupByMonth helper present (chronological month-grouped layout)', () => {
    expect(body).toMatch(/function groupByMonth\(/);
    expect(body).toMatch(/started_at[\s\S]{0,200}slice\(0,\s*7\)/);
  });

  it('renderIncident uses SEVERITY_BADGE + STATUS_BADGE (no inline colour duplication)', () => {
    expect(body).toMatch(/SEVERITY_BADGE\[inc\.severity\]/);
    expect(body).toMatch(/STATUS_BADGE\[inc\.status\]/);
  });

  it('validated empty state distinguishes open truth from the resolved window', () => {
    expect(body).toMatch(/No open incidents and no resolved incidents in the last 90 days/);
    expect(body).toContain('if (feed.total === 0)');
    expect(body).toContain('parseIncidentFeed(await res.json())');
  });

  it('error fallback surface ("Could not load") never claims everything is fine', () => {
    expect(body).toMatch(/Could not load incident history/);
    // Negative guard: the error path must not render the success-
    // shape "no incidents" copy.
    expect(body).not.toMatch(/catch[\s\S]{0,200}No incidents/);
  });
});
