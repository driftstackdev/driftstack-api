// W435.B — drift guard for packages/api-types/src/admin.ts.
// /v1/admin/* contracts (D-012 + D-025 scope gate). Drift here either
// drops an AdminAuditAction enum value (operator records action, audit
// log silently rejects insert via enum constraint = lost-evidence
// incident) or widens SetQuotaOverride past sane bounds (single
// override locks 1M concurrent sessions per second through the global
// bucket).
//
//   • V-218 ValidationSchedule + Upsert + List shapes.
//   • Tier change / suspend / unsuspend admin request shapes.
//   • V-281 AddSupportNote + RecordRefund framing pinned: audit-only;
//     refund records the out-of-band Stripe action, never calls Stripe
//     (V-280 launch runbook + founder tier-3 boundary).
//   • AdminAccountResponse = AccountSchema mirror.
//   • SetQuotaOverride: bucket enum (global|sessions:create) + capacity
//     1..1M + refill 0.01..100k + duration 1..30d + reason.
//   • V-512 ListDlqQuery endpoint_id drill-down rationale.
//   • AdminAuditAction enum: 21 values (account/webhook/rate-limit/
//     V-100 force/V-281 support/V-295a incidents/V-295c3-tombstone
//     status subscribers/LK.2 mac-node/pricing) — lockstep with DB enum.
//   • V-521 ListAuditLogQuery target_resource_id parity with V-484.
//   • AdminAuditLogEntry shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W435.B packages/api-types/src/admin.ts content parity', () => {
  const body = read(LIB);

  it('Admin API contracts framing pinned: /v1/admin/* routes require admin scope (D-012 + D-025); schemas describe public request/response shape', () => {
    expect(body).toMatch(
      /\/\/ Admin API contracts\. Routes under \/v1\/admin\/\* require the admin\s*\/\/ scope \(see D-012 \+ D-025\)\. These schemas describe the public shape\s*\/\/ of admin requests and responses\./,
    );
  });

  it('imports: z + AccountSchema from accounts.js + AccountTierSchema/Iso8601Schema from common.js', () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ AccountSchema \} from '\.\/accounts\.js';/);
    expect(body).toMatch(/import \{ AccountTierSchema, Iso8601Schema \} from '\.\/common\.js';/);
  });

  it('V-218 ValidationSchedule: id uuid + archetype_id + cadence_seconds positive int + enabled + last_run_at nullable + next_run_at + last_run_id nullable + reason nullable + created/updated_at', () => {
    expect(body).toMatch(/\/\/ V-218 — continuous validation harness/);
    expect(body).toMatch(
      /export const ValidationScheduleSchema = z\.object\(\{\s*id: z\.string\(\)\.uuid\(\),\s*archetype_id: z\.string\(\),\s*cadence_seconds: z\.number\(\)\.int\(\)\.positive\(\),\s*enabled: z\.boolean\(\),\s*last_run_at: z\.string\(\)\.nullable\(\),\s*next_run_at: z\.string\(\),\s*last_run_id: z\.string\(\)\.nullable\(\),\s*reason: z\.string\(\)\.nullable\(\),\s*created_at: z\.string\(\),\s*updated_at: z\.string\(\),\s*\}\);/,
    );
  });

  it('UpsertValidationSchedule: archetype_id min 1 + cadence_seconds int 60..1y + enabled optional default true + reason max 500 optional; ListValidationSchedulesResponse: data array', () => {
    expect(body).toMatch(
      /export const UpsertValidationScheduleRequestSchema = z\.object\(\{\s*archetype_id: z\.string\(\)\.min\(1\),\s*cadence_seconds: z\s*\.number\(\)\s*\.int\(\)\s*\.min\(60\)\s*\.max\(60 \* 60 \* 24 \* 365\),\s*enabled: z\.boolean\(\)\.optional\(\)\.default\(true\),\s*reason: z\.string\(\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const ListValidationSchedulesResponseSchema = z\.object\(\{\s*data: z\.array\(ValidationScheduleSchema\),\s*\}\);/,
    );
  });

  it('ChangeTier / SuspendAccount / UnsuspendAccount: tier + audit-row reason max 500 optional', () => {
    expect(body).toMatch(
      /export const ChangeTierRequestSchema = z\.object\(\{\s*tier: AccountTierSchema,\s*\/\*\* Optional human-readable reason recorded in the audit row\. \*\/\s*reason: z\.string\(\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const SuspendAccountRequestSchema = z\.object\(\{\s*\/\*\* Optional reason recorded in the audit row\. \*\/\s*reason: z\.string\(\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const UnsuspendAccountRequestSchema = z\.object\(\{\s*reason: z\.string\(\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
  });

  it('V-281 AddSupportNote framing pinned: free-form admin note on audit log; operator context the log does not auto-capture (post-incident summary / support call notes / out-of-band action receipts); audit-only, never touches billing/sessions/keys', () => {
    expect(body).toMatch(
      /\*\s*Records a free-form admin note on the customer's audit log\. Operator\s*\*\s*uses this to attach context the audit log doesn't capture\s*\*\s*automatically — post-incident summary, customer-support call notes,\s*\*\s*out-of-band action receipts\./,
    );
    expect(body).toMatch(
      /\*\s*Audit-only: never touches billing \/ sessions \/ keys\. Recording does\s*\*\s*not produce a side effect on the account state\./,
    );
    expect(body).toMatch(
      /export const AddSupportNoteRequestSchema = z\.object\(\{\s*note: z\.string\(\)\.min\(1\)\.max\(2000\),\s*\}\);/,
    );
  });

  it('V-281 RecordRefund framing pinned: operator records manual Stripe-dashboard refund; endpoint does NOT call Stripe (money movement out-of-band); audit row = post-action receipt for compliance + support follow-up; V-280 launch runbook + founder tier-3 boundary on direct financial actions', () => {
    expect(body).toMatch(
      /\*\s*Records that the operator manually issued a refund via the Stripe\s*\*\s*dashboard\. The endpoint does NOT call Stripe\. Money movement happens\s*\*\s*out-of-band; the audit row is the post-action receipt for compliance\s*\*\s*and customer support follow-up\./,
    );
    expect(body).toMatch(
      /\*\s*Per V-280 launch-day-runbook \+ the founder's tier-3 boundary on\s*\*\s*direct financial actions\./,
    );
    expect(body).toMatch(
      /export const RecordRefundRequestSchema = z\.object\(\{\s*\/\*\* The Stripe charge \/ payment_intent \/ invoice id refunded\. \*\/\s*external_reference: z\.string\(\)\.min\(3\)\.max\(120\),\s*\/\*\* Refund amount in cents\. May be partial\. \*\/\s*amount_cents: z\.number\(\)\.int\(\)\.positive\(\),\s*\/\*\* Currency ISO 4217; defaults to USD if omitted\. \*\/\s*currency: z\.string\(\)\.length\(3\)\.optional\(\),\s*\/\*\* Reason recorded on the audit row \+ the customer-visible audit slice\. \*\/\s*reason: z\.string\(\)\.min\(1\)\.max\(500\),\s*\}\);/,
    );
  });

  it('AdminAccountResponse = AccountSchema mirror; returned by mutation endpoints so callers see post-update state without extra GET', () => {
    expect(body).toMatch(
      /\/\/ Admin account view \(mirrors AccountSchema; returned by mutation endpoints\s*\/\/ so callers see the post-update state without an extra GET\)\./,
    );
    expect(body).toMatch(/export const AdminAccountResponseSchema = AccountSchema;/);
  });

  it('SetQuotaOverride: bucket_key enum (global|sessions:create|agent_sessions:message) + capacity int 1..1M + refill_per_second 0.01..100k + duration_seconds int 1..30d + reason optional', () => {
    expect(body).toMatch(
      /export const SetQuotaOverrideRequestSchema = z\.object\(\{\s*bucket_key: z\.enum\(\['global', 'sessions:create', 'agent_sessions:message'\]\),\s*capacity: z\.number\(\)\.int\(\)\.min\(1\)\.max\(1_000_000\),\s*refill_per_second: z\.number\(\)\.min\(0\.01\)\.max\(100_000\),\s*duration_seconds: z\s*\.number\(\)\s*\.int\(\)\s*\.min\(1\)\s*\.max\(86_400 \* 30\), \/\/ up to 30 days\s*reason: z\.string\(\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
  });

  it('ClearQuotaOverrideQuery: bucket_key enum only (3 keys); QuotaOverrideResponse: account_id + bucket_key + capacity + refill_per_second + reason nullable + 3 timestamps', () => {
    expect(body).toMatch(
      /export const ClearQuotaOverrideQuerySchema = z\.object\(\{\s*bucket_key: z\.enum\(\['global', 'sessions:create', 'agent_sessions:message'\]\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const QuotaOverrideResponseSchema = z\.object\(\{\s*account_id: z\.string\(\),\s*bucket_key: z\.string\(\),\s*capacity: z\.number\(\)\.int\(\),\s*refill_per_second: z\.number\(\),\s*reason: z\.string\(\)\.nullable\(\),\s*expires_at: Iso8601Schema,\s*created_at: Iso8601Schema,\s*updated_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('V-512 ListDlqQuery endpoint_id drill-down framing pinned: customer-support workflow ("my endpoint is missing events") — admin pulls just that endpoint\'s DLQ rows without wading through other accounts', () => {
    expect(body).toMatch(
      /\/\/ V-512 — optional drill-down by webhook-endpoint id\. Customer\s*\/\/ support workflow: a customer reports "my endpoint is missing\s*\/\/ events"; admin pulls just that endpoint's DLQ rows without\s*\/\/ wading through other accounts'\./,
    );
    expect(body).toMatch(
      // V-1473 — this pin FROZE the defect. It quoted `cursor: z.string()
      // .optional()`, the bare shape slice 149 exists to eliminate, so the
      // uncapped cursor on GET /v1/admin/webhooks/dlq was not merely unguarded,
      // it was asserted. Re-quoted against the capped source; the comment above
      // the field records why the cap is there.
      /export const ListDlqQuerySchema = z\.object\(\{\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/,
    );
    expect(body).toMatch(/endpoint_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
  });

  it('AdminAuditAction enum: 21 values pinned (3 account + 3 webhook_delivery + 2 rate_limit_override + V-100 2 force + V-281 2 audit-only + V-295a 4 incident + V-295c3 3 status_subscriber + LK.2 1 mac_node + 1 pricing). EXACT order + cardinality is pinned at runtime by the W862 cross-source toEqual (stronger than a source regex); here we assert the declaration + each value + the V-anchor section comments. (2026-06-04: corrected from 16 — api-types had drifted behind the DB enum. 2026-06-05: +pricing.updated, migration 0068.)', () => {
    expect(body).toMatch(/export const AdminAuditActionSchema = z\.enum\(\[/);
    for (const a of [
      'account.tier_changed',
      'account.suspended',
      'account.unsuspended',
      'webhook_delivery.replayed',
      'webhook_delivery.requeued',
      'webhook_delivery.discarded',
      'rate_limit_override.set',
      'rate_limit_override.cleared',
      'session.destroyed_by_admin',
      'api_key.revoked_by_admin',
      'audit_note.added',
      'refund.recorded',
      'incident.created',
      'incident.updated',
      'incident.resolved',
      'incident.reopened',
      'status_subscriber.force_unsubscribed',
      'status_subscriber.purged',
      'status_subscriber.force_subscribed',
      'mac_node.livekit_registered',
      'pricing.updated',
    ]) {
      expect(body, `AdminAuditActionSchema must include '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}'`),
      );
    }
    // V-anchor section comments retained as readable provenance dividers.
    expect(body).toMatch(/\/\/ V-100: force actions on customer resources\./);
    expect(body).toMatch(/\/\/ V-281: customer-support tooling \(audit-only\)\./);
    expect(body).toMatch(/\/\/ V-295a: status-page incident management\./);
    expect(body).toMatch(/\/\/ V-295c3-tombstone: status-page email subscriber admin actions\./);
  });

  it('V-521 ListAuditLogQuery target_resource_id framing pinned: admin-side parity with V-484 customer audit-log filter set; drill into single resource (one webhook delivery) across every admin action that touched it', () => {
    expect(body).toMatch(
      /\/\/ V-521 — admin-side parity with the V-484 customer audit-log\s*\/\/ filter set\. Drill into a single resource \(e\.g\. one webhook\s*\/\/ delivery\) across every admin action that touched it\./,
    );
    expect(body).toMatch(
      /export const ListAuditLogQuerySchema = z\.object\(\{\s*admin_id: z\.string\(\)\.optional\(\),\s*target_id: z\.string\(\)\.optional\(\),\s*action: AdminAuditActionSchema\.optional\(\),\s*from: Iso8601Schema\.optional\(\),\s*to: Iso8601Schema\.optional\(\),/,
    );
    expect(body).toMatch(/target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
    expect(body).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),/,
    );
  });

  it('AdminAuditLogEntry: id uuid + admin_account_id + admin_key_id + action + target_account_id nullable + target_resource_id nullable + input_payload record nullable + result + ip_address nullable + timestamp', () => {
    expect(body).toMatch(
      /export const AdminAuditLogEntrySchema = z\.object\(\{\s*id: z\.string\(\)\.uuid\(\),\s*admin_account_id: z\.string\(\),\s*admin_key_id: z\.string\(\),\s*action: AdminAuditActionSchema,\s*target_account_id: z\.string\(\)\.nullable\(\),\s*target_resource_id: z\.string\(\)\.nullable\(\),\s*input_payload: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*result: z\.string\(\),\s*ip_address: z\.string\(\)\.nullable\(\),\s*timestamp: Iso8601Schema,\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
