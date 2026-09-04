// W252.A — drift-guard for the public status site's API contract.
// Pins the three endpoints the page consumes
// (/v1/status/incidents + /v1/status/stream + R2 fallback) to the
// live server registration. A rename on the server side without
// updating the page would silently leave status.driftstack.io
// stuck on "Status currently unavailable".

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function serverRegisters(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
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

describe('W252.A status-site ↔ /v1/status route parity', () => {
  const page = read(PAGE);

  it('page fetches /v1/status/incidents (registered on the server)', () => {
    expect(page).toMatch(/\/v1\/status\/incidents/);
    expect(serverRegisters(/['"]\/v1\/status\/incidents['"]/)).toBe(true);
  });

  it('page consumes /v1/status/stream SSE (registered on the server)', () => {
    expect(page).toMatch(/\/v1\/status\/stream/);
    expect(serverRegisters(/['"]\/v1\/status\/stream['"]/)).toBe(true);
  });

  it('falls back to R2 snapshot when API is unreachable', () => {
    expect(page).toMatch(/R2_FALLBACK_URL/);
    expect(page).toMatch(/incidents-public\.json/);
  });

  it('subscribes to incident.created / incident.resolved SSE events', () => {
    expect(page).toMatch(/sse\.addEventListener\(['"]incident\.created['"]/);
    expect(page).toMatch(/sse\.addEventListener\(['"]incident\.resolved['"]/);
  });

  it('renders overall + per-incident severity badges via the documented enum', () => {
    // Severity values match the public schema (minor / major / outage).
    expect(page).toMatch(/SEVERITY_BADGE = \{[\s\S]*?minor:[\s\S]*?major:[\s\S]*?outage:/);
    // Status values match the public schema (investigating / identified / monitoring / resolved).
    expect(page).toMatch(/STATUS_BADGE = \{[\s\S]*?investigating:[\s\S]*?resolved:/);
  });

  it('safety-net polling fires at 60s when SSE drops', () => {
    expect(page).toMatch(/setInterval\(fetchAndRender,\s*60_000\)/);
  });
});
