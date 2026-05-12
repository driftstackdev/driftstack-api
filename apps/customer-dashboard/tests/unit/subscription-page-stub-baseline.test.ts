// W296.A — drift guard for customer-dashboard /subscription. The
// page is V-134 scaffolding — drilled-down plan history / detail
// view that's not yet wired to live data. Verify it still reads
// from MOCK_SUBSCRIPTION rather than accidentally pointing at a
// (non-existent) /v1/billing/state endpoint and rendering empty.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/subscription.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W296.A /subscription page stub baseline', () => {
  const body = read(PAGE);

  it('page imports MOCK_SUBSCRIPTION from the mocks data module', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bMOCK_SUBSCRIPTION\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/mocks/,
    );
  });

  it('plan-history entries use real AccountTier ids (no fictional tiers)', () => {
    const tiers = [...body.matchAll(/(?:from_tier|to_tier):\s*['"]([a-z_]+)['"]/g)].map(
      (m) => m[1]!,
    );
    const fictional = tiers.filter((t) => /team_growth|solo_pro|enterprise_plus/.test(t));
    expect(fictional).toEqual([]);
  });

  it('page is flagged as V-134 scaffolding in a comment', () => {
    // Don't let someone silently promote the stub to production wiring
    // without re-evaluating the scaffolding warning.
    expect(body).toMatch(/V-134/);
  });
});
