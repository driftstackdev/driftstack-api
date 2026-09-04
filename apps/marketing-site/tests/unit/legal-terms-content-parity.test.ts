// W377.A — drift guard for marketing-site /legal/terms.md content.
// Existing legal-doc-cross-link-integrity covers shape. This guard
// pins the load-bearing commercial-counsel-review claims a
// procurement/legal reviewer anchors on when assessing the master
// commercial agreement:
//
//   • Version 1.1 + Effective 2026-07-17 (pin via doc-header drift).
//   • B2B-only carve-out: Burgerlijk Wetboek 7:5 + Directive
//     2011/83/EU (excludes consumer-protection regime).
//   • Service composition (§3): API + SDKs + self-hosted GUI Client
//     + Mac mini fleet infrastructure.
//   • Tier structure (§8.1): Free + Manual ladder (Personal/Team/
//     Agency) + API ladder (Starter/Builder/Scale) + custom
//     Enterprise; prices live at driftstack.io/pricing (the
//     source of truth is src/data/pricing.ts, so §8.1 references
//     the pricing page rather than hardcoding figures).
//   • Crypto non-refundable in ALL cases (§8.7.1) — load-bearing
//     commercial-policy claim.
//   • SLA posture (§9.1 + §9.2): no SLA at Free / Manual ladder /
//     API Starter / API Builder; 99.9% + Sev-1 first-response of
//     4h (API Scale) / 1h (Enterprise).
//   • §13.1 12-month-Fees liability cap.
//   • §13.3 carve-outs: gross negligence + indemnity + confidentiality
//     + payment + statutory.
//   • §15.2 30-day material-modification notice.
//   • §16.1 Governing law = Netherlands; §17.2 Amsterdam exclusive
//     jurisdiction; §17.3 Class action waiver.
//   • Cross-links: privacy.md / dpa.md / aup.md all exist.
//   • Contact addresses: legal@/privacy@driftstack.dev.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/terms.md');
const CANONICAL = resolve(REPO_ROOT, 'docs/legal/terms-of-service.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W377.A marketing-site /legal/terms.md content parity', () => {
  const body = read(PAGE);
  const canonical = read(CANONICAL);

  it('version 1.1 + effective 2026-07-17 is mirrored to the canonical Terms', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    }
  });

  it('B2B-only carve-out: Burgerlijk Wetboek 7:5 + Directive 2011/83/EU', () => {
    expect(body).toMatch(/business customers/);
    expect(body).toMatch(/Article 7:5 of the Dutch Civil Code/);
    expect(body).toMatch(/Burgerlijk Wetboek/);
    expect(body).toMatch(/Article 2\(1\) of Directive 2011\/83\/EU/);
  });

  it('§3 Service composition: API + SDKs + GUI Client + Mac mini fleet', () => {
    expect(body).toMatch(/An \*\*API\*\* \(the `\/v1\/` endpoints\)/);
    expect(body).toMatch(/returning Session and Capture artifacts/);
    expect(body).toMatch(/\*\*SDKs\*\* \(TypeScript, Python, Go\)/);
    expect(body).toMatch(/\*\*self-hosted GUI Client\*\*/);
    expect(body).toMatch(/\*\*Mac mini fleet infrastructure\*\*/);
  });

  it('§3 local-recording/live-media/Capture boundary is mirrored and no cloud recording is promised', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/\*\*Live-session viewing and desktop-local recording \(optional,/);
      expect(doc).toMatch(/Live-session media is ephemeral: Driftstack does\s+not store it/);
      expect(doc).toMatch(/local NDJSON recording\s+files in the app data directory/);
      expect(doc).toMatch(
        /does not upload those files or frames to Driftstack's API,\s+control plane, or Cloudflare R2/,
      );
      expect(doc).toMatch(/provides no API recording endpoint or cloud recording-/);
      expect(doc).toMatch(/screenshot, DOM snapshot, or PDF bytes inline/);
      expect(doc).toMatch(/does not retain the\s+artifact/);
      expect(doc).toMatch(/encrypted in transit on\s+each\s+WebRTC connection using DTLS-SRTP/);
      expect(doc).toMatch(
        /LiveKit receives, processes,\s+and\s+forwards the media as a Sub-processor/,
      );
      expect(doc).toMatch(
        /does not\s+currently provide application-level end-to-end encryption through\s+the SFU/,
      );
      expect(doc).not.toMatch(/Session, Capture, and Recording artifacts/);
      expect(doc).not.toMatch(/Recording feature[\s\S]{0,80}Cloudflare R2/);
      expect(doc).not.toMatch(/E2EE (?:on|is enabled by) default/i);
      expect(doc).not.toMatch(/end-to-end encryption is enabled by default/i);
      expect(doc).not.toMatch(/cannot decrypt/i);
    }
  });

  it('§8.1 tier structure pinned (Free + Manual + API ladders) + references driftstack.io/pricing; no fictional figures', () => {
    expect(body).toMatch(/perpetual Free tier/);
    expect(body).toMatch(/Manual ladder \(Personal, Team, Agency\)/);
    expect(body).toMatch(/API ladder \(API\s+Starter, API Builder, API Scale\)/);
    expect(body).toMatch(/custom-priced Enterprise/);
    expect(body).toMatch(/published at\s+<https:\/\/driftstack\.io\/pricing\/>/);
    // Fictional figures must never reappear in §8.1.
    expect(body).not.toMatch(/\$39\/mo|\$99\/mo|\$299\/mo|\$999\/mo|\$3,000\/mo/);
  });

  it('§8.3 five payment methods pin Stripe rails plus truthful crypto checkout', () => {
    expect(body).toMatch(/\*\*Card payments\*\* \(Visa, Mastercard, American Express/);
    expect(body).toMatch(/\*\*SEPA Direct Debit\*\* for Customers with a EUR bank account/);
    expect(body).toMatch(/\*\*iDEAL\*\* for Customers with a Dutch bank account/);
    expect(body).toMatch(/\*\*Bancontact\*\* for Customers with a Belgian bank account/);
    expect(body).toMatch(
      /\*\*Cryptocurrency\*\* in the assets and networks displayed at\s+checkout/,
    );
    expect(body).toMatch(/converted into a time-limited crypto quote/);
    expect(body).toMatch(/Entitlement starts only after NowPayments reports the order paid/);
    expect(body).toMatch(/does not custody crypto or initiate crypto refunds/);
  });

  it('§8.4.1 Dutch BTW 21% pinned + §8.4.2 EU reverse-charge VAT', () => {
    expect(body).toMatch(/Dutch BTW at\s+the prevailing rate \(currently 21%\)/);
    expect(body).toMatch(/\*\*Reverse-Charge\s+VAT\*\*/);
    expect(body).toMatch(/Council Directive\s+2006\/112\/EC/);
  });

  it("§8.7.1 crypto non-refundable in ALL cases (buyer's remorse / accidental over-payment / price movement)", () => {
    expect(body).toMatch(/\*\*Crypto payments are non-refundable\.\*\*/);
    expect(body).toMatch(
      /non-refundable in all cases, including but\s+not limited to buyer's remorse, accidental over-payment, and price\s+movement/,
    );
    expect(body).toMatch(/Card refund mechanics \(8\.7, above\) do not apply to crypto-paid/);
  });

  it('§9.1 no SLA at Free/Manual/API Starter/Builder + §9.2 99.9% + Sev-1 first-response 4h API Scale / 1h Enterprise', () => {
    expect(body).toMatch(
      /Free, Manual-ladder\s+\(Personal, Team, Agency\), API Starter, and API Builder tiers are\s+provided \*\*without\*\* a contractually-binding service level\s+agreement/,
    );
    expect(body).toMatch(/The API Scale and Enterprise\s+tiers carry a contractual SLA/);
    expect(body).toMatch(
      /99\.9%\s+monthly availability; first-response SLA on Severity-1 incidents of\s+four \(4\) hours on API Scale and one \(1\) hour on Enterprise/,
    );
  });

  it('§11.1 Sub-processor change warranty points to the operative DPA section', () => {
    expect(body).toMatch(/notification\s+mechanism in Section 3\.4 of the DPA/);
    expect(body).not.toMatch(/notification\s+mechanism in Section 5 of the DPA/);
  });

  it('§9.3 maintenance: 48-hour advance notice via status.driftstack.io', () => {
    expect(body).toMatch(
      /scheduled maintenance during\s+windows announced at least 48 hours in advance/,
    );
    expect(body).toMatch(/<https:\/\/status\.driftstack\.io>/);
  });

  it('§13.1 12-month-Fees liability cap pinned', () => {
    expect(body).toMatch(
      /limited to the total Fees paid\s+or payable by Customer to Driftstack under this agreement during the\s+twelve \(12\) months immediately preceding the event/,
    );
  });

  it('§13.3 liability-cap carve-outs: gross negligence / IP indemnity / confidentiality / payment', () => {
    expect(body).toMatch(
      /Gross negligence or willful misconduct \(_opzet of bewuste\s+roekeloosheid_\)/,
    );
    expect(body).toMatch(/Indemnification obligations under Section 12\.1/);
    expect(body).toMatch(/Breach of Section 7 \(Confidentiality\)/);
    expect(body).toMatch(/Customer's payment obligations under Section 8/);
  });

  it('§14.2 termination for convenience: 30-day written notice', () => {
    expect(body).toMatch(
      /terminate the\s+agreement for convenience on thirty \(30\) days' written notice/,
    );
  });

  it('§14.5 termination effect: API Keys revoked + Sessions destroyed + 30-day post-termination content retention', () => {
    expect(body).toMatch(/Customer's API Keys are revoked/);
    expect(body).toMatch(/Active Sessions are destroyed/);
    expect(body).toMatch(/typically 30 days post-termination for content\s+data/);
  });

  it('§15.2 30-day material-modification notice + §15.3 right-to-terminate-with-pro-rated-refund', () => {
    expect(body).toMatch(
      /Material modifications[\s\S]+?take effect no earlier than thirty \(30\) days\s+after notification/,
    );
    expect(body).toMatch(
      /Customer may\s+terminate the Subscription on written notice given before the new\s+version's effective date, without penalty and with pro-rated refund/,
    );
  });

  it('§16.1 governing law = Netherlands (excluding CISG)', () => {
    expect(body).toMatch(/laws of the Netherlands\*\*,\s+excluding its conflict-of-law provisions/);
    expect(body).toMatch(
      /United\s+Nations Convention on Contracts for the International Sale of Goods/,
    );
  });

  it('§17.2 Amsterdam exclusive jurisdiction + §17.3 class-action waiver', () => {
    expect(body).toMatch(
      /\*\*exclusive jurisdiction\*\* of the courts of\s+\*\*Amsterdam, the Netherlands\*\*/,
    );
    expect(body).toMatch(/\*\*Class action waiver\.\*\*/);
  });

  it('§18 export controls: EU 2021/821 + US EAR + OFAC', () => {
    expect(body).toMatch(/Regulation \(EU\) 2021\/821 on dual-use items/);
    expect(body).toMatch(/US Export\s+Administration Regulations \(15 CFR §§ 730–774\)/);
    expect(body).toMatch(/US OFAC sanctions/);
  });

  it('cross-links: canonical Privacy / DPA / AUP routes all exist', () => {
    expect(body).toMatch(/\[Privacy Policy\]\(\/legal\/privacy\/\)/);
    expect(body).toMatch(/\[Data Processing Agreement\]\(\/legal\/dpa\/\)/);
    expect(body).toMatch(/\[Acceptable Use Policy\]\(\/legal\/aup\/\)/);
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
    expect(existsSync(resolve(dir, 'privacy.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'dpa.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'aup.md'))).toBe(true);
  });

  it('§22 contact addresses pinned: legal@ + privacy@driftstack.dev', () => {
    expect(body).toMatch(/Legal: `legal@driftstack\.dev`/);
    expect(body).toMatch(/Privacy: `privacy@driftstack\.dev`/);
    expect(body).toMatch(/Driftstack B\.V\., Amsterdam, the Netherlands/);
  });

  it('§8.5 late-payment interest = Dutch wettelijke handelsrente (Art 6:119a)', () => {
    expect(body).toMatch(
      /statutory commercial rate under\s+Article 6:119a of the Dutch Civil Code \(`wettelijke handelsrente`\)/,
    );
  });

  it('§14.4 4 suspension triggers: AUP / threat / 30-day-past-due / legal-process', () => {
    expect(body).toMatch(/Customer's use violates the AUP per Section 5 of the AUP/);
    expect(body).toMatch(/imminent threat to the Service's integrity/);
    expect(body).toMatch(/more than thirty \(30\) days\s+past due on undisputed Fees/);
    expect(body).toMatch(/Driftstack is required by law\s+or valid legal process to suspend/);
  });
});
