// W892 — V-281 admin support+refund + V-052 quota-override cross-
// source invariant. Two-hundred-eighteenth in the drift-guard
// series. Pins the admin-side schemas:
//
//   AddSupportNoteRequest (V-281, audit-only):
//     - note: 1-2000 chars.
//     - 'Records a free-form admin note on the customer's audit
//       log' — never touches billing/sessions/keys.
//
//   RecordRefundRequest (V-281, audit-only):
//     - external_reference: 3-120 chars (Stripe charge/PI/invoice).
//     - amount_cents: positive int.
//     - currency?: 3-letter ISO (defaults USD).
//     - reason: 1-500 chars (REQUIRED — unlike audit_note's optional).
//     - 'Endpoint does NOT call Stripe. Money movement happens
//       out-of-band' framing pinned.
//     - V-280 launch-day runbook + 'tier-3 boundary on direct
//       financial actions' framing.
//
//   SetQuotaOverrideRequest (V-052):
//     - bucket_key: 2-value enum (global / sessions:create).
//     - capacity: int 1 - 1,000,000.
//     - refill_per_second: 0.01 - 100,000.
//     - duration_seconds: int 1 - 30 days (86400 * 30).
//     - reason: optional 500 chars.
//
// stays in lockstep across api-types Zod canonical.
//
// Drift would silently break:
//   * Admin-panel UI accepting fields the server rejects.
//   * Stripe-non-call invariant (refund-record must NOT trigger
//     actual money movement).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W892 V-281 admin schemas cross-source invariant', () => {
  // ─── V-281 anchor ────────────────────────────────────────────

  it("CRITICAL packages/api-types/src/admin.ts pins V-281 anchor — 'V-281 — admin audit-note + refund-record (audit-only)'. The audit-only framing is what distinguishes these from active-mutation admin endpoints.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/V-281 — admin audit-note \+ refund-record \(audit-only\)/);
  });

  // ─── AddSupportNoteRequest 1-field shape ─────────────────────

  it("CRITICAL AddSupportNoteRequestSchema has note: z.string().min(1).max(2000). 1-field shape — operator's free-form context attached to customer's audit log.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /AddSupportNoteRequestSchema = z\.object\(\{\s*\n\s*note: z\.string\(\)\.min\(1\)\.max\(2000\),\s*\n\s*\}\);/,
    );
  });

  it("CRITICAL AddSupportNote framing pins the audit-only contract — 'Audit-only: never touches billing / sessions / keys. Recording does not produce a side effect on the account state.' Drift to letting support-note mutate other state would break the V-281 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/Audit-only: never touches billing \/ sessions \/ keys/);
    expect(p).toMatch(/Recording does\s*\n\s*\*\s*not produce a side effect on the account state/);
  });

  // ─── RecordRefundRequest 4-field shape ───────────────────────

  it('CRITICAL RecordRefundRequestSchema 4 fields — external_reference (3-120) + amount_cents (positive int) + currency? (3-letter ISO, defaults USD) + reason (1-500, REQUIRED). The required-reason is the audit-trail completeness requirement.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /RecordRefundRequestSchema = z\.object\(\{[\s\S]+?external_reference: z\.string\(\)\.min\(3\)\.max\(120\)/,
    );
    expect(p).toMatch(
      /RecordRefundRequestSchema[\s\S]+?amount_cents: z\.number\(\)\.int\(\)\.positive\(\)/,
    );
    expect(p).toMatch(
      /RecordRefundRequestSchema[\s\S]+?currency: z\.string\(\)\.length\(3\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /RecordRefundRequestSchema[\s\S]+?reason: z\.string\(\)\.min\(1\)\.max\(500\)/,
    );
  });

  it("CRITICAL RecordRefund framing pins the Stripe-non-call invariant — 'The endpoint does NOT call Stripe. Money movement happens out-of-band; the audit row is the post-action receipt for compliance and customer support follow-up'. The Stripe-non-call is what protects against accidental double-refunds.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/The endpoint does NOT call Stripe\. Money movement happens/);
    expect(p).toMatch(/out-of-band; the audit row is the post-action receipt for compliance/);
  });

  it("CRITICAL RecordRefund framing pins V-280 + 'tier-3 boundary on direct financial actions'. The framing documents WHY the endpoint is audit-only.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/Per V-280 launch-day-runbook \+ the founder's tier-3 boundary on/);
    expect(p).toMatch(/direct financial actions/);
  });

  // ─── ChangeTierRequest + Suspend + Unsuspend reason bounds ──

  it('CRITICAL ChangeTierRequest + SuspendAccountRequest + UnsuspendAccountRequest all have optional reason: z.string().max(500). The 500-char reason bound is consistent across all 3 admin lifecycle requests.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /ChangeTierRequestSchema = z\.object\(\{[\s\S]+?reason: z\.string\(\)\.max\(500\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /SuspendAccountRequestSchema = z\.object\(\{[\s\S]+?reason: z\.string\(\)\.max\(500\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /UnsuspendAccountRequestSchema = z\.object\(\{\s*\n\s*reason: z\.string\(\)\.max\(500\)\.optional\(\)/,
    );
  });

  // ─── SetQuotaOverride bounds ─────────────────────────────────

  it('CRITICAL SetQuotaOverrideRequest capacity bound = 1 - 1_000_000 + refill_per_second = 0.01 - 100_000 + duration_seconds = 1 - (86400 * 30 = 2,592,000 = 30 days). The bounds prevent both unbounded overrides (DoS via no-cap) + tiny near-zero overrides (UX confusion).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /SetQuotaOverrideRequestSchema = z\.object\(\{[\s\S]+?capacity: z\.number\(\)\.int\(\)\.min\(1\)\.max\(1_000_000\)/,
    );
    expect(p).toMatch(
      /SetQuotaOverrideRequestSchema[\s\S]+?refill_per_second: z\.number\(\)\.min\(0\.01\)\.max\(100_000\)/,
    );
    expect(p).toMatch(
      /SetQuotaOverrideRequestSchema[\s\S]+?duration_seconds: z\s*\.number\(\)\s*\n\s*\.int\(\)\s*\n\s*\.min\(1\)\s*\n\s*\.max\(86_400 \* 30\)/,
    );
  });

  it("CRITICAL SetQuotaOverride duration_seconds comment pins 'up to 30 days' meaning. The 30-day cap is the policy upper-bound for ad-hoc overrides — anything longer should be a permanent enterprise contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/up to 30 days/);
  });

  // ─── QuotaOverrideResponse 8-field shape ─────────────────────

  it('CRITICAL QuotaOverrideResponseSchema has 8 fields — account_id + bucket_key + capacity + refill_per_second + reason (nullable) + expires_at + created_at + updated_at. The 8-field response includes both the override config + audit timestamps.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const m = p.match(/QuotaOverrideResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'account_id:',
      'bucket_key:',
      'capacity:',
      'refill_per_second:',
      'reason:',
      'expires_at:',
      'created_at:',
      'updated_at:',
    ]) {
      expect(body, `QuotaOverrideResponseSchema must have ${f}`).toMatch(new RegExp(f));
    }
  });

  // ─── AdminAccountResponse = AccountSchema alias ──────────────

  it('CRITICAL AdminAccountResponseSchema = AccountSchema (alias). The mutation endpoints return the post-update state via this alias so callers see the result without an extra GET.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/export const AdminAccountResponseSchema = AccountSchema;/);
    expect(p).toMatch(
      /mirrors AccountSchema; returned by mutation endpoints\s*\n\/\/ so callers see the post-update state/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/admin-support-quota-schemas-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
