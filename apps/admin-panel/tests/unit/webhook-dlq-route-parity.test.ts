// W309.C — drift guard for admin /webhook-dlq page. The page hits
//   GET  /v1/admin/webhook-dlq
//   POST /v1/admin/webhook-dlq/:id/requeue
// Both must be registered in the server's admin-webhooks route file.
// The page narrative also pins requeue semantics (attempt resets,
// retry budget refresh, audit row).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/webhook-dlq.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W309.C admin /webhook-dlq ↔ admin-webhooks route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page references the DLQ list endpoint', () => {
    expect(page).toContain('/v1/admin/webhook-dlq');
  });

  it('page references the requeue endpoint', () => {
    expect(page).toMatch(/\/v1\/admin\/webhook-dlq\/[^'"`]*requeue/);
  });

  it('server registers GET /v1/admin/webhook-dlq', () => {
    expect(route).toContain("'/v1/admin/webhook-dlq'");
  });

  it('server registers POST /v1/admin/webhook-dlq/:id/requeue', () => {
    expect(route).toContain("'/v1/admin/webhook-dlq/:id/requeue'");
  });

  it('page narrative describes the requeue semantics (attempt reset + retry budget refresh)', () => {
    expect(page).toMatch(/attempt\s*=\s*1/);
    expect(page).toMatch(/retry budget/i);
  });

  it('page narrative confirms an admin audit row is written on requeue', () => {
    expect(page).toMatch(/[Aa]udit row records/);
  });
});
