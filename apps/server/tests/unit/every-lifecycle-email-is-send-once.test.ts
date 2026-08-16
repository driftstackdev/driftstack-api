// A billing email that can fire twice is a customer emailed twice about one
// payment.
//
// `processed_stripe_events` dedups a whole Stripe event, but it is written AFTER
// the handler's side effects — `handle()` runs `dispatch(event)` first and only
// then inserts the ledger row, resolving a concurrent delivery with the
// `inserted` flag. That ordering is deliberate and documented: the effects
// themselves are idempotent (upserts and tier RECOMPUTES, not increments), so a
// re-delivery heals rather than doubles.
//
// Emails are the exception. Sending is not an upsert. Two concurrent deliveries
// of one event both pass the `hasEvent` check, both dispatch, and both would
// send — so every send needs its own claim, and the schema comment for
// `billing_email_sends` (C6) says exactly that.
//
// Today all six sends in the lifecycle service are guarded, by three different
// mechanisms:
//
//   claimBillingEmail        INSERT … ON CONFLICT DO NOTHING RETURNING, keyed
//                            on (stripe_event_id, kind) — renewal reminder,
//                            receipt, failure
//   markFirst*EmailSent      UPDATE … WHERE column IS NULL returning `won` —
//                            the two first-session emails
//   a state-transition gate  tier-changed, gated in the CALLER on
//                            previousTier !== appliedTier, so a duplicate
//                            dispatch finds no transition and sends nothing
//
// Nothing enforced that. This does, so the seventh send has to choose one of
// them or say why it needs none. It reports no problem today — it fixes the
// state where the next one is added unnoticed on a money path.
//
// SCOPE, stated because it bounds the claim: this proves a claim is REACHED in
// the same method as the send, not that the claim is correct. The claim
// mechanisms themselves are covered elsewhere —
// `db-stripe-event-idempotency-drizzle` drives the real ON CONFLICT clause and
// asserts `inserted:false` on replay.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(HERE, '..', '..', 'src', 'services', 'account-lifecycle.ts');

/** `await this.email.sendX({` — the send itself. */
const SEND = /this\.email\.send(\w+)\s*\(/g;

/** Any race-safe claim-before-send: the caller only proceeds if it won. */
const CLAIM = /claimBillingEmail\s*\(|markFirst\w*EmailSent\s*\(/;

/**
 * Sends that are guarded somewhere other than their own method.
 *
 * An entry has to say WHERE the guard is, because "it is fine" is what this
 * file exists to stop being taken on trust.
 */
const GUARDED_ELSEWHERE: Record<string, string> = {
  TierChanged:
    'Gated in the caller, not here: stripe-webhooks only emits the lifecycle ' +
    'event when previousTier !== appliedTier. A duplicate dispatch finds the ' +
    'tier already applied, so there is no transition and no email. Verified at ' +
    'the emit site rather than inferred from the name.',
};

function serviceSource(): string {
  return readFileSync(SERVICE, 'utf-8');
}

/** Class methods, split on their 2-space-indented declarations. */
function methods(source: string): Array<{ name: string; body: string }> {
  const lines = source.split('\n');
  const starts: Array<{ index: number; name: string }> = [];
  lines.forEach((line, i) => {
    const m = /^ {2}(?:private |public |protected )?(?:async )?([a-zA-Z_]\w*)\s*[(<]/.exec(line);
    if (m?.[1] !== undefined && m[1] !== 'constructor') starts.push({ index: i, name: m[1] });
  });
  return starts.map((s, i) => ({
    name: s.name,
    body: lines
      .slice(s.index, i + 1 < starts.length ? starts[i + 1]!.index : lines.length)
      .join('\n'),
  }));
}

function sendsWithoutAClaim(): string[] {
  const offenders: string[] = [];
  for (const method of methods(serviceSource())) {
    const sends = [...method.body.matchAll(SEND)].map((m) => m[1] ?? '');
    if (sends.length === 0) continue;
    if (CLAIM.test(method.body)) continue;
    for (const send of sends) {
      if (GUARDED_ELSEWHERE[send] === undefined) offenders.push(`${method.name} -> send${send}`);
    }
  }
  return offenders.sort();
}

describe('every lifecycle email is send-once', () => {
  it('CRITICAL the scan finds the sends and the claims, so an absence is measured against a real set', () => {
    const source = serviceSource();
    const allSends = [...source.matchAll(SEND)].map((m) => m[1] ?? '');
    expect(
      allSends.length,
      'no email send found — the idiom changed or the pattern is broken',
    ).toBeGreaterThanOrEqual(6);
    expect(
      methods(source).length,
      'the method splitter found nothing — every send would then look unguarded',
    ).toBeGreaterThan(5);
    // The claim detector must be able to answer both ways, or the check below
    // is decided by the pattern rather than by the code.
    expect(CLAIM.test('const won = await this.repo.claimBillingEmail({'), 'claim not seen').toBe(
      true,
    );
    expect(
      CLAIM.test('await this.email.sendBillingReceipt({'),
      'claim detector says yes to anything',
    ).toBe(false);
  });

  it('CRITICAL a send is preceded by a claim in its own method, or is declared guarded elsewhere', () => {
    expect(
      sendsWithoutAClaim(),
      'these can fire twice for one Stripe event — two concurrent deliveries both pass hasEvent and ' +
        'both dispatch, and sending is not an upsert. Add a claimBillingEmail, or declare where the ' +
        'guard is',
    ).toEqual([]);
  });

  it('CRITICAL the elsewhere-guarded roster is not stale', () => {
    const source = serviceSource();
    const present = new Set([...source.matchAll(SEND)].map((m) => m[1] ?? ''));
    const gone = Object.keys(GUARDED_ELSEWHERE).filter((k) => !present.has(k));
    expect(
      gone,
      'declared for a send that no longer exists — an exemption exempting nothing reads as reviewed',
    ).toEqual([]);
  });
});
