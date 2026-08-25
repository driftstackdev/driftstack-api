// W506.A — drift guard for apps/marketing-site/src/pages/legal/privacy.md.
// Privacy Policy v1.1 — Driftstack-as-Controller disclosures. Drift here
// either weakens a GDPR-Article disclosure (would expose to supervisory-
// authority complaints) or breaks the Driftstack-as-Controller-vs-
// Processor split that the DPA cross-reference rests on.
//
//   • Version 1.1 effective 2026-07-17 + Driftstack B.V. Dutch entity.
//   • 11 data-category sections (3.1–3.11), including status data,
//     double-opt-in subscriptions, and opt-in live-session media.
//   • 'do not collect' 4-no-list: no sale / no behavioural-advertising
//     /no Customer-Connected-cross-Customer / no ML-training without
//     consent.
//   • International transfers: 2021 SCCs + EU-US DPF + Article 49
//     derogations (exceptional only).
//   • 13-vendor Sub-processor table.
//   • Customer-Connected Services 4-list NOT Sub-processors.
//   • Retention schedule per-category.
//   • Article 15-22 Data Subject rights + 1-month response + AP
//     Autoriteit Persoonsgegevens complaint right.
//   • DPO threshold-based policy: 1M monthly sessions / 5k monitored
//     unique subjects / AP guidance.
//   • Breach notification: 72h to supervisor + 48h-target to Customer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W506.A apps/marketing-site/src/pages/legal/privacy.md content parity', () => {
  const body = read(LIB);

  it("Version 1.1 effective 2026-07-17 + Driftstack B.V. Amsterdam Dutch entity + Controller-vs-Processor split anchor pinned: 'This Privacy Policy describes Driftstack's processing as a **Controller** (account, billing, support correspondence, marketing site analytics where applicable). Driftstack's processing as a **Processor** on Customer's behalf (Customer Data, Session content, Customer-Provided Secrets) is governed by the [Data Processing Agreement (DPA)]' — pinned so the version stamp + Dutch BV jurisdiction + Controller-vs-Processor split + DPA cross-reference all survive (drift to dropping the Controller/Processor split would create GDPR-role confusion at the heart of the doc)", () => {
    expect(body).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    expect(body).toMatch(
      /\*\*Driftstack B\.V\.\*\*, a private limited company organised under the laws of the Netherlands, established in Amsterdam\./,
    );
    expect(body).toMatch(
      /This Privacy Policy describes Driftstack's processing as a\s*\*\*Controller\*\* \(account, billing, support correspondence, marketing\s*site analytics where applicable\)\./,
    );
    expect(body).toMatch(/Driftstack's processing as a\s*\*\*Processor\*\* on Customer's behalf/);
  });

  it('11-category data-collection taxonomy includes account through opt-in live-session media', () => {
    expect(body).toMatch(/### 3\.1 Account data/);
    expect(body).toMatch(/### 3\.2 Authentication data/);
    expect(body).toMatch(/### 3\.3 Session metadata/);
    expect(body).toMatch(/### 3\.4 Desktop-local recordings and API Capture artifacts/);
    expect(body).toMatch(/### 3\.5 Customer-Provided Secrets/);
    expect(body).toMatch(/### 3\.6 Billing data/);
    expect(body).toMatch(/### 3\.7 Support correspondence/);
    expect(body).toMatch(/### 3\.8 Marketing-site data/);
    expect(body).toMatch(/### 3\.9 Status-page data/);
    expect(body).toMatch(/### 3\.10 Status-page email subscriptions/);
    expect(body).toMatch(/### 3\.11 Live-session media \(optional, opt-in only\)/);
  });

  it('Account data truthfully discloses the R2 avatar and non-binding region preference', () => {
    expect(body).toMatch(/optional profile avatar/);
    expect(body).toMatch(/Customer-uploaded image, stored in the Cloudflare R2 sub-processor/);
    expect(body).toMatch(/region preference/);
    expect(body).toMatch(/does not change current data residency/);
    expect(body).not.toMatch(/see §17/);
  });

  it('Article 6 GDPR legal-basis citations pinned: 6(1)(b) performance-of-contract + 6(1)(c) compliance-with-legal-obligation Article 32 + 6(1)(f) legitimate-interest — pinned so the 3-legal-basis anchoring stays explicit (drift to dropping Article 32 GDPR anchor on Authentication would orphan the security-of-processing legal basis; drift to dropping 6(1)(b) on Account would weaken the contract-performance basis)', () => {
    expect(body).toMatch(/Article 6\(1\)\(b\) — performance of the\s*contract with Customer/);
    expect(body).toMatch(
      /Article 6\(1\)\(c\) — compliance with legal obligation under Article 32\s*GDPR \(security of processing\)\./,
    );
    expect(body).toMatch(/Article 6\(1\)\(f\) —/);
  });

  it("MFA specifics: 'TOTP secret encrypted at rest with AES-256-GCM (only the encrypted ciphertext is stored; the plaintext exists only in memory during signature verification), 10 single-use recovery codes stored as scrypt-hashed values' — pinned so the AES-256-GCM cipher + 10-recovery-code + scrypt-hash-mirror commitments survive (drift to dropping AES-256-GCM specificity would weaken the at-rest-encryption disclosure; drift to dropping '10 single-use' would obscure recovery-code mechanics)", () => {
    expect(body).toMatch(
      /a TOTP secret encrypted at rest with\s*AES-256-GCM \(only the encrypted ciphertext is stored; the plaintext\s*exists only in memory during signature verification\), 10 single-use\s*recovery codes stored as scrypt-hashed values/,
    );
  });

  it('Crypto billing disclosure pins stored order/provider fields and excludes wallet/transaction identifiers', () => {
    expect(body).toMatch(/internal order id, selected tier, fiat price, NowPayments\s*payment id/);
    expect(body).toMatch(/signed provider notifications/);
    expect(body).toMatch(
      /does not persist a Customer wallet address or blockchain\s*transaction hash/,
    );
  });

  it('desktop recordings stay local, API Captures return inline, and legacy cloud-retention claims are absent', () => {
    expect(body).toMatch(
      /recording workflow does \*\*not\*\* upload recording files or frames\s*to Driftstack's API, control plane, or Cloudflare R2/,
    );
    expect(body).toMatch(/Driftstack has\s*no API recording endpoint/);
    expect(body).toMatch(/`POST \/v1\/sessions\/:id\/capture`/);
    expect(body).toMatch(/Capture endpoint does not retain\s*the artifact/);
    expect(body).toMatch(/Live-session\s*media is ephemeral/);
    expect(body).toMatch(/encrypted in transit on each\s*WebRTC connection using DTLS-SRTP/);
    expect(body).toMatch(
      /LiveKit receives, processes, and\s*forwards the media as a Sub-processor/,
    );
    expect(body).toMatch(
      /does not currently\s*provide application-level end-to-end encryption through the SFU/,
    );
    expect(body).not.toMatch(/Customer-controlled\. Default 30 days/);
    expect(body).not.toMatch(/1–365 days/);
    expect(body).not.toMatch(/E2EE (?:on|is enabled by) default/i);
    expect(body).not.toMatch(/end-to-end encryption is enabled by default/i);
    expect(body).not.toMatch(/cannot decrypt/i);
  });

  it('Status and live-session sections disclose lifecycle, consent, retention, and cryptography', () => {
    expect(body).toMatch(/does \*\*not\*\* expose\s*Customer Data/);
    expect(body).toMatch(/retained for 30 days for\s*diagnostic purposes/);
    expect(body).toMatch(/double-opt-in flow/);
    expect(body).toMatch(/purged from that row 90\s*days after unsubscribe/);
    expect(body).toMatch(/live-session media is \*\*not stored\*\*/);
    expect(body).toMatch(/DTLS-SRTP/);
  });

  it("Section 5 'do not collect' 4-no commitment: no-sale + no-behavioural-advertising-beyond-operation + no-Customer-Connected-cross-Customer-combination + no-ML-training-without-consent — pinned so the 4-promise-of-restraint commitment survives (drift to dropping 'no ML training' would let bundled-LLM data slip into training; drift to dropping 'no sale' would weaken the most-frequently-asked privacy commitment)", () => {
    expect(body).toMatch(/Sell Personal Data to third parties\./);
    expect(body).toMatch(
      /Use Customer's Personal Data for behavioural advertising or\s*profiling beyond what is necessary to operate the Service\./,
    );
    expect(body).toMatch(
      /Combine Customer-Connected Service data with Driftstack-internal\s*profiles or cross-Customer aggregates\./,
    );
    expect(body).toMatch(
      /Use Customer Data \(including Session content, Workflows,\s*live-session media, or Capture content\) to train machine-learning\s*models, including the bundled-LLM AI agent feature, without\s*Customer's separate explicit consent\./,
    );
  });

  it('International transfers 3-mechanism: EU-US DPF + 2021 SCCs (Implementing Decision 2021/914) + Article 49 derogations (exceptional only) — pinned so the 3-transfer-mechanism stack survives (drift to relying on Article 49 routinely would create GDPR-compliance risk; drift to dropping the 2021/914 anchor would weaken the SCC version-pinning)', () => {
    expect(body).toMatch(
      /The \*\*EU-US Data Privacy Framework \(DPF\)\*\* for Sub-processors\s*that are self-certified under the DPF/,
    );
    expect(body).toMatch(
      /The \*\*2021 Standard Contractual Clauses\*\* \(Commission\s*Implementing Decision \(EU\) 2021\/914\)/,
    );
    expect(body).toMatch(
      /\*\*Article 49 GDPR derogations\*\* only in genuinely exceptional\s*cases/,
    );
  });

  it("13-vendor Section 7 Sub-processor table includes: MacStadium + Stripe Payments Europe Ltd + Stripe Inc. + Anthropic (conditional) + Moneybird + Hetzner + Neon + Upstash + Cloudflare + Postmark + Sentry + NowPayments (conditional) + LiveKit (conditional) — pinned so the 13-vendor scope stays consistent with the DPA Annex 3 (drift to dropping Moneybird would orphan the accounting sub-processor; drift to dropping the 'conditional' marker on Anthropic/NowPayments/LiveKit would mislead customers who don't opt into those features)", () => {
    expect(body).toMatch(/\*\*MacStadium, Inc\.\*\*/);
    expect(body).toMatch(/\*\*Stripe Payments Europe Limited\*\* \(Ireland\)/);
    expect(body).toMatch(/\*\*Stripe, Inc\.\*\* \(US, Delaware\)/);
    expect(body).toMatch(/\*\*Anthropic, PBC\*\* \(US, Delaware\) — _conditional_/);
    expect(body).toMatch(/consents to Driftstack-provided model access/);
    expect(body).not.toMatch(/opts into bundled-LLM billing/);
    expect(body).toMatch(/\*\*Moneybird B\.V\.\*\* \(Netherlands\)/);
    expect(body).toMatch(/\*\*Hetzner Online GmbH\*\* \(Germany\)/);
    expect(body).toMatch(/\*\*Neon, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/);
    expect(body).toMatch(
      /\*\*Upstash, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/,
    );
    // S49 2026-07-07 (founder-approved; mirrors the S43 register correction) — the EU-jurisdiction-selected claim was not
    // verifiable and is withdrawn; the row now states the default
    // jurisdiction + real R2 objects.
    expect(body).toMatch(/\*\*Cloudflare, Inc\.\*\* \(US, Delaware\)/);
    expect(body).toMatch(/R2 default jurisdiction \(data replicated EU \+ US\)/);
    expect(body).not.toMatch(/EU jurisdiction selected/);
    expect(body).toMatch(
      /\*\*Postmark \/ ActiveCampaign LLC\*\* \(US, Delaware\) — _EU sending region_/,
    );
    expect(body).toMatch(
      /\*\*Sentry \/ Functional Software, Inc\.\*\* \(US, Delaware\) — _EU region_/,
    );
    expect(body).toMatch(/\*\*NowPayments OÜ\*\* \(Estonia, EU\) — _conditional_/);
    expect(body).toMatch(/\*\*LiveKit\*\* \(US, regional endpoints\) — _conditional_/);
    expect(body).toMatch(/notice and\s*objection mechanism in Section 3\.4 of the DPA/);
    expect(body).toMatch(/\[`\/trust\/sub-processors`\]\(\/trust\/sub-processors\/\)/);
    expect(body).not.toMatch(/marketing site goes live|Section 5 of the DPA/i);
  });

  it('Customer-Connected Services 4-list NOT-Sub-processors: HTTP/SOCKS5 proxies + Captcha solvers + Email IMAP/Gmail-OAuth + SMS verification — pinned so the 4-service NOT-Sub-processor delineation survives (drift to merging any into Sub-processor list would create marketing↔DPA-Annex-3 divergence and would shift contractual responsibility incorrectly)', () => {
    expect(body).toMatch(
      /\*\*HTTP \/ SOCKS5 proxy providers\*\* \(e\.g\. Bright Data, Smartproxy,\s*Customer's own infrastructure\)\./,
    );
    expect(body).toMatch(
      /\*\*Captcha-solving services\*\* \(e\.g\. 2Captcha, CapSolver,\s*AntiCaptcha\)\./,
    );
    expect(body).toMatch(
      /\*\*Email services\*\* Customer accesses by IMAP, Gmail OAuth, or\s*equivalent\./,
    );
    expect(body).toMatch(/\*\*SMS-verification services\*\* \(e\.g\. TextVerified, Twilio\)\./);
  });

  it('Section 9 retention summary preserves statutory periods and pins the local/inline/ephemeral artifact boundaries', () => {
    expect(body).toMatch(/Article 52 _Algemene wet inzake rijksbelastingen_ — 7-year retention/);
    expect(body).toMatch(/7 years post-transaction \(Dutch tax law, AWR Art 52\)/);
    expect(body).toMatch(
      /90 days operational; aggregated counters \(no PII\) retained indefinitely/,
    );
    expect(body).toMatch(/3 years post-resolution\./);
    expect(body).toMatch(/Marketing-site access logs\s*\|\s*30 days\./);
    expect(body).toMatch(
      /Desktop-local recordings\s*\|\s*Not uploaded to or retained by Driftstack/,
    );
    expect(body).toMatch(/API Capture artifacts\s*\|\s*Returned inline to Customer/);
    expect(body).toMatch(/Live-session media\s*\|\s*Not stored by Driftstack/);
    expect(body).toMatch(/Profile metadata \+ Profile Snapshots/);
    expect(body).toMatch(/persist until Customer deletes them/);
    expect(body).toMatch(/within 30 days of Customer Account termination/);
    expect(body).not.toMatch(/Session Recordings\s*\|/);
  });

  it('Article 15-22 Data Subject rights pinned: access (15) + rectification (16) + erasure (17) + restriction (18) + portability (20) + objection (21) + automated-decision-making (22) — pinned so the 7-Article-rights enumeration stays complete (drift to dropping the Article-numbers would weaken the GDPR-anchored specificity; drift to dropping Article 22 would obscure the no-automated-decision-making posture)', () => {
    expect(body).toMatch(/\*\*Right of access\*\* \(Article 15\)/);
    expect(body).toMatch(/\*\*Right to rectification\*\* \(Article 16\)/);
    expect(body).toMatch(/\*\*Right to erasure\*\* \("right to be forgotten" — Article 17\)/);
    expect(body).toMatch(/\*\*Right to restriction of processing\*\* \(Article 18\)/);
    expect(body).toMatch(/\*\*Right to data portability\*\* \(Article 20\)/);
    expect(body).toMatch(/\*\*Right to object\*\* \(Article 21\)/);
    expect(body).toMatch(
      /\*\*Rights related to automated individual decision-making,\s*including profiling\*\* \(Article 22\)/,
    );
  });

  it('1-month-response + 2-month-extension under Article 12(3) + Autoriteit Persoonsgegevens (Dutch DPA) complaint right under Article 77 pinned — pinned so the response-SLA + AP complaint-route (with Postbus 93374, 2509 AJ Den Haag postal address) survive (drift to dropping the AP postal address would orphan the supervisory-authority complaint path; drift to a different response window would create marketing↔GDPR-statute divergence)', () => {
    expect(body).toMatch(
      /Driftstack responds within one \(1\) month of receipt of the request, extendable by two \(2\) further months for complex or numerous requests with notice to the Data Subject \(Article 12\(3\) GDPR\)\./,
    );
    expect(body).toMatch(
      /\*\*Autoriteit Persoonsgegevens\*\* \(Dutch DPA\), Postbus 93374, 2509\s*AJ Den Haag, the Netherlands/,
    );
  });

  it('DPO threshold-based 3-condition policy: 1M monthly sessions OR 5k unique subjects regular-and-systematic-monitoring OR AP guidance — pinned so the 3-trigger DPO threshold survives (drift to softening any threshold would weaken the documented policy that justifies no-DPO-today; drift to dropping the AP-guidance trigger would close off responsive escalation)', () => {
    expect(body).toMatch(
      /Total monthly active sessions across the Service exceed 1\s*million; \*\*or\*\*/,
    );
    expect(body).toMatch(
      /Any single Customer's monthly Sessions involve regular and\s*systematic monitoring of more than 5,000 unique Data Subjects;\s*\*\*or\*\*/,
    );
    expect(body).toMatch(
      /The Autoriteit Persoonsgegevens issues guidance applying the\s*Article 37\(1\)\(b\) threshold to similar services\./,
    );
  });

  it('Breach notification 3-tier: 72h to supervisor (Article 33(1)) + 48h-target to Customer (DPA §7) + Data Subject notification (Article 34 high-risk) — pinned so the 3-tier breach-notification cascade survives (drift to softening the 72h supervisor window would breach GDPR; drift to dropping the 48h Customer-target would weaken the DPA support commitment)', () => {
    expect(body).toMatch(
      /Driftstack\s*notifies the Autoriteit Persoonsgegevens \(or the lead\s*supervisory authority if different\) within 72 hours of becoming\s*aware of the breach/,
    );
    expect(body).toMatch(
      /Driftstack notifies Customer without undue delay \(target: within\s*48 hours of becoming aware\)/,
    );
    expect(body).toMatch(
      /Driftstack communicates the breach to\s*affected Data Subjects without undue delay/,
    );
  });

  it("Children-under-16 framing pinned: 'The Service is not directed to and is not intended for use by children. Driftstack does not knowingly collect Personal Data of children under 16' — pinned so the children-protection commitment survives (drift to dropping the under-16 threshold would weaken the protective commitment; drift to softening 'not directed to' would muddy the B2B-only positioning)", () => {
    expect(body).toMatch(
      /The Service is not directed to and is not intended for use by\s*children\. Driftstack does not knowingly collect Personal Data of\s*children under 16/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
