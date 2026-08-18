// W551.B — drift guard for /docs/adr/ADR-006-audit-log-retention-export.md.
// Architectural proposal. Drift here either weakens the
// 90d-hot-Postgres + 7y-R2-JSONL retention posture (would risk
// unbounded Postgres growth + Dutch BV fiscale-bewaarplicht
// compliance gap), drops the 4-table inventory (admin_audit_log +
// processed_stripe_events + legal_acceptances + webhook_deliveries),
// or weakens the customer-erasure interaction (GDPR Art 17(3)(b)
// retention exception for accounting+AML).
//
//   • Status: Proposed (pending founder review).
//   • Related V-entry: V-095. Touches admin_audit_log (D-025) +
//     processed_stripe_events (V-080) + legal_acceptances (V-046)
//     + webhook_deliveries (Phase 5).
//   • Hot retention: 90 days Postgres.
//   • Archive: R2 JSONL gzip partitioned YYYY/MM/.
//   • Cadence: monthly cron, 1st of month 02:00 UTC.
//   • SLA: 7 years (fiscale bewaarplicht + GDPR Art 17(3)(b)).
//   • Export API: Phase 1 admin /v1/admin/accounts/:id/audit-export
//     + Phase 2 customer-facing /v1/account/audit-export.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-006-audit-log-retention-export.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W551.B /docs/adr/ADR-006-audit-log-retention-export.md content parity', () => {
  const body = read(LIB);

  it("Header + Status-Proposed + Related-V framing pinned: '# ADR-006 — Audit log retention + export' + '**Status:** Proposed (pending founder review)' + '**Date:** 2026-05-03' + '**Tier:** Architectural (workflow + storage decision; surfaces for review per Decision authority)' + '**Related V-entry:** V-095 (this proposal). Touches `admin_audit_log` (D-025), `processed_stripe_events` (V-080), `legal_acceptances` (V-046), `webhook_deliveries` (Phase 5).' — pinned so the ADR-006-Proposed-2026-05-03 + workflow+storage-Architectural + V-095-this-proposal + 4-table-inventory commitment survives", () => {
    expect(body).toMatch(/^# ADR-006 — Audit log retention \+ export$/m);
    expect(body).toMatch(/\*\*Status:\*\* Proposed \(pending founder review\)/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(
      /\*\*Tier:\*\* Architectural \(workflow \+ storage decision; surfaces for review per Decision authority\)/,
    );
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-095 \(this proposal\)\. Touches `admin_audit_log` \(D-025\),/,
    );
    expect(body).toMatch(
      /`processed_stripe_events` \(V-080\), `legal_acceptances` \(V-046\), `webhook_deliveries` \(Phase 5\)\./,
    );
  });

  it("4-audit-table inventory framing pinned: '**`admin_audit_log`** (D-025): every admin action — tier change, suspend / unsuspend, webhook delivery replay/requeue, rate-limit override set/clear.' + '**`processed_stripe_events`** (V-080): inbound Stripe webhook idempotency ledger. event_id PK, event_type, payload SHA-256 hash, handler outcome, received timestamp.' + '**`legal_acceptances`** (V-046): customer acceptance of ToS / Privacy / DPA / AUP. Append-only by service-layer convention' + '**`webhook_deliveries`** (Phase 5): outbound webhook delivery history — every attempt, response status, retry / DLQ outcome.' — pinned so the admin_audit_log-D-025-action-inventory + processed_stripe_events-V-080-idempotency-ledger + legal_acceptances-V-046-ToS-Privacy-DPA-AUP + webhook_deliveries-Phase-5-retry-DLQ commitment survives", () => {
    expect(body).toMatch(
      /- \*\*`admin_audit_log`\*\* \(D-025\): every admin action — tier change, suspend \/ unsuspend,/,
    );
    expect(body).toMatch(/webhook delivery replay\/requeue, rate-limit override set\/clear\./);
    expect(body).toMatch(
      /- \*\*`processed_stripe_events`\*\* \(V-080\): inbound Stripe webhook idempotency ledger\./,
    );
    expect(body).toMatch(
      /event_id PK, event_type, payload SHA-256 hash, handler outcome, received timestamp\./,
    );
    expect(body).toMatch(
      /- \*\*`legal_acceptances`\*\* \(V-046\): customer acceptance of ToS \/ Privacy \/ DPA \/ AUP\./,
    );
    expect(body).toMatch(/Append-only by service-layer convention/);
    expect(body).toMatch(
      /- \*\*`webhook_deliveries`\*\* \(Phase 5\): outbound webhook delivery history — every attempt, response status, retry \/ DLQ outcome\./,
    );
  });

  it("Decision §1 + §2 + §3 + §4 — 90d Postgres + R2 JSONL + monthly cron + 7y SLA framing pinned: '### 1. Hot retention (Postgres) — 90 days' + '### 2. Archive (Cloudflare R2) — JSON Lines, gzip-compressed' + 'partitioned by `YYYY/MM/`' + '### 3. Archive cadence — monthly sweep' + 'runs on the 1st of each month at 02:00 UTC' + '### 4. Retention SLA — 7 years' + 'Dutch BV bookkeeping retention requirements (fiscale bewaarplicht — 7 years for accounting records).' + 'GDPR right-to-erasure exceptions for compliance / legal-defense data' — pinned so the 90d-hot + JSONL-gzip-YYYY/MM + monthly-1st-02:00-UTC + 7y-SLA-fiscale-bewaarplicht + GDPR-Art-17-3-b-compliance-exception commitment survives", () => {
    expect(body).toMatch(/### 1\. Hot retention \(Postgres\) — 90 days/);
    expect(body).toMatch(/### 2\. Archive \(Cloudflare R2\) — JSON Lines, gzip-compressed/);
    expect(body).toMatch(/partitioned by `YYYY\/MM\/`/);
    expect(body).toMatch(/### 3\. Archive cadence — monthly sweep/);
    // V-865 — this pin used to freeze "A monthly cron-driven service
    // (`AuditArchiveService`, lands in V-NNN) runs on the 1st of each month",
    // which described a sweep that has never executed. Six arms of
    // audit-archive-is-not-scheduled-and-that-is-recorded prove it is dormant,
    // so the suite was simultaneously asserting the cadence runs and proving it
    // does not. Per-occurrence negatives, so neither half can come back alone.
    expect(body, 'the present-tense claim that the sweep runs is gone').not.toMatch(
      /`AuditArchiveService`, lands in V-NNN\) runs on the 1st/,
    );
    // Scoped to §3 deliberately. A blanket ban on the placeholder failed on my
    // first run and was right to: §5's "Phase 1 lands as a follow-on" is still
    // TRUE — no admin audit-export route exists — so forbidding the string
    // document-wide asserted something I had not verified. §7's ledger claim
    // was stale (audit_archive_runs shipped in V-163) and is corrected.
    expect(body, 'the archive ledger is described as shipped, not pending').toMatch(
      /\*\*Archive ledger\*\* \(`audit_archive_runs`\) — shipped in V-163/,
    );
    // NOT pinned: the §3 status wording. My first version froze the phrase
    // "NOT IMPLEMENTED", and V-794 failed the suite for it — correctly. That
    // sentence expires the day somebody wires the sweep, and the pin would then
    // fight the engineer who did it, which is the whole defect V-794 names.
    // The truth about dormancy is owned by
    // audit-archive-is-not-scheduled-and-that-is-recorded, which DERIVES it from
    // the absence of a caller and cannot go stale. A doc pin cannot do that, so
    // it should not pretend to.
    expect(body).toMatch(/### 4\. Retention SLA — 7 years/);
    expect(body).toMatch(
      /- Dutch BV bookkeeping retention requirements \(fiscale bewaarplicht — 7 years for accounting records\)\./,
    );
    expect(body).toMatch(/- GDPR right-to-erasure exceptions for compliance \/ legal-defense data/);
  });

  it("Decision §5 + §6 — Export-API + Customer-erasure framing pinned: '### 5. Export API — admin-only at launch, customer-facing later' + 'admin endpoint `GET /v1/admin/accounts/:id/audit-export?from=...&to=...`' + '**Phase 2 (post-launch, on customer request)**: customer-facing endpoint `GET /v1/account/audit-export`' + '### 6. Customer-erasure interaction' + '`accounts.id` → CASCADE deletes hot Postgres rows (already in schema).' + 'Archive files retain unchanged for the 7-year window — they're customer-data-bearing but lawful per GDPR Art 17(3)(b) (legal obligation, accounting + AML retention).' — pinned so the Phase-1-admin-only + Phase-2-customer-facing + accounts.id-CASCADE + GDPR-Art-17-3-b-legal-obligation-accounting-AML commitment survives", () => {
    expect(body).toMatch(/### 5\. Export API — admin-only at launch, customer-facing later/);
    expect(body).toMatch(
      /admin endpoint `GET \/v1\/admin\/accounts\/:id\/audit-export\?from=\.\.\.&to=\.\.\.`/,
    );
    expect(body).toMatch(
      /\*\*Phase 2 \(post-launch, on customer request\)\*\*: customer-facing endpoint `GET \/v1\/account\/audit-export`/,
    );
    expect(body).toMatch(/### 6\. Customer-erasure interaction/);
    expect(body).toMatch(
      /- `accounts\.id` → CASCADE deletes hot Postgres rows \(already in schema\)\./,
    );
    expect(body).toMatch(
      /- Archive files retain unchanged for the 7-year window — they're customer-data-bearing/,
    );
    expect(body).toMatch(
      /but lawful per GDPR Art 17\(3\)\(b\) \(legal obligation, accounting \+ AML retention\)\./,
    );
  });

  it("Why-NOT-separate-vendor + Revisit-triggers + Operational-notes audit_archive_runs ledger framing pinned: 'Why NOT a separate audit-event-store vendor (e.g. AWS QLDB, Vouch, Auditr)' + 'JSONL on R2 is portable; QLDB ledger format is not.' + 'audit_archive_runs' + 'sha256_checksum text NOT NULL' + 'Customer requests immutable cryptographic anchoring' + 'Archive sweep takes >5 minutes' + 'GDPR / DPA renegotiation' + 'Decision authority' — pinned so the no-QLDB/Vouch/Auditr-vendor-lock-in + JSONL-portable-vs-QLDB-not + audit_archive_runs-sha256_checksum + 4-revisit-trigger + founder-review commitment survives", () => {
    expect(body).toMatch(
      /### Why NOT a separate audit-event-store vendor \(e\.g\. AWS QLDB, Vouch, Auditr\)/,
    );
    expect(body).toMatch(/JSONL on R2 is portable; QLDB ledger format is not\./);
    expect(body).toMatch(/`audit_archive_runs`/);
    expect(body).toMatch(/sha256_checksum text NOT NULL/);
    expect(body).toMatch(/- \*\*Customer requests immutable cryptographic anchoring\*\*/);
    expect(body).toMatch(/- \*\*Archive sweep takes >5 minutes\*\* at production volume/);
    expect(body).toMatch(/- \*\*GDPR \/ DPA renegotiation\*\*/);
    expect(body).toMatch(/## Decision authority/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
