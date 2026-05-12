// W251.C — drift-guard for admin-panel pages. Every `/v1/admin/...`
// path the panel POSTs/GETs to must be a server-registered route.
// Mirrors W251.A for the customer dashboard.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PANEL_PAGES = resolve(REPO_ROOT, 'apps/admin-panel/src/pages');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}

describe('W251.C admin-panel page ↔ server-admin-route parity', () => {
  const pageFiles = walk(PANEL_PAGES, ['.astro']);
  const pageBlob = pageFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const serverFiles = walk(SERVER_SRC, ['.ts']);
  const serverBlob = serverFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  it('every /v1/admin path the panel calls is registered server-side', () => {
    // Pull every fetch(apiBaseUrl + '/v1/admin/...') from the panel
    // and any /v1/admin/... reference in the page bodies.
    const panelPaths = new Set<string>();
    for (const m of pageBlob.matchAll(/['"](\/v1\/admin\/[A-Za-z0-9:_./*-]+)['"]/g)) {
      let raw = m[1]!;
      // Drop query strings from URLs the page concats.
      raw = raw.replace(/\?.*$/, '');
      // Normalise template-style id placeholders to :p.
      raw = raw
        .replace(/'\s*\+\s*encodeURIComponent\([^)]+\)\s*\+\s*'/g, ':p')
        .replace(/\$\{[^}]+\}/g, ':p')
        .replace(/(?::p)+/g, ':p')
        .replace(/\/$/, '');
      // Skip narrative mentions ending with /:id (not a literal fetch).
      if (raw.endsWith('/:id') || raw.endsWith('/:order_id') || raw.endsWith('/:account_id'))
        continue;
      panelPaths.add(raw);
    }

    const serverPaths = new Set<string>();
    for (const m of serverBlob.matchAll(/['"](\/v1\/admin\/[A-Za-z0-9:_./*-]+)['"]/g)) {
      const raw = m[1]!;
      const normalized = raw.replace(/:[a-zA-Z_]+/g, ':p').replace(/\/$/, '');
      serverPaths.add(normalized);
    }

    const missing = [...panelPaths].filter((p) => !serverPaths.has(p));
    expect(missing).toEqual([]);
  });

  it('panel api-keys page revokes via /v1/admin/api-keys/:id/revoke', () => {
    expect(pageBlob).toMatch(/\/v1\/admin\/api-keys\/.*\/revoke/);
    expect(serverBlob).toMatch(/'\/v1\/admin\/api-keys\/:[a-z_]+\/revoke'/);
  });

  it('panel accounts page lists via /v1/admin/accounts', () => {
    expect(pageBlob).toContain('/v1/admin/accounts');
    expect(serverBlob).toContain(`'/v1/admin/accounts'`);
  });
});
