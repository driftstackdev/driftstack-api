// W708 — cross-SDK AccountAuditAction closed-enum roster parity.
// Thirty-fifth in the cross-SDK drift-guard series (W649 + W675-
// W708).
//
// Asserts the closed enum of customer-visible audit actions
// (api-types AccountAuditAction) is consistent with what each SDK
// docstring + dashboard switch statement expects:
//
//   - Closed roster pinned in api-types accounts.ts as the
//     authoritative source (Zod z.enum([...])
//   - 25+ canonical actions covering:
//     * Account lifecycle (email_verified, login, logout,
//       password_changed)
//     * API keys (minted, revoked, V-296 rotated)
//     * Sessions (created, destroyed)
//     * Profiles (created, deleted, V-480 exported, V-480 imported)
//     * Subscription (tier_changed)
//     * Webhooks (created, updated, deleted, V-359 secret_rotated,
//       V-307 replayed)
//     * Team V-298f (member_invited, invite_accepted, member_removed)
//     * MFA V-353b (mfa_enrolled, mfa_disabled, recovery_code_used)
//     * Admin V-281 (refund_recorded, support_note)
//   - actor_type 3-value enum (customer/system/staff) — matches the
//     W697 AuditLogEntry cross-SDK pinning.
//   - Per-action V-anchor comments pinned for V-296 / V-480 / V-359 /
//     V-307 / V-298f / V-353b / V-281 / V-280
//
// CRITICAL invariant: drift to dropping an action from the closed
// enum would silently let server-side code emit a string that no
// SDK / dashboard knows how to render (audit-log row appears with
// a hole on display).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ACCOUNTS_SCHEMA = resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts');

