// W509.B — drift guard for apps/marketing-site/src/pages/docs/email-troubleshooting.astro.
// V-057.D email-troubleshooting customer-facing page. Drift here
// either drops a step in the 6-step checklist (would orphan customers
// from that recovery path) or shifts the verification-email
// resend-button mechanics (would create marketing↔dashboard divergence).
//
//   • V-057.D + /docs/emails-reference companion anchor.
//   • 6-step troubleshooting checklist.
//   • Magic-link 15-minute expiry + single-use.
//   • Resend-verification 3/min per-IP cap.
//   • Postmark suppression list + typo'd-domain hard-bounce scenario.
//   • Payment receipts fire on paid status, not on funds-hit-address.
//   • Status notifications subscription mechanism.
//   • Support@driftstack.dev 3-field support template.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/email-troubleshooting.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W509.B apps/marketing-site/src/pages/docs/email-troubleshooting.astro content parity', () => {
  const body = read(LIB);

  it('V-057.D framing pinned: \'public-facing troubleshooting for customers who didn\'t receive an expected email. Companion to /docs/emails-reference. Cuts the most common support tickets ("I never got the verify email" / "magic link not in inbox").\' — pinned so the V-057.D anchor + /docs/emails-reference companion + support-ticket-cut rationale survive (drift to dropping the companion cross-reference would orphan the troubleshooting page from the reference)', () => {
    expect(body).toMatch(
      /\/\/ V-057\.D — public-facing troubleshooting for customers who didn't\s*\n?\s*\/\/ receive an expected email\. Companion to \/docs\/emails-reference\./,
    );
  });

  it("6-step troubleshooting checklist headers: 1 Right inbox + 2 Spam/junk + 3 60-second-retry + 4 Corporate filters + 5 Specific scenarios + 6 Contact support — pinned so the 6-step structure stays complete (drift to dropping 'Corporate / workspace filters' would orphan G-Suite/M365 customers from the quarantine release path; drift to dropping the wait-60-seconds step would let customers re-trigger before the first email arrives)", () => {
    expect(body).toMatch(/<h2>1 · Check the right inbox<\/h2>/);
    expect(body).toMatch(/<h2>2 · Check spam \/ junk \+ Promotions tabs<\/h2>/);
    expect(body).toMatch(/<h2>3 · Wait 60 seconds, then retry the trigger<\/h2>/);
    expect(body).toMatch(/<h2>4 · Corporate \/ workspace filters<\/h2>/);
    expect(body).toMatch(/<h2>5 · Specific scenarios<\/h2>/);
    expect(body).toMatch(/<h2>6 · Still nothing — contact support<\/h2>/);
  });

  it("Resend-verification 3/min IP-cap framing pinned: 'click Resend verification email on the /verify-email page in the customer dashboard (the same page you landed on after signup). The button re-mints a fresh token and re-sends the email; the per-IP cap is 3/minute so accidental double-clicks won't lock you out.' — pinned so the /verify-email page reference + 3/min IP-cap + 'accidental double-clicks won't lock you out' commitment survive (drift to a different cap would create marketing↔server-rate-limit divergence)", () => {
    expect(body).toMatch(
      /click\s*\n?\s*<strong>Resend verification email<\/strong> on the\s*\n?\s*<code>\/verify-email<\/code> page in the customer dashboard/,
    );
    expect(body).toMatch(
      /The button\s*\n?\s*re-mints a fresh token and re-sends the email; the per-IP\s*\n?\s*cap is 3\/minute so accidental double-clicks won't lock you\s*\n?\s*out\./,
    );
  });

  it("Magic-link 15-minute + single-use pinned: 'Magic-link tokens are single-use and expire after 15 minutes.' — pinned so the 15-minute TTL + single-use commitments stay consistent (drift to a different window would create marketing↔server divergence on the magic-link policy)", () => {
    expect(body).toMatch(/Magic-link tokens are single-use and expire after 15 minutes\./);
  });

  it("Postmark suppression + typo'd-domain scenario pinned: 'Signups for typo'd domains (user@gnail.com, @gmial.com) bounce silently. Postmark's bounce stream marks the address inactive after the second hard bounce, which then suppresses every retry.' — pinned so the typo-domain example + 2-hard-bounce suppression mechanic + retry-suppression rationale all survive (drift to dropping the specific gnail.com/gmial.com examples would make the warning abstract; drift to a different bounce-threshold would create marketing↔Postmark-policy divergence)", () => {
    expect(body).toMatch(
      /Signups for typo'd domains\s*\n?\s*\(<code>user@gnail\.com<\/code>, <code>@gmial\.com<\/code>\)\s*\n?\s*bounce silently\. Postmark's bounce stream marks the address\s*\n?\s*inactive after the second hard bounce, which then suppresses\s*\n?\s*every retry\./,
    );
  });

  it("Payment receipt timing pinned: 'For crypto: the receipt fires when the order transitions to paid, not when funds first hit the address.' — pinned so the 'receipt on paid-state not on funds-hit' distinction survives (drift to dropping the explicit nuance would let customers think the receipt fires at first funds-arrival)", () => {
    expect(body).toMatch(
      /For crypto: the receipt fires when the order transitions to\s*\n?\s*<code>paid<\/code>, not when funds first hit the address\./,
    );
  });

  it("Status-notification unsubscribe-link mechanics pinned: 'the one-click unsubscribe link in the most-recent email turns it off durably. To re-subscribe, submit the form again — emails resume on the next incident.' — pinned so the one-click-unsubscribe + re-subscribe-via-form + 'emails resume on next incident' framing survive (drift to dropping the 're-subscribe via form' instruction would orphan accidentally-unsubscribed customers)", () => {
    expect(body).toMatch(
      /the\s*\n?\s*one-click unsubscribe link in the most-recent email turns it\s*\n?\s*off durably\. To re-subscribe, submit the form again — emails\s*\n?\s*resume on the next incident\./,
    );
  });

  it("Support template 3-field pinned: 'The address you triggered the email on.' + 'The action that triggered it (signup / magic link / etc.).' + 'Approximate timestamp + timezone.' + 'Support consults Postmark's delivery log against the address and replies within EU business hours.' — pinned so the 3-field support-request template + Postmark-delivery-log-lookup commitment + EU business hours SLA survive (drift to dropping the 3-field template would let support tickets land underspecified)", () => {
    expect(body).toMatch(/<li>The address you triggered the email on\.<\/li>/);
    expect(body).toMatch(
      /<li>The action that triggered it \(signup \/ magic link \/ etc\.\)\.<\/li>/,
    );
    expect(body).toMatch(/<li>Approximate timestamp \+ timezone\.<\/li>/);
    expect(body).toMatch(
      /Support consults Postmark's delivery log against the address\s*\n?\s*and replies within EU business hours\./,
    );
  });

  it("Spam / DKIM/SPF/DMARC framing pinned: 'Even with DKIM, SPF, and DMARC aligned, first-time senders occasionally get filtered. Mark Driftstack's mail as \"not spam\" and add noreply@driftstack.dev to your contacts so future sends route to the inbox.' — pinned so the 3-protocol alignment claim + noreply@driftstack.dev contact-add guidance survive (drift to dropping the DKIM/SPF/DMARC trio would weaken the email-deliverability claim; drift to dropping noreply@driftstack.dev would orphan the canonical sender address)", () => {
    expect(body).toMatch(
      /Even with DKIM, SPF, and DMARC aligned, first-time senders\s*\n?\s*occasionally get filtered\. Mark Driftstack's mail as "not\s*\n?\s*spam" and add <code>noreply@driftstack\.dev<\/code> to your\s*\n?\s*contacts so future sends route to the inbox\./,
    );
  });

  it('3-related-doc cluster: /docs/emails-reference + /docs/billing-crypto-troubleshooting + /docs/status-subscriptions — pinned so the 3-related-doc navigation surface stays complete (drift to dropping any would orphan that-doc from the troubleshooting hub)', () => {
    expect(body).toMatch(/<li><a href="\/docs\/emails-reference">Email reference<\/a><\/li>/);
    expect(body).toMatch(
      /<li><a href="\/docs\/billing-crypto-troubleshooting">Crypto payment troubleshooting<\/a><\/li>/,
    );
    expect(body).toMatch(
      /<li><a href="\/docs\/status-subscriptions">Status subscriptions<\/a><\/li>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
