// W245.C — drift-guard for /legal/refunds. The page is the
// customer-facing refund policy. Pin the non-refundable crypto
// posture, the 14-day-no-usage window, and that no fictional tier
// names appear (consistent with W234 sla-policy).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'legal', 'refunds.md');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W245.C legal/refunds doc parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('asserts non-refundable crypto posture as a header section', () => {
    expect(doc).toMatch(/##\s*Crypto payments are non-refundable/);
    expect(doc).toMatch(/non-refundable/);
  });

  it('keeps the 14-day-no-usage refund window', () => {
    expect(doc).toMatch(/Within 14 days/);
  });

  it('does not reference fictional tier names', () => {
    // Same check as W234: any snake_case tier-like literal should be
    // in the live enum, ignoring known non-tier identifiers.
    const codeBlocks = Array.from(doc.matchAll(/`([a-z][a-z_]+)`/g)).map((m) => m[1]!);
    const tierLike = codeBlocks.filter((c) => c.includes('_'));
    const offenders = tierLike.filter(
      (c) =>
        !tiers.includes(c) &&
        ![
          'target_url',
          'support@driftstack.dev',
          'idempotency_key',
          'order_id',
          'payment_id',
        ].includes(c),
    );
    expect(offenders).toEqual([]);
  });

  it('cross-links to the SLA + cost-monitoring docs', () => {
    expect(doc).toMatch(/SLA/);
    expect(doc).toMatch(/cost-monitoring/);
  });

  it('keeps the Stripe vs NowPayments duplicate-charge clause', () => {
    expect(doc).toMatch(/Stripe \/ NowPayments/);
  });
});
