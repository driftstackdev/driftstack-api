// W463.C — drift guard for apps/marketing-site/src/data/sub-processors.ts.
// V-052 sub-processor register + V-478 change-log. Drift here either
// removes/adds entries silently (Art 28(2) 30-day notice obligation
// missed — legal exposure since these entries are customer-facing
// transparency claims) or changes a transfer mechanism without the
// paired change-log entry (the /trust page lies about the legal
// basis for an extra-EU transfer).
//
//   • Register framing pinned: 'Sub-processor register — public
//     surface for /trust/sub-processors.' + 'Mirrors the DPA Annex
//     3 entries from docs/legal/dpa.md (this repo) plus the locked
//     sub-processor list (V-052 revision).'
//   • DPA-binding framing pinned: 'When the DPA Annex 3 changes,
//     this file updates in the same commit; the /trust page is a
//     customer-facing transparency artifact, not a separate
//     canonical source.'
//   • Art 28(2) notice obligation framing pinned: 'Changes to this
//     list trigger Art 28(2) sub-processor amendment notice (30-day
//     notice to customers) per the DPA.'
//   • SubProcessor 4-field (name + region + purpose + transferMechanism).
//   • SUB_PROCESSORS 12 entries: Hetzner Cloud + Neon + Upstash +
//     Cloudflare R2 + Postmark + Sentry + Stripe + Anthropic +
//     Moneybird + MacStadium + NowPayments + LiveKit.
//   • SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-07-07' (S43 R2
//     correction bump).
//   • V-478 SubProcessorChangeLogEntry framing pinned + 4-value
//     kind union ('added'|'removed'|'material_change'|
//     'register_published') + 'register_published' baseline marker
//     'pre-launch baseline marker. The register has been on-record
//     from this date forward.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W463.C apps/marketing-site/src/data/sub-processors.ts content parity', () => {
  const body = read(LIB);

  it("Register framing pinned: 'Sub-processor register — public surface for /trust/sub-processors.' + 'Mirrors the DPA Annex 3 entries from docs/legal/dpa.md (this repo) plus the locked sub-processor list (V-052 revision).'", () => {
    expect(body).toMatch(
      /\/\/ Sub-processor register — public surface for \/trust\/sub-processors\./,
    );
    expect(body).toMatch(
      /\/\/ Mirrors the DPA Annex 3 entries from `docs\/legal\/dpa\.md` \(this repo\)\s*\n?\s*\/\/ plus the locked sub-processor list \(V-052 revision\)\./,
    );
  });

  it("DPA-binding framing pinned: 'When the DPA Annex 3 changes, this file updates in the same commit; the /trust page is a customer-facing transparency artifact, not a separate canonical source.'", () => {
    expect(body).toMatch(
      /When the DPA\s*\n?\s*\/\/ Annex 3 changes, this file updates in the same commit; the \/trust\s*\n?\s*\/\/ page is a customer-facing transparency artifact, not a separate\s*\n?\s*\/\/ canonical source\./,
    );
  });

  it("Art 28(2) notice obligation framing pinned: 'Changes to this list trigger Art 28(2) sub-processor amendment notice (30-day notice to customers) per the DPA. Adding or removing an entry is a content change with compliance implications.'", () => {
    expect(body).toMatch(
      /\/\/ Changes to this list trigger Art 28\(2\) sub-processor amendment\s*\n?\s*\/\/ notice \(30-day notice to customers\) per the DPA\. Adding or removing\s*\n?\s*\/\/ an entry is a content change with compliance implications\./,
    );
  });

  it('SubProcessor 4-field (name + region + purpose + transferMechanism all strings) with DPA-mirror JSDoc framing', () => {
    expect(body).toMatch(
      /export interface SubProcessor \{\s*\n?\s*\/\*\* Legal-entity name as it appears in the DPA Annex 3\. \*\/\s*\n?\s*name: string;\s*\n?\s*\/\*\* Region of operation; "EU" for EU-resident, country for specific\. \*\/\s*\n?\s*region: string;\s*\n?\s*\/\*\* What data flows through this sub-processor\. \*\/\s*\n?\s*purpose: string;\s*\n?\s*\/\*\* Transfer mechanism for any data outside the EU\. \*\/\s*\n?\s*transferMechanism: string;\s*\n?\s*\}/,
    );
  });

  it('SUB_PROCESSORS 12 entries pinned: Hetzner Cloud + Neon + Upstash + Cloudflare R2 + Postmark + Sentry + Stripe + Anthropic + Moneybird + MacStadium + NowPayments + LiveKit', () => {
    expect(body).toMatch(/name: 'Hetzner Cloud',/);
    expect(body).toMatch(/name: 'Neon',/);
    expect(body).toMatch(/name: 'Upstash',/);
    expect(body).toMatch(/name: 'Cloudflare R2',/);
    expect(body).toMatch(/name: 'Postmark',/);
    expect(body).toMatch(/name: 'Sentry',/);
    expect(body).toMatch(/name: 'Stripe',/);
    expect(body).toMatch(/name: 'Anthropic',/);
    expect(body).toMatch(/name: 'Moneybird',/);
    expect(body).toMatch(/name: 'MacStadium',/);
    expect(body).toMatch(/name: 'NowPayments',/);
    expect(body).toMatch(/name: 'LiveKit',/);
  });

  it('Stripe and Anthropic purposes describe the shipped bundled-AI billing rail without misclassifying BYOK or changing data-flow scope', () => {
    expect(body).toMatch(/billing for Driftstack-bundled AI usage/);
    expect(body).toMatch(/BYOK AI usage is billed directly by the model provider/);
    expect(body).toMatch(/standard Builder and Scale usage at \$0\.10 per agent turn/);
    expect(body).toMatch(/Enterprise can use a contracted custom rate/);
    expect(body).toMatch(/Session data flows to Anthropic only when one of these two modes/);
    expect(body).not.toMatch(
      /usage-based billing for the bring-your-own-key|bills the customer at a markup/i,
    );
  });

  it("Transfer mechanism categories pinned: 'EU-resident — no transfer required.' (Hetzner/Neon/Upstash/Moneybird) + '2021 Standard Contractual Clauses + EU-US Data Privacy Framework.' (Cloudflare R2/Postmark/Stripe/Anthropic/MacStadium/LiveKit) + 'EEA-internal — no transfer mechanism required.' (NowPayments) + 'EU ingest region' (Sentry). S43 2026-07-07: the R2 'EU-jurisdiction storage — no transfer required' claim was false (default jurisdiction, EU + US replication) — R2 now carries the SCCs+DPF mechanism and the old string must not reappear.", () => {
    expect(body).toMatch(/transferMechanism: 'EU-resident — no transfer required\.',/);
    expect(body).not.toMatch(
      /transferMechanism: 'EU-jurisdiction storage — no transfer required\.',/,
    );
    expect(body).toMatch(/region: 'Default jurisdiction \(data replicated EU \+ US\)',/);
    expect(body).toMatch(
      /transferMechanism: '2021 Standard Contractual Clauses \+ EU-US Data Privacy Framework\.',/,
    );
    // S20c 2026-07-06 plain-language pass: EEA spelled out inline.
    expect(body).toMatch(
      /transferMechanism:\s+'Inside the EEA \(the EU plus Iceland, Liechtenstein, and Norway\) — no transfer mechanism required\.',/,
    );
    expect(body).toMatch(
      /transferMechanism: 'EU ingest region — no transfer required for error data\.',/,
    );
  });

  it("SUB_PROCESSOR_REGISTER_LAST_UPDATED pinned to '2026-07-07' (S43 R2-correction bump)", () => {
    expect(body).toMatch(/export const SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-07-07';/);
  });

  it("V-478 change-log framing pinned: 'V-478 — sub-processor change-log surface.' + 'Every material change to the SUB_PROCESSORS register lands here as an immutable entry.' + Art 28(2) 30-day notice email pairing", () => {
    expect(body).toMatch(/\*\s*V-478 — sub-processor change-log surface\./);
    expect(body).toMatch(
      /\*\s*Every material change to the SUB_PROCESSORS register lands here as\s*\n?\s*\*\s*an immutable entry\. Customers can scan the list to see when each\s*\n?\s*\*\s*sub-processor was added or removed, and which Article 28\(2\) notice\s*\n?\s*\*\s*window applied\. Adding an entry is paired with the Art 28\(2\) 30-day\s*\n?\s*\*\s*notice email per the DPA\./,
    );
  });

  it("SubProcessorChangeLogEntry: 4-value kind union ('added'|'removed'|'material_change'|'register_published') + 5-field (date + kind + subject + summary + effective_at) + 'register_published' baseline marker framing 'pre-launch baseline marker. The register has been on-record from this date forward.'", () => {
    expect(body).toMatch(
      /\*\s+- `register_published`: pre-launch baseline marker\. The register has\s*\n?\s*\*\s+been on-record from this date forward\./,
    );
    expect(body).toMatch(
      /export interface SubProcessorChangeLogEntry \{\s*\n?\s*date: string;\s*\n?\s*kind: 'added' \| 'removed' \| 'material_change' \| 'register_published';/,
    );
  });

  it("SUB_PROCESSOR_CHANGELOG: S43 Cloudflare R2 material_change correction entry (2026-07-07) + register_published baseline entry (date '2026-05-10', kind 'register_published', subject empty)", () => {
    // S43 2026-07-07 — the correction entry leads the array (newest
    // first is not enforced; the baseline entry must still exist).
    expect(body).toMatch(
      /date: '2026-07-07',\s*\n?\s*kind: 'material_change',\s*\n?\s*subject: 'Cloudflare R2',/,
    );
    expect(body).toMatch(
      /date: '2026-05-10',\s*\n?\s*kind: 'register_published',\s*\n?\s*subject: '',/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
