// W504.C — drift guard for apps/marketing-site/src/pages/legal/refunds.md.
// Refund Policy v1.0 — drift here either breaks a refund-eligibility
// commitment (would expose to legal/consumer-protection pushback) or
// changes the crypto-non-refundable posture (would create operational
// risk if customers expect on-chain refunds that NowPayments can't
// reliably issue).
//
//   • Version 1.0 effective 2026-05-11 + Terms section 8.7 anchor.
//   • 4-scenario refund eligibility: Failed delivery / Service failure
//     SLA / 14-day no-usage / Mistaken duplicate.
//   • 4-scenario refund DENIAL: Mid-cycle cancel / Tier downgrade /
//     Usage exceeded expectations / Trial pack credit expiry.
//   • Card refund mechanics: support@ → Stripe → 5–10 business days.
//   • Crypto-non-refundable: settlement irreversibility + fraud
//     asymmetry + operational simplicity 3-rationale.
//   • SLA credit default (next-invoice) + cash-on-cancel option.
//   • Dispute escalation: 5-business-day response + chargeback path.
//   • 30-day material-change notice.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W504.C apps/marketing-site/src/pages/legal/refunds.md content parity', () => {
  const body = read(LIB);

  it('Version 1.0 + effective 2026-05-11 + Terms section 8.7 anchor — pinned so the version-tracked policy + the Terms-§8.7-cross-reference both survive (drift to dropping the version header would let the policy drift without a tracked version; drift to dropping the §8.7 anchor would orphan the binding contractual statement from the operational expansion)', () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.0 · \*\*Effective:\*\* 2026-05-11/);
    expect(body).toMatch(
      /incorporated into the \[Terms of Service\]\(\/legal\/terms\/\) by reference;\s*\n?\s*section 8\.7 of the Terms is the binding contractual statement and\s*\n?\s*this policy expands on the operational mechanics\./,
    );
    expect(body).not.toMatch(/\[Terms of Service\]\(terms\.md\)/);
  });

  it("4-scenario refund eligibility: 'Failed delivery' + 'Service failure attributable to Driftstack' + 'Within 14 days of first paid charge, no usage' + 'Mistaken duplicate charge' — pinned so the 4-refund-paths stay complete (drift to dropping 'Failed delivery' would orphan stuck-charge customers; drift to changing the 14-day no-usage window would create marketing↔policy divergence)", () => {
    expect(body).toMatch(/\*\*Failed delivery\.\*\*/);
    expect(body).toMatch(/\*\*Service failure attributable to Driftstack\.\*\*/);
    expect(body).toMatch(/\*\*Within 14 days of first paid charge, no usage\.\*\*/);
    expect(body).toMatch(/\*\*Mistaken duplicate charge\.\*\*/);
  });

  it("3-scenario refund DENIAL: 'Mid-cycle cancellation of a monthly Subscription' + 'Tier downgrade' + 'Usage that exceeded customer expectations' — pinned so the denial scenarios stay explicit (drift to dropping any denial scenario would let customers reasonably expect a refund where the policy says no, creating dispute volume)", () => {
    expect(body).toMatch(/Mid-cycle cancellation of a monthly Subscription/);
    expect(body).toMatch(
      /- Tier downgrade\. The downgrade takes effect at the next renewal;\s*\n?\s*no proration is issued for the unused portion of the current tier\./,
    );
    expect(body).toMatch(/Usage that exceeded customer expectations/);
    // The retired trial-pack non-consumed denial scenario must NOT return.
    expect(body).not.toMatch(/Trial Pack/);
  });

  it('Card refund mechanics: support@driftstack.dev → Stripe → 5–10 business days — pinned so the 3-step card-refund flow + the 5–10-business-day-timing stays consistent (drift to a different processor would create marketing↔operational divergence; drift to changing the timing would create unrealistic customer expectations)', () => {
    expect(body).toMatch(
      /You request the refund by emailing\s*\n?\s*\[`support@driftstack\.dev`\]\(mailto:support@driftstack\.dev\)/,
    );
    expect(body).toMatch(/We confirm eligibility and issue the refund through Stripe\./);
    expect(body).toMatch(
      /Stripe returns the funds to the original payment method\. Timing:\s*\n?\s*typically 5–10 business days, depending on your card issuer\./,
    );
  });

  it("Crypto-non-refundable banner pinned: '**Crypto payments at Driftstack are non-refundable.** Once a crypto payment settles on-chain it is committed for the billing period it covers.' — pinned so the bold-non-refundable commitment + the settlement-finality framing both survive (drift to softening 'non-refundable' would invite refund disputes that NowPayments + the chain can't reliably honor)", () => {
    expect(body).toMatch(/\*\*Crypto payments at Driftstack are non-refundable\.\*\*/);
    expect(body).toMatch(
      /Once a crypto\s*\n?\s*payment settles on-chain it is committed for the billing period it\s*\n?\s*covers\./,
    );
  });

  it("Crypto-non-refundable 3-rationale: 'Settlement irreversibility' + 'Fraud + abuse asymmetry' + 'Operational simplicity' — pinned so the 3-reason rationale survives (drift to dropping 'Fraud + abuse asymmetry' would weaken the one-way-attack-surface argument that justifies the policy; drift to dropping 'Operational simplicity' would lose the pricing-implication framing)", () => {
    expect(body).toMatch(/\*\*Settlement irreversibility\.\*\*/);
    expect(body).toMatch(/\*\*Fraud \+ abuse asymmetry\.\*\*/);
    expect(body).toMatch(/\*\*Operational simplicity\.\*\*/);
  });

  it("Cancel-vs-refund crypto framing: 'You can cancel your subscription anytime through the standard self-serve flow. Cancellation stops the next billing period's payment-request mint; it does not refund the current period.' — pinned so the explicit 'cancel ≠ refund' commitment + the self-serve-cancel-flow availability survive (drift to dropping 'does not refund the current period' would mislead crypto customers into expecting refunds)", () => {
    expect(body).toMatch(
      /You can \*\*cancel\*\* your subscription anytime through the standard\s*\n?\s*self-serve flow\. Cancellation stops the next billing period's\s*\n?\s*payment-request mint; it does not refund the current period\./,
    );
  });

  it("Card-fallback framing pinned: 'If your situation needs an actual cash refund, please pay via card (Stripe) — card refunds follow the standard mechanics documented in the section above.' — pinned so the Stripe-as-refund-fallback commitment survives (drift to dropping would orphan refund-needing customers from the card-payment alternative)", () => {
    expect(body).toMatch(
      /If your situation needs an actual cash refund, please pay via card\s*\n?\s*\(Stripe\) — card refunds follow the standard mechanics documented in\s*\n?\s*the section above\./,
    );
  });

  it("SLA credit default + non-expiry pinned: 'the default is to apply it against your next invoice. SLA credits do not expire; if you cancel before the next invoice, you can request the credit out as cash.' — pinned so the next-invoice-default + non-expiry + cash-on-cancel 3-state SLA-credit policy survives (drift to expiring SLA credits would force customers to consume them or lose them; drift to dropping the cash-on-cancel option would trap credits in cancelled accounts)", () => {
    expect(body).toMatch(
      /the\s*\n?\s*default is to apply it against your next invoice\. SLA credits do not\s*\n?\s*expire; if you cancel before the next invoice, you can request the\s*\n?\s*credit out as cash\./,
    );
  });

  it("Dispute escalation pinned: '\"refund dispute\" in the subject line. We respond within 5 business days with the reasoning.' + chargeback right + 'may also terminate the account for chargeback-related abuse' — pinned so the 5-business-day-response + chargeback-right + abuse-termination 3-state escalation flow survives (drift to dropping the chargeback right would close off the customer-protection fallback; drift to dropping abuse-termination would let chargeback-spam against legitimate charges go unchecked)", () => {
    expect(body).toMatch(
      /Email `support@driftstack\.dev` with "refund dispute" in the\s*\n?\s*subject line\. We respond within 5 business days with the\s*\n?\s*reasoning\./,
    );
    expect(body).toMatch(
      /you can issue a chargeback through your card issuer\. We will\s*\n?\s*provide documentation to the issuer; depending on the outcome we\s*\n?\s*may also terminate the account for chargeback-related abuse if\s*\n?\s*the underlying charge was clearly legitimate\./,
    );
  });

  it("Walk-away-not-litigate philosophy pinned: 'We do not litigate refunds — they are low-stakes enough that walking away is almost always cheaper than fighting it out. If you think we got it wrong, write to support and we'll make it right.' — pinned so the customer-friendly 'walking away cheaper than fighting' posture survives (drift to dropping would invite the impression Driftstack will dispute refunds aggressively, which is the opposite of the operational posture)", () => {
    expect(body).toMatch(
      /We do not litigate refunds — they are low-stakes enough that\s*\n?\s*walking away is almost always cheaper than fighting it out\. If you\s*\n?\s*think we got it wrong, write to support and we'll make it right\./,
    );
  });

  it('30-day material-change notice + GitHub repo archive cross-reference — pinned so the version-tracking + 30-day-notice + public-archive commitments all survive (drift to dropping the 30-day notice would let policy changes land without customer warning; drift to dropping the repo link would orphan the prior-versions archive)', () => {
    expect(body).toMatch(
      /\[legal repository\]\(https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs\/legal\)/,
    );
    expect(body).toMatch(
      /Material changes are notified by email to active\s*\n?\s*Customers at least 30 days before the new version takes effect\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
