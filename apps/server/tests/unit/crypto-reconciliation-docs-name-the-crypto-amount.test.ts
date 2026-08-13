// The crypto payment reconciliation is described in the same units it compares.
//
// A NOWPayments order carries two amounts that look interchangeable and are not.
// `price_amount` is FIAT — what the customer owes in dollars. `pay_amount` is
// CRYPTO — what they owe in the chain asset the quote was minted in. The IPN's
// `actually_paid` is in the crypto unit, so it reconciles against `pay_amount`
// and never against `price_amount`.
//
// Comparing them is not a hypothetical mistake. It shipped, and the fix's own
// inline note records the symptom: comparing against the fiat figure "left every
// full payment stuck 'partial'" — customers paid in full and did not get the
// tier they bought. The code was corrected; the tolerance constant's JSDoc was
// not, and went on describing the check as `actually_paid >= price_amount`. A
// description of the defect, sitting directly above the constant that implements
// the fix, is how someone "corrects" working code back into the bug.
//
// So this asserts the units agree wherever the reconciliation is DESCRIBED, not
// only where it is performed. `crypto-orders-amount-reconciliation` already
// covers the behaviour thoroughly — full pay, half pay, IPN-omitted amount — and
// `services-crypto-orders-content-parity` pins the comparison expression itself.
// Neither reads the prose, which is precisely where the stale claim survived.
//
// The rule is narrow on purpose: near a mention of `actually_paid`, the fiat
// field may be named only to say it is NOT the comparison. Anything else is the
// unit error being asserted as the design.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const SERVICE = resolve(SERVER_SRC, 'services', 'crypto-orders.ts');

/** Phrases that assert the comparison is against the FIAT amount. */
const UNIT_ERROR_CLAIMS = [
  /actually_paid\s*>=\s*price_amount/,
  /actually_paid\s*<\s*price_amount/,
  /fraction of price_amount/,
  /reconcile[^.\n]{0,40}against[^.\n]{0,20}price_amount/i,
];

describe('the crypto reconciliation is documented in the units it compares', () => {
  it('CRITICAL the file was read and still contains the reconciliation. Every assertion below reports the ABSENCE of a wrong phrase, and an absent file has no wrong phrases in it — the check would pass having read nothing.', () => {
    const src = readFileSync(SERVICE, 'utf8');
    expect(src.length, 'crypto-orders service source length').toBeGreaterThan(1000);
    expect(src, 'the tolerance constant is still here').toContain(
      'AMOUNT_RECONCILE_TOLERANCE_FRACTION',
    );
    expect(src, 'and the comparison it feeds').toContain('args.actually_paid < minAccepted');

    // Both amounts are still distinguished in this file at all — if the fiat
    // field vanished entirely the assertions below would pass vacuously.
    expect(src, 'the fiat amount is still referenced somewhere').toContain('price_amount');
    expect(src, 'as is the crypto amount').toContain('pay_amount');
  });

  it('CRITICAL no comment claims the reconciliation compares against the FIAT amount. That claim is the shipped bug restated as the design — it left every full payment stuck in partial, and it sat above the constant implementing the fix for as long as the fix existed.', () => {
    const src = readFileSync(SERVICE, 'utf8');
    const claims = UNIT_ERROR_CLAIMS.filter((re) => re.test(src)).map((re) => re.source);
    expect(claims, 'phrase(s) describing the comparison as against price_amount:').toEqual([]);
  });

  it('CRITICAL the tolerance constant documents the crypto amount by name. Absence of the wrong field is not presence of the right one — a JSDoc trimmed to say nothing would satisfy the arm above while telling the next reader nothing about which unit is compared.', () => {
    const src = readFileSync(SERVICE, 'utf8');
    // Anchored BACKWARDS from the declaration, because the obvious forward
    // anchor is not unique: an interface field earlier in the file opens its
    // JSDoc with the identical "Billing-integrity (amount reconciliation)"
    // phrase. Slicing forward from the first match spanned several hundred
    // unrelated lines, which of course contained both words this arm looks for —
    // it passed while inspecting none of the text it names.
    const decl = src.indexOf('const AMOUNT_RECONCILE_TOLERANCE_FRACTION');
    expect(decl, 'the tolerance declaration was located').toBeGreaterThan(-1);
    const open = src.lastIndexOf('/**', decl);
    expect(open, 'and the JSDoc immediately above it').toBeGreaterThan(-1);
    const jsdoc = src.slice(open, decl);
    expect(jsdoc.length, 'the slice is one comment, not a swathe of file').toBeLessThan(1500);
    expect(jsdoc, 'the tolerance JSDoc names pay_amount').toContain('pay_amount');
    expect(jsdoc.toUpperCase(), 'and says the amounts are crypto-denominated').toContain('CRYPTO');
  });
});
