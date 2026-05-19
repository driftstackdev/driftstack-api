// Cross-source invariant: webhook secret-rotation grace window is
// 24 hours, declared in 3 places — services/webhooks.ts graceMs
// default + docs/webhooks/endpoints.md customer-facing copy +
// docs implicit dual-sign window. Drift would either let customers
// drop deliveries during rotation (too short) or hold both
// signatures forever (too long).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const WEBHOOK_SVC = resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('webhook 24h-rotation-grace cross-source invariant', () => {
  const webhookSvc = read(WEBHOOK_SVC);
  const docs = read(DOCS);

  it('services/webhooks.ts default graceMs is 24 hours: 24 * 60 * 60 * 1000', () => {
    expect(webhookSvc).toMatch(
      /const graceMs = opts\.graceMs \?\? 24 \* 60 \* 60 \* 1000; \/\/ 24h default/,
    );
  });

  it("docs/webhooks/endpoints.md customer copy claims '24-hour grace period after a secret rotation' — pinned so the customer-facing claim matches the service-side default", () => {
    expect(docs).toMatch(/except during the 24-hour grace period after a secret rotation/);
  });

  it("docs/webhooks/endpoints.md customer copy explains dual-signing during grace: 'When non-null, Driftstack is dual-signing every outbound delivery (x-driftstack-signature + x-driftstack-signature-prev)' — pinned so the customer understands the rotation-grace mechanism", () => {
    expect(docs).toMatch(
      /When non-null, Driftstack is dual-signing every outbound\s*\n?\s*delivery \(`x-driftstack-signature` \+ `x-driftstack-signature-prev`\)/,
    );
  });
});
