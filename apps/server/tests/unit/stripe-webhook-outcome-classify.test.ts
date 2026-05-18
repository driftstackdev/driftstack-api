// Arc 7 obs.8 — bounded-cardinality contract on the
// `driftstack_stripe_webhook_total{outcome}` Prometheus counter.
//
// classifyStripeDispatchOutcome maps the StripeWebhooksService
// dispatch result — which carries a dynamic `error:<reason>` tail —
// onto exactly 4 stable labels:
//
//   - handled    (event recognized + applied)
//   - duplicate  (V-080 idempotency replay)
//   - ignored    (event type not in our allowlist)
//   - error      (any `error:<reason>` collapses here)
//
// Why this matters: Prometheus counter cardinality is N(label_values).
// Letting the dynamic `error:invalid_signature_v2_for_test_account_42`
// tail through would make the counter unbounded — every fresh error
// reason creates a new time series. Pin the contract here.

import { describe, expect, it } from 'vitest';
import { classifyStripeDispatchOutcome } from '../../src/routes/webhooks-stripe.js';

describe('classifyStripeDispatchOutcome — bounded-cardinality contract', () => {
  it("'handled' passes through unchanged", () => {
    expect(classifyStripeDispatchOutcome('handled')).toBe('handled');
  });

  it("'duplicate' passes through unchanged (V-080 idempotency replay)", () => {
    expect(classifyStripeDispatchOutcome('duplicate')).toBe('duplicate');
  });

  it("'ignored' passes through unchanged (event type not in allowlist)", () => {
    expect(classifyStripeDispatchOutcome('ignored')).toBe('ignored');
  });

  it("any `error:<reason>` tail collapses to plain 'error' (no leakage of dynamic reason)", () => {
    expect(classifyStripeDispatchOutcome('error:invalid_signature')).toBe('error');
    expect(classifyStripeDispatchOutcome('error:body_too_large')).toBe('error');
    expect(classifyStripeDispatchOutcome('error:repo_write_failed')).toBe('error');
    // Reason with colons / spaces / variable text still collapses.
    expect(
      classifyStripeDispatchOutcome('error:idempotency_key_already_consumed_for_event_evt_1xyz'),
    ).toBe('error');
  });

  it("bare 'error' (no reason tail) also lands on 'error' — defensive coverage", () => {
    expect(classifyStripeDispatchOutcome('error')).toBe('error');
  });

  it("unknown outcome strings collapse to 'error' (defensive default)", () => {
    // Drift here would silently inflate cardinality if the service ever
    // adds a new outcome value without updating the classifier — better
    // to bucket-into-error than expose an unknown label.
    expect(classifyStripeDispatchOutcome('panic')).toBe('error');
    expect(classifyStripeDispatchOutcome('')).toBe('error');
    expect(classifyStripeDispatchOutcome('HANDLED')).toBe('error'); // case-sensitive
  });

  it('the only emitted label values are exactly the 4-string bounded set', () => {
    // Sweep a representative mix of inputs and assert the output is
    // always one of the 4. Locks the cardinality invariant.
    const inputs = [
      'handled',
      'duplicate',
      'ignored',
      'error',
      'error:foo',
      'error:bar baz',
      'panic',
      '',
      'HANDLED',
      'unknown_42',
    ];
    const allowed = new Set(['handled', 'duplicate', 'ignored', 'error']);
    for (const i of inputs) {
      const out = classifyStripeDispatchOutcome(i);
      expect(allowed.has(out), `outcome=${i} → ${out} (not in allowed set)`).toBe(true);
    }
  });
});
