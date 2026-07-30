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

// `use-crypto-checkout.ts` is deliberately EXCLUDED from the humanizeError
// sweep below. `cc61bee72` "fix(gui): recover uncertain crypto checkouts"
// changed its failure model: a thrown transport/decoder failure on a PAYMENT
// mutation must not be reported as a plain error at all, because the checkout
// may well have been created server-side. It resolves to `outcome_unknown`
// with fixed, safety-correct copy instead. That is a stronger guarantee than
// humanizing the throw, so the hook is pinned separately below.
const HUMANIZED_HOOKS = HOOKS.filter((file) => file !== 'use-crypto-checkout.ts');

describe('GUI hook transport error copy', () => {
  it.each(HUMANIZED_HOOKS)('%s humanizes thrown transport/decoder failures', (file) => {
    const source = readFileSync(resolve(LIB, file), 'utf8');
    expect(source).toContain("from './humanize-error'");
    expect(source).toMatch(/humanizeError\(err, ["']/);
    expect(source).not.toMatch(/err instanceof Error\s*\?\s*err\.message\s*:\s*String\(err\)/);
  });

  it('use-crypto-checkout.ts resolves a thrown failure to outcome_unknown with fixed copy, never a raw error string', () => {
    const source = readFileSync(resolve(LIB, 'use-crypto-checkout.ts'), 'utf8');
    // The catch branch marks the attempt ambiguous and resolves it as
    // outcome_unknown — it never derives customer copy from the throw.
    expect(source).toMatch(
      /\} catch \{[\s\S]*?attempt\.ambiguous = true;\s*\n\s*attempt\.resolution = \{ kind: 'outcome_unknown' \};/,
    );
    // The two customer-visible strings are fixed constants, and both tell the
    // customer the charge state is UNCONFIRMED rather than failed.
    expect(source).toMatch(
      /const OUTCOME_UNKNOWN_MESSAGE =\s*\n\s*"We couldn't confirm whether this checkout was created\. Retry the same checkout to restore its result safely\.";/,
    );
    expect(source).toMatch(/const REPLAY_WINDOW_EXPIRED_MESSAGE =/);
    expect(source).toMatch(/safe replay window has expired/);
    // No raw-throw copy path may reappear.
    expect(source).not.toMatch(/err instanceof Error\s*\?\s*err\.message\s*:\s*String\(err\)/);
    expect(source).not.toMatch(/message: String\(err\)/);
  });
});
