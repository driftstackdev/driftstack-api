// W328.A — drift guard for /webhooks/replay page. Pins the
// canonical replay endpoint citation and matches it to the live
// server registration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W328.A /webhooks/replay ↔ route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page cites POST /v1/webhook-deliveries/:deliveryId/replay', () => {
    expect(page).toMatch(/POST\s+\/v1\/webhook-deliveries\/:deliveryId\/replay/);
  });

  it('server registers /v1/webhook-deliveries/:deliveryId/replay', () => {
    expect(route).toContain("'/v1/webhook-deliveries/:deliveryId/replay'");
  });

  it('page mentions DLQ context (the typical replay path)', () => {
    expect(page).toMatch(/DLQ/i);
  });
});