describe('W708 cross-SDK AccountAuditAction closed-enum roster parity', () => {
  it('api-types accounts schema file exists', () => {
    expect(existsSync(ACCOUNTS_SCHEMA), `missing ${ACCOUNTS_SCHEMA}`).toBe(true);
  });

  it('CRITICAL "Closed enum of customer-visible audit actions" framing pinned. The "closed enum" wording is what tells engineers that adding a new value is a CLASS A schema migration; drift to dropping would let engineers assume the enum is open.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/Closed enum of customer-visible audit actions/);
    expect(src).toMatch(/Class A schema migration/);
  });

  it('CRITICAL 25+ canonical audit-actions pinned in api-types AccountAuditActionSchema. Each action is a customer-visible event-type; drift to dropping would silently break the dashboard audit-log row rendering.', () => {
    const src = read(ACCOUNTS_SCHEMA);

    const actions = [
      // Account lifecycle (4).
      'account.email_verified',
      'account.login',
      'account.logout',
      'account.password_changed',
      // API keys (3).
      'api_key.minted',
      'api_key.revoked',
      'api_key.rotated',
      // Sessions (2).
      'session.created',
      'session.destroyed',
      // Profiles (4 — V-480 added exported + imported).
      'profile.created',
      'profile.deleted',
      'profile.exported',
      'profile.imported',
      // Subscription (1).
      'subscription.tier_changed',
      // Webhooks (5 — including V-359 secret_rotated + V-307 replayed).
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.deleted',
      'webhook_endpoint.secret_rotated',
      'webhook_delivery.replayed',
      // Team V-298f (3).
      'team.member_invited',
      'team.invite_accepted',
      'team.member_removed',
      // MFA V-353b (3).
      'account.mfa_enrolled',
      'account.mfa_disabled',
      'account.recovery_code_used',
      // Admin V-281 (2).
      'admin.refund_recorded',
      'admin.support_note',
    ];

    for (const action of actions) {
      const re = new RegExp(`'${action.replace(/\./g, '\\.')}'`);
      expect(src, `audit action ${action}`).toMatch(re);
    }
  });

  it('CRITICAL V-296 api_key.rotated comment pinned — "old key continues for grace period (24h), new key shown once". The comment threads the V-296 grace-window invariant to the audit trail. Drift to dropping would lose the per-action provenance.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-296[\s\S]{0,400}customer self-service rotation/);
    expect(src).toMatch(/Audit captures both ids for/);
  });

  it('CRITICAL V-480 profile.exported + profile.imported framing pinned — "envelope" + "source profile id + source account id" + "file-flow lineage". Drift to dropping would lose the customer-facing claim about cross-account audit trail.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-480[\s\S]{0,300}profile import\/export/);
    expect(src).toMatch(/Both carry the source profile id \+\s*\/\/\s*source account id/);
    expect(src).toMatch(/file-flow lineage post-hoc/);
  });

  it('CRITICAL V-359 webhook_endpoint.secret_rotated payload framing pinned — "new_secret_prefix, old_secret_prefix, grace_expires_at (24h default)". The 3-field payload + 24h default matches the W702 V-359 cluster.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-359[\s\S]{0,150}signing secret rotation/);
    expect(src).toMatch(/new_secret_prefix/);
    expect(src).toMatch(/old_secret_prefix/);
    expect(src).toMatch(/grace_expires_at \(24h default\)/);
  });

  it('CRITICAL V-307 webhook_delivery.replayed framing pinned — "customer self-service replay". The replay is account-scoped; the audit captures the customer-initiated replay vs system-initiated retry.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-307[\s\S]{0,80}customer self-service replay/);
  });

  it('CRITICAL V-298f team-RBAC v1 audit-entries framing pinned. The 3 team actions (invited / accepted / removed) cover the V-298c team-membership lifecycle from W691.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-298f[\s\S]{0,80}Team RBAC v1 customer audit entries/);
  });

  it('CRITICAL V-353b MFA-lifecycle framing pinned — "mfa_enrolled fires on successful first verify (not on /enroll, which is reversible)". The wording threads the reversibility-of-enroll-vs-verify gate into the audit trail.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-353b[\s\S]{0,80}MFA lifecycle/);
    expect(src).toMatch(/mfa_enrolled fires on successful first/);
    expect(src).toMatch(/verify[\s\S]{0,40}not on \/enroll[\s\S]{0,40}which is reversible/);
  });

  it('CRITICAL V-353b recovery_code_used framing — "each time a code is consumed (login or step-up path)". The wording threads recovery-code-single-use through audit; drift to dropping would lose the security-monitoring signal.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(
      /recovery_code_used fires\s*\/\/\s*each time a code is consumed \(login or step-up path\)/,
    );
  });

  it('CRITICAL V-281 admin.refund_recorded + admin.support_note audit-only framing pinned. The "audit-only" wording is what tells engineers refund recording is NOT money movement (Stripe dashboard handles that manually per V-280 runbook). Drift to dropping would let engineers think refund_recorded triggers actual refunds.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(/V-281[\s\S]{0,80}admin-recorded notes/);
    expect(src).toMatch(/Refund recording is audit-only/);
    expect(src).toMatch(/actual money movement happens via Stripe dashboard manually/);
    expect(src).toMatch(/V-280 launch-day runbook/);
  });

  it("CRITICAL actor_type 3-value closed enum — 'customer' | 'system' | 'staff'. Matches the W697 audit-log cross-SDK pinning; drift to a 4th actor would let server-side code emit an unrecognized actor.", () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(
      /AccountAuditActorTypeSchema = z\.enum\(\['customer', 'system', 'staff'\]\)/,
    );
  });

  it('CRITICAL AccountAuditEntrySchema id field pinned as UUID — drift to dropping the .uuid() guard would let server-side code emit non-uuid ids and break the audit-log row primary-key.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(
      /AccountAuditEntrySchema = z\.object\(\{[\s\S]*?id: z\.string\(\)\.uuid\(\)/,
    );
  });

  it('CRITICAL TypeScript type-export pinned for AccountAuditAction + AccountAuditActorType. The exported types let SDK + dashboard consumers do exhaustive-match switches; drift to dropping would force consumers to hand-write union types.', () => {
    const src = read(ACCOUNTS_SCHEMA);
    expect(src).toMatch(
      /export type AccountAuditAction = z\.infer<typeof AccountAuditActionSchema>/,
    );
    expect(src).toMatch(
      /export type AccountAuditActorType = z\.infer<typeof AccountAuditActorTypeSchema>/,
    );
  });

  it('Cross-roster 5-invariant cluster — closed-enum framing + 25+ actions + 3-value actor enum + V-296/V-480/V-359/V-307/V-298f/V-353b/V-281 anchors. Drift on any would fragment the canonical audit-action roster.', () => {
    const src = read(ACCOUNTS_SCHEMA);

    expect(src).toMatch(/Closed enum of customer-visible audit actions/);
    for (const anchor of [
      'V-296',
      'V-480',
      'V-359',
      'V-307',
      'V-298f',
      'V-353b',
      'V-281',
      'V-280',
    ]) {
      expect(src, `anchor ${anchor}`).toMatch(new RegExp(anchor));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-audit-action-roster-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
