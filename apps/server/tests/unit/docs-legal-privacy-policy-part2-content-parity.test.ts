// W577.B — drift guard for /docs/legal/privacy-policy.md (Part 2 of 3).
// Driftstack Privacy Policy Version 1.1 (2026-07-17). Drift here either
// weakens the §4 Article-9-GDPR Special Category-not-collected posture,
// breaks the §5 4-rule no-sell / no-profile / no-cross-customer-combine
// / no-LLM-training-without-consent block, drops a §6 international-
// transfer mechanism (DPF / 2021 SCCs / Art-49-derogations), or removes
// a §7 13-row Sub-processor identity.
//
//   • §4: no Article 9 Special Category Data intentionally collected.
//   • §5: 4-prong "we do not" list (no-sell + no-profile + no-cross-mix
//     + no-LLM-training-without-consent).
//   • §6: DPF + 2021 SCCs + Art 49 framework.
//   • §7: 13 Sub-processors (MacStadium / Stripe IE / Stripe US /
//     Anthropic / Moneybird / Hetzner / Neon / Upstash / Cloudflare /
//     Postmark / Sentry / NowPayments / LiveKit).
//   • Part 2: sections 4-7 (Special Category through Sub-processors).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/privacy-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W577.B /docs/legal/privacy-policy.md (part 2) content parity', () => {
  const body = read(LIB);

  it('Section 4 (Special Category Data not collected, Article 9 GDPR) framing pinned', () => {
    expect(body).toMatch(/## 4\. Special Category Data/);
    expect(body).toMatch(/Driftstack does \*\*not\*\* intentionally collect Special Category Data/);
    expect(body).toMatch(/\(Article 9 GDPR — racial or ethnic origin, political opinions,/);
    expect(body).toMatch(/religious or philosophical beliefs, trade union membership, genetic/);
    expect(body).toMatch(/data, biometric data uniquely identifying a person, data concerning/);
    expect(body).toMatch(/health, or data concerning sex life or sexual orientation\)\./);
    expect(body).toMatch(/If Customer's automated browsing causes Special Category Data to/);
    expect(body).toMatch(/pass through live-session media or an API Capture request, that data/);
    expect(body).toMatch(/is Processed by Driftstack only as Processor on Customer's behalf/);
    expect(body).toMatch(/desktop-local recording may contain the same data/);
    expect(body).toMatch(/not uploaded or/);
    expect(body).toMatch(/retained by Driftstack\. Customer is responsible/);
    expect(body).toMatch(/lawful basis under Article 9\(2\)/);
    expect(body).toMatch(/GDPR for processing such data\./);
  });

  it('Section 5 (Data we do not collect) 4-prong no-sell/no-profile/no-cross-mix/no-LLM-training framing pinned', () => {
    expect(body).toMatch(/## 5\. Data we do not collect/);
    expect(body).toMatch(/Driftstack does \*\*not\*\*:/);
    expect(body).toMatch(/1\. Sell Personal Data to third parties\./);
    expect(body).toMatch(/2\. Use Customer's Personal Data for behavioural advertising or/);
    expect(body).toMatch(/profiling beyond what is necessary to operate the Service\./);
    expect(body).toMatch(/3\. Combine Customer-Connected Service data with Driftstack-internal/);
    expect(body).toMatch(/profiles or cross-Customer aggregates\./);
    expect(body).toMatch(/4\. Use Customer Data \(including Session content, Workflows,/);
    expect(body).toMatch(/live-session media, or Capture content\) to train machine-learning/);
    expect(body).toMatch(/models, including the bundled-LLM AI agent/);
    expect(body).toMatch(/feature, without\s+Customer's separate explicit consent\./);
  });

  it('Section 6 (International transfers) DPF + 2021 SCCs + Article 49 framing pinned', () => {
    expect(body).toMatch(/## 6\. International transfers/);
    expect(body).toMatch(/Driftstack is established in the Netherlands\./);
    expect(body).toMatch(/Several Sub-processors/);
    expect(body).toMatch(/are established outside the EEA, in particular in the United States\./);
    expect(body).toMatch(/Where Personal Data is transferred outside the EEA to a country/);
    expect(body).toMatch(/without an adequacy decision under Article 45 GDPR, Driftstack/);
    expect(body).toMatch(/relies on:/);
    expect(body).toMatch(/1\. The \*\*EU-US Data Privacy Framework \(DPF\)\*\* for Sub-processors/);
    expect(body).toMatch(/that are self-certified under the DPF/);
    expect(body).toMatch(/2\. The \*\*2021 Standard Contractual Clauses\*\* \(Commission/);
    expect(body).toMatch(/Implementing Decision \(EU\) 2021\/914\), in the appropriate Module/);
    expect(body).toMatch(/per the Sub-processor's role/);
    expect(body).toMatch(/3\. \*\*Article 49 GDPR derogations\*\* only in genuinely exceptional/);
    expect(body).toMatch(/cases/);
    expect(body).toMatch(/Driftstack does not rely on Article 49 derogations as a routine/);
    expect(body).toMatch(/transfer mechanism\./);
  });

  it('Section 7 (Sub-processors) 13-row table — MacStadium / Stripe-IE / Stripe-US / Anthropic / Moneybird / Hetzner framing pinned', () => {
    expect(body).toMatch(/## 7\. Sub-processors/);
    expect(body).toMatch(/Driftstack engages the following Sub-processors to provide the/);
    expect(body).toMatch(/Service\./);
    expect(body).toMatch(/Each Sub-processor is bound by a written agreement/);
    expect(body).toMatch(/imposing obligations consistent with Article 28 GDPR\./);
    expect(body).toMatch(/\*\*MacStadium, Inc\.\*\* \(US, California\)/);
    expect(body).toMatch(/Mac mini fleet hosting infrastructure for the WebKit driver layer/);
    expect(body).toMatch(/\*\*Stripe Payments Europe Limited\*\* \(Ireland\)/);
    expect(body).toMatch(
      /Payment processing for Customers established in the EEA, UK, and Switzerland\./,
    );
    expect(body).toMatch(/\*\*Stripe, Inc\.\*\* \(US, Delaware\)/);
    expect(body).toMatch(
      /Payment processing for Customers established outside the EEA \/ UK \/ CH\./,
    );
    expect(body).toMatch(/\*\*Anthropic, PBC\*\* \(US, Delaware\) — _conditional_/);
    expect(body).toMatch(/Bundled LLM for the AI agent feature\./);
    expect(body).toMatch(/consents to Driftstack-provided model access/);
    expect(body).not.toMatch(/opts into bundled-LLM billing/);
    expect(body).toMatch(/\*\*Moneybird B\.V\.\*\* \(Netherlands\)/);
    expect(body).toMatch(/Accounting platform for invoice generation and bookkeeping\./);
    expect(body).toMatch(/\*\*Hetzner Online GmbH\*\* \(Germany\)/);
    expect(body).toMatch(/Control-plane hosting/);
  });

  it('Section 7 (Sub-processors) cont — Neon / Upstash / Cloudflare / Postmark / Sentry / NowPayments / LiveKit framing pinned', () => {
    expect(body).toMatch(/\*\*Neon, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/);
    expect(body).toMatch(/Managed Postgres for control-plane data\./);
    expect(body).toMatch(
      /\*\*Upstash, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/,
    );
    expect(body).toMatch(
      /Managed Redis for caches, rate-limit buckets, and ephemeral session state\./,
    );
    // S49 2026-07-07 (founder-approved; mirrors the S43 register correction) — the EU-jurisdiction-selected claim was not
    // verifiable and is withdrawn; the row now states the default
    // jurisdiction + real R2 objects.
    expect(body).toMatch(/\*\*Cloudflare, Inc\.\*\* \(US, Delaware\)/);
    expect(body).toMatch(/R2 default jurisdiction \(data replicated EU \+ US\)/);
    expect(body).not.toMatch(/EU jurisdiction selected/);
    expect(body).toMatch(
      /R2 object storage for customer-uploaded avatars, encrypted profile blobs/,
    );
    expect(body).not.toMatch(/R2 object storage for Recordings/);
    expect(body).toMatch(
      /\*\*Postmark \/ ActiveCampaign LLC\*\* \(US, Delaware\) — _EU sending region_/,
    );
    expect(body).toMatch(
      /Transactional email \(signup verification, password reset, billing receipts, support correspondence\)\./,
    );
    expect(body).toMatch(
      /\*\*Sentry \/ Functional Software, Inc\.\*\* \(US, Delaware\) — _EU region_/,
    );
    expect(body).toMatch(/Error tracking and performance monitoring/);
    expect(body).toMatch(/\*\*NowPayments OÜ\*\* \(Estonia\) — _conditional, opt-in only_/);
    expect(body).toMatch(/Cryptocurrency payment processing \(BTC, LTC, USDT, USDC, ETH, XMR\)\./);
    expect(body).toMatch(/\*\*LiveKit, Inc\.\*\* \(US, Delaware\) — _conditional, opt-in only_/);
    expect(body).toMatch(/WebRTC live-session signaling \+ media SFU/);
    expect(body).toMatch(/The Sub-processor list is \*\*subject to change\*\* under the/);
    expect(body).toMatch(/notice and\s+objection mechanism in Section 3\.4 of the DPA\./);
    expect(body).toMatch(/https:\/\/driftstack\.dev\/trust\/sub-processors\//);
    expect(body).not.toMatch(/marketing site goes live|Section 5 of the DPA/i);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
