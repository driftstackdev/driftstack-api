import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, '..', '..', 'src', 'lib');
const HOOKS = [
  'use-account-me.ts',
  'use-account-cost.ts',
  'use-sessions-list.ts',
  'use-webhooks-list.ts',
  'use-crypto-quote.ts',
  'use-crypto-orders-list.ts',
  'use-crypto-order.ts',
  'use-crypto-receipt.ts',
  'use-crypto-checkout.ts',
  'use-cancel-order.ts',
  'use-receipt-pdf-download.ts',
  'use-admin-csv-export.ts',
  'use-admin-crypto-stats.ts',
  'use-admin-crypto-daily.ts',
  'use-admin-order-events.ts',
  'use-admin-internal-note.ts',
  'use-admin-crypto-orders-list.ts',
  'use-admin-idempotency-metrics.ts',
  'use-admin-crypto-pending-age.ts',
] as const;

describe('GUI hook transport error copy', () => {
  it.each(HOOKS)('%s humanizes thrown transport/decoder failures', (file) => {
    const source = readFileSync(resolve(LIB, file), 'utf8');
    expect(source).toContain("from './humanize-error'");
    expect(source).toMatch(/humanizeError\(err, ["']/);
    expect(source).not.toMatch(/err instanceof Error\s*\?\s*err\.message\s*:\s*String\(err\)/);
  });
});
