// W377.B — drift guard for marketing-site /legal/privacy.md content.
// Existing privacy-subprocessor-parity covers sub-processor row
// derivation. This guard pins the load-bearing GDPR-Controller-side
// claims a DPO reviewer anchors on:
//
//   • Version 1.1 + Effective 2026-07-17 (pin via doc-header drift).
//   • Controller identity: Driftstack B.V. Amsterdam.
//   • §3.2 Authentication-data security: API Keys scrypt-hashed,
//     TOTP AES-256-GCM, 10 recovery codes scrypt-hashed (matches
//     /trust/security-overview).
//   • §3.4 desktop-local recordings + inline Capture artifacts;
//     no cloud/API/R2 recording or server retention window.
//   • §3.6 Renewal-reminder email mechanism (Stripe invoice.upcoming
//     ~7 days before invoice).
//   • §3.8–3.11 current marketing/status/live-session disclosures.
//   • §5 4 do-not-do honesty list: no sale / no behavioural ads /
//     no cross-customer aggregation / no ML training without consent.
//   • §7 13 Sub-processor rows pinned with transfer mechanism.
//   • §9 Retention table: 7-year billing (AWR Art 52) + 30-day
//     marketing-site access logs + 3-year support correspondence.
//   • §11 DPO threshold policy: 1M monthly sessions OR 5K unique
//     data subjects per Customer.
//   • §13 Breach notification: 72-hour supervisory (Art 33(1)) +
//     48-hour processor-to-customer target.
//   • §14 Children: under 16 default.
//   • §10 Data-subject rights: 1-month response, extendable by 2
//     months (Art 12(3)). Autoriteit Persoonsgegevens lodging
//     address Postbus 93374, 2509 AJ Den Haag.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');
const CANONICAL = resolve(REPO_ROOT, 'docs/legal/privacy-policy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W377.B marketing-site /legal/privacy.md content parity', () => {
  const body = read(PAGE);
  const canonical = read(CANONICAL);

  it('version 1.1 + effective 2026-07-17 is mirrored to the canonical policy', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/\*\*Version:\*\* 1\.1 · \*\*Effective:\*\* 2026-07-17/);
    }
  });

  it('§1 Controller identity = Driftstack B.V. (Netherlands, Amsterdam)', () => {
    expect(body).toMatch(
      /Controller of Personal Data described in this Privacy Policy is \*\*Driftstack B\.V\.\*\*, a private limited company organised under the laws of the Netherlands, established in Amsterdam/,
    );
  });

  it('§3.1 account avatar and region-preference disclosure is mirrored canonically', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/optional profile avatar/);
      expect(doc).toMatch(/Cloudflare R2/);
      expect(doc).toMatch(/infrastructure\s+region preference/);
      expect(doc).toMatch(/does not change current data residency/);
    }
    expect(body).not.toMatch(/see §17/);
  });

  it('§3.2 API Keys scrypt-hashed + TOTP AES-256-GCM + 10 recovery codes scrypt-hashed', () => {
    expect(body).toMatch(/API Keys \(stored as scrypt-hashed values; the plaintext key/);
    expect(body).toMatch(/TOTP secret encrypted at rest with\s+AES-256-GCM/);
    expect(body).toMatch(/10 single-use\s+recovery codes stored as scrypt-hashed values/);
    expect(body).toMatch(/per-session "MFA-satisfied-at"\s+timestamp/);
  });

  it('§3.4 local-recording + inline-Capture boundary is mirrored and legacy cloud promises stay absent', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/### 3\.4 Desktop-local recordings and API Capture artifacts/);
      expect(doc).toMatch(/completed recording as local NDJSON files in the app data directory/);
      expect(doc).toMatch(
        /does \*\*not\*\* upload recording files or frames\s+to Driftstack's API, control plane, or Cloudflare R2/,
      );
      expect(doc).toMatch(/Driftstack has\s+no API recording endpoint/);
      expect(doc).toMatch(/`POST \/v1\/sessions\/:id\/capture`/);
      expect(doc).toMatch(/returns the resulting\s+bytes inline in that response/);
      expect(doc).toMatch(/Capture endpoint does not retain\s+the artifact/);
      expect(doc).toMatch(/Live-session\s+media is\s+ephemeral/);
      expect(doc).toMatch(/encrypted in transit on each\s+WebRTC connection using DTLS-SRTP/);
      expect(doc).toMatch(
        /LiveKit receives, processes, and\s+forwards the media as a Sub-processor/,
      );
      expect(doc).toMatch(
        /does not currently\s+provide application-level end-to-end encryption through the SFU/,
      );
      expect(doc).not.toMatch(/Customer-controlled\. Default 30 days/);
      expect(doc).not.toMatch(/1–365 days/);
      expect(doc).not.toMatch(/optionally store Recordings/);
      expect(doc).not.toMatch(/E2EE (?:on|is enabled by) default/i);
      expect(doc).not.toMatch(/end-to-end encryption is enabled by default/i);
      expect(doc).not.toMatch(/cannot decrypt/i);
    }
  });

  it('§3.6 billing data: no PAN retention (PCI-DSS via Stripe) + 7-year retention (Article 52 AWR)', () => {
    expect(body).toMatch(/Driftstack does \*\*not\*\* retain primary account numbers\s+\(PANs\)/);
    expect(body).toMatch(/Article 52 of the\s+Dutch _Algemene wet inzake rijksbelastingen_/);
  });

  it('§3.6 crypto disclosure pins stored provider/order fields and excludes wallet/transaction identifiers', () => {
    expect(body).toMatch(/internal order id, selected tier, fiat price, NowPayments\s+payment id/);
    expect(body).toMatch(/quoted crypto amount and currency, payment status/);
    expect(body).toMatch(/signed provider notifications/);
    expect(body).toMatch(
      /does not persist a Customer wallet address or blockchain\s+transaction hash/,
    );
  });

  it('§3.6 renewal-reminder email: Stripe invoice.upcoming ~7 days before invoice + opt-outable', () => {
    expect(body).toMatch(
      /Approximately seven \(7\) days before each\s+recurring subscription invoice is generated, Stripe fires an\s+`invoice\.upcoming` webhook/,
    );
    expect(body).toMatch(/opt out of this email at any time/);
    // S49 2026-07-07 — the mirror page 301s; link goes straight to docs.
    expect(body).toMatch(
      /\[Emails reference page\]\(https:\/\/docs\.driftstack\.io\/reference\/emails\/\)/,
    );
  });

  it('§3.8 marketing-site cookies: strictly-necessary only, no first-party analytics', () => {
    expect(body).toMatch(/Driftstack does \*\*not\*\* currently set first-party analytics cookies/);
    expect(body).toMatch(
      /strictly-necessary cookies on the\s+marketing site \(session-id for signup flow, CSRF token\)/,
    );
    expect(body).toMatch(/Article 5\(3\) of\s+Directive 2002\/58\/EC/);
    expect(body).toMatch(
      /remain disabled unless the required consent\s+mechanism and disclosure are active/,
    );
  });

  it('§3.9–3.11 status data, double-opt-in subscriptions, and ephemeral live-session media are public', () => {
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/### 3\.9 Status-page data/);
      expect(doc).toMatch(/does \*\*not\*\* expose(?: any)?\s+Customer Data/);
      expect(doc).toMatch(/retained for 30 days for\s+diagnostic purposes/);
      expect(doc).toMatch(/### 3\.10 Status-page email subscriptions/);
      expect(doc).toMatch(/double-opt-in flow/);
      expect(doc).toMatch(/purged from (?:this|that) row 90\s+days after unsubscribe/);
      expect(doc).toMatch(/### 3\.11 Live-session media \(optional, opt-in only\)/);
      expect(doc).toMatch(/live-session media is \*\*not stored\*\*/);
      expect(doc).toMatch(/DTLS-SRTP/);
    }
  });

  it('§5 4 do-not-do honesty list: no sale / no behavioural ads / no cross-customer / no ML training without consent', () => {
    expect(body).toMatch(/Sell Personal Data to third parties\./);
    expect(body).toMatch(/Use Customer's Personal Data for behavioural advertising or\s+profiling/);
    expect(body).toMatch(
      /Combine Customer-Connected Service data with Driftstack-internal\s+profiles or cross-Customer aggregates/,
    );
    expect(body).toMatch(
      /Use Customer Data \(including Session content, Workflows,\s+live-session media, or Capture content\) to train machine-learning\s+models/,
    );
    expect(body).toMatch(/bundled-LLM AI agent\s+feature/);
  });

  it('§6 international transfers: EU-US DPF + 2021 SCCs (Decision 2021/914) + Art 49 derogations only exceptional', () => {
    expect(body).toMatch(/\*\*EU-US Data Privacy Framework \(DPF\)\*\*/);
    expect(body).toMatch(
      /\*\*2021 Standard Contractual Clauses\*\* \(Commission\s+Implementing Decision \(EU\) 2021\/914\)/,
    );
    expect(body).toMatch(/\*\*Article 49 GDPR derogations\*\* only in genuinely exceptional/);
    expect(body).toMatch(/Driftstack does not rely on Article 49 derogations as a routine/);
  });

  it('§7 13 Sub-processor rows pinned (MacStadium / Stripe x2 / Anthropic / Moneybird / Hetzner / Neon / Upstash / Cloudflare / Postmark / Sentry / NowPayments / LiveKit)', () => {
    for (const name of [
      'MacStadium, Inc.',
      'Stripe Payments Europe Limited',
      'Stripe, Inc.',
      'Anthropic, PBC',
      'Moneybird B.V.',
      'Hetzner Online GmbH',
      'Neon, Inc.',
      'Upstash, Inc.',
      'Cloudflare, Inc.',
      'Postmark / ActiveCampaign LLC',
      'Sentry / Functional Software, Inc.',
      'NowPayments OÜ',
      'LiveKit',
    ]) {
      expect(body, `sub-processor missing: ${name}`).toContain(name);
    }
    expect(body).toMatch(/notice and\s+objection mechanism in Section 3\.4 of the DPA/);
    expect(body).toMatch(/\[`\/trust\/sub-processors`\]\(\/trust\/sub-processors\/\)/);
    expect(body).not.toMatch(/marketing site goes live|Section 5 of the DPA/i);
  });

  it('§7 Neon + Upstash + Cloudflare data-residency = EU (Frankfurt / EU jurisdiction)', () => {
    expect(body).toMatch(/Neon, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/);
    expect(body).toMatch(/Upstash, Inc\.\*\* \(US, Delaware\) — _data resident in EU Frankfurt_/);
    // S49 2026-07-07 (founder-approved; mirrors the S43 register correction) — the EU-jurisdiction-selected claim was not
    // verifiable and is withdrawn; the row now states the default
    // jurisdiction + real R2 objects.
    expect(body).toMatch(/\*\*Cloudflare, Inc\.\*\* \(US, Delaware\)/);
    expect(body).toMatch(/R2 default jurisdiction \(data replicated EU \+ US\)/);
    expect(body).not.toMatch(/EU jurisdiction selected/);
  });

  it('§8 Customer-Connected Services list: proxies / captcha / IMAP-Gmail / SMS — NOT sub-processors', () => {
    expect(body).toMatch(/\*\*HTTP \/ SOCKS5 proxy providers\*\* \(e\.g\. Bright Data, Smartproxy/);
    expect(body).toMatch(/\*\*Captcha-solving services\*\* \(e\.g\. 2Captcha, CapSolver/);
    expect(body).toMatch(/\*\*Email services\*\* Customer accesses by IMAP, Gmail OAuth/);
    expect(body).toMatch(/\*\*SMS-verification services\*\* \(e\.g\. TextVerified, Twilio\)/);
  });

  it('§9 retention table: billing 7-year (AWR Art 52) + marketing-site access logs 30 days + support 3 years', () => {
    expect(body).toMatch(/7 years post-transaction \(Dutch tax law, AWR Art 52\)/);
    expect(body).toMatch(/Marketing-site access logs.*\|\s*30 days/);
    expect(body).toMatch(/Support correspondence.*\|\s*3 years post-resolution/);
    expect(body).toMatch(/Session metadata\s*\|\s*90 days operational/);
    expect(body).toMatch(
      /Desktop-local recordings\s*\|\s*Not uploaded to or retained by Driftstack/,
    );
    expect(body).toMatch(/API Capture artifacts\s*\|\s*Returned inline to Customer/);
    expect(body).toMatch(/Live-session media\s*\|\s*Not stored by Driftstack/);
    for (const doc of [body, canonical]) {
      expect(doc).toMatch(/Profile metadata \+ Profile Snapshots/);
      expect(doc).toMatch(/persist until Customer deletes them/);
      expect(doc).toMatch(/within 30 days of Customer Account termination/);
    }
    expect(body).not.toMatch(/Session Recordings\s*\|/);
  });

  it('§10 data-subject rights: 1-month response, extendable by 2 months (Art 12(3))', () => {
    expect(body).toMatch(
      /responds within one \(1\) month of receipt of the request, extendable by two \(2\) further months/,
    );
    expect(body).toMatch(/Article 12\(3\) GDPR/);
  });

  it('§10 Autoriteit Persoonsgegevens lodging address pinned (Postbus 93374, 2509 AJ Den Haag)', () => {
    expect(body).toMatch(
      /\*\*Autoriteit Persoonsgegevens\*\* \(Dutch DPA\), Postbus 93374, 2509\s+AJ Den Haag/,
    );
    expect(body).toMatch(/Article 77 GDPR/);
  });

  it('§11 DPO threshold policy: 1M monthly sessions OR 5K unique data subjects per Customer', () => {
    expect(body).toMatch(/Total monthly active sessions across the Service exceed 1\s+million/);
    expect(body).toMatch(
      /regular and\s+systematic monitoring of more than 5,000 unique Data Subjects/,
    );
  });

  it('§13 breach notification: 72-hour supervisory (Art 33(1)) + 48-hour processor-to-customer target', () => {
    expect(body).toMatch(/within 72 hours of becoming\s+aware of the breach/);
    expect(body).toMatch(/Article 33\(1\) GDPR/);
    expect(body).toMatch(/target: within\s+48 hours of becoming aware/);
  });

  it('§14 children under 16 (no knowing collection)', () => {
    expect(body).toMatch(/does not knowingly collect Personal Data of\s+children under 16/);
  });

  it('cross-links: canonical Terms + DPA routes', () => {
    expect(body).toMatch(/\[Terms of Service\]\(\/legal\/terms\/\)/);
    expect(body).toMatch(/\[Data Processing Agreement \(DPA\)\]\(\/legal\/dpa\/\)/);
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');
    expect(existsSync(resolve(dir, 'terms.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'dpa.md'))).toBe(true);
  });

  it('§4 no intentional Special Category Data collection (Article 9 GDPR)', () => {
    expect(body).toMatch(/Driftstack does \*\*not\*\* intentionally collect Special Category Data/);
    expect(body).toMatch(/Article 9 GDPR/);
  });
});
