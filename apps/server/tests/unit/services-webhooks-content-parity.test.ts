// W406.A — drift guard for apps/server/src/services/webhooks.ts.
// Webhooks management + event-emission + fan-out. Drift here either
// scrambles V-174 admin scope gates (account_owner can mint
// webhooks bypass), opens an http:// URL injection (security), or
// re-enables a disabled endpoint (tombstone audit-trail break).
//
//   • WebhookEventType: 6-literal union (5 customer subscribable +
//     V-356 test.ping synthetic — Zod schemas reject customer
//     subscriptions).
//   • WebhookDeliveryStatus: 5-literal union (pending / in_flight /
//     delivered / failed / dlq).
//   • V-359 secretPrev + secretPrevExpiresAt: nullable rotation
//     grace columns; worker dual-signs while secretPrevExpiresAt >
//     now.
//   • MAX_ENDPOINTS_PER_ACCOUNT = 10.
//   • V-326e5 effective-account: when set, route layer enforces team-
//     admin role; service skips api-key scope check (member's own
//     apiKey may carry account_owner not admin).
//   • create + update + delete + rotateSecret: account_owner scope
//     when self-account (V-174 — web sessions carry account_owner,
//     not admin; admin still satisfies via alias); route-side team-
//     admin gate when effective-account override.
//   • V-359 rotateSecret: 24h grace default; secretPrev=oldSecret +
//     secretPrevExpiresAt=now+grace; cannot rotate on disabled.
//   • parseHttpsUrl: https only (http:// rejected for security);
//     malformed → ConflictError.
//   • update: disabled-endpoint tombstone (disabledAt sticky — mint
//     fresh instead).
//   • delete: idempotent on already-disabled (no audit emit on
//     no-op).
//   • V-185 listWithCounts: per-endpoint delivery counts via 2-query
//     parallel; defaults to zeros.
//   • V-356 sendTestEvent: synthetic test.ping; rejects disabled
//     endpoint via BadRequestError.
//   • V-307 replayDeliveryAsCustomer: account_owner scope + account-
//     scope check on owning endpoint.
//   • enqueueEvent: defence-in-depth skip on disabled endpoints
//     even if repo returned them.
//   • V-225 emitAuditBestEffort: 4-action union (webhook_endpoint.
//     created/updated/deleted/secret_rotated).
//   • WebhooksAdminService: driftstack_internal_admin scope-gated (V-174);
//     requeueFromDlq refuses non-DLQ status.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W406.A apps/server/src/services/webhooks.ts content parity', () => {
  const body = read(LIB);

  it('WebhookEventType: 9-literal union (8 customer events + V-356 test.ping synthetic); retired quota declarations stay absent.', () => {
    expect(body).toMatch(/export type WebhookEventType =/);
    expect(body).toMatch(/\| 'session\.completed'/);
    expect(body).toMatch(/\| 'session\.failed'/);
    expect(body).toMatch(/\| 'api_key\.revoked'/);
    expect(body).toMatch(
      /\/\/ V-356 — synthetic event sent only via POST \/v1\/webhooks\/:id\/test\.\s*\/\/ Customers cannot subscribe to it \(Zod schemas reject it\)/,
    );
    expect(body).toMatch(/\| 'test\.ping'/);
    expect(body).toMatch(/\| 'session\.egress_capability_changed'/);
    expect(body).toMatch(/\| 'crypto\.order\.paid'/);
    expect(body).toMatch(/\| 'crypto\.order\.failed'/);
    expect(body).toMatch(/\| 'session\.challenge_detected'/);
    expect(body).toMatch(/\| 'session\.profile_save_failed';/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it('WebhookDeliveryStatus: 5-literal union (pending/in_flight/delivered/failed/dlq)', () => {
    expect(body).toMatch(
      /export type WebhookDeliveryStatus = 'pending' \| 'in_flight' \| 'delivered' \| 'failed' \| 'dlq';/,
    );
  });

  it('V-359 secretPrev + secretPrevExpiresAt rotation grace; worker dual-signs while secretPrevExpiresAt > now', () => {
    expect(body).toMatch(
      /\/\*\* V-359 — previous signing secret during the rotation grace\s*\*\s*period\. Null when no rotation in flight or grace expired\. The\s*\*\s*worker dual-signs every outbound delivery with both `secret`\s*\*\s*and `secretPrev` while `secretPrevExpiresAt > now`\. \*\/\s*secretPrev: string \| null;\s*secretPrevExpiresAt: Date \| null;/,
    );
  });

  it('MAX_ENDPOINTS_PER_ACCOUNT = 10', () => {
    expect(body).toMatch(/const MAX_ENDPOINTS_PER_ACCOUNT = 10;/);
  });

  it("V-326e5/V-174 create: when effectiveAccountId set → trust route's team-admin gate; else throwIfMissingScope 'account_owner'", () => {
    expect(body).toMatch(
      /\/\/ V-326e5 — when effectiveAccountId is set, the route layer has\s*\/\/ already enforced team admin role on the OWNER's team\. Trust\s*\/\/ that decision and skip the account_owner apiKey-scope check/,
    );
    expect(body).toMatch(
      /if \(opts\.effectiveAccountId === undefined\) \{\s*throwIfMissingScope\(ctx, 'account_owner'\);/,
    );
  });

  it('create: events.length===0 → ConflictError; atomic insertEndpointIfUnderLimit cap (null → ConflictError); emits webhook_endpoint.created audit', () => {
    expect(body).toMatch(
      /if \(input\.events\.length === 0\) \{\s*throw new ConflictError\('events must contain at least one event type\.'\);/,
    );
    // TOCTOU fix — the cap is enforced atomically by insertEndpointIfUnderLimit
    // (count+insert under a per-account advisory lock); null → over the cap.
    expect(body).toMatch(/await this\.repo\.insertEndpointIfUnderLimit\(/);
    expect(body).toMatch(/if \(row === null\) \{\s*throw new ConflictError\(/);
    expect(body).toMatch(
      // V-735 — the helper now takes the account the ROW belongs to (the owner
      // under a team-scoped write) as its second argument. It used to hardcode
      // `accountId: ctx.account.id`, so a team admin's change to the owner's
      // endpoint landed in the MEMBER's audit log and left the owner's empty.
      // Dropping this argument silently restores that, so it is pinned.
      /await this\.emitAuditBestEffort\(\s*ctx,\s*accountId,\s*'webhook_endpoint\.created',\s*`webhook_endpoint_\$\{row\.id\}`,\s*\{\s*url: url\.toString\(\),\s*events: input\.events,\s*\},\s*\);/,
    );
  });

  it('update: disabled-endpoint sticky tombstone (mint fresh instead); events empty → ConflictError', () => {
    expect(body).toMatch(
      /if \(before\.disabledAt !== null\) \{\s*throw new ConflictError\('Cannot update a disabled endpoint\. Mint a fresh one instead\.'\);/,
    );
    expect(body).toMatch(
      /if \(input\.events !== undefined && input\.events\.length === 0\) \{\s*throw new ConflictError\('events must contain at least one event type\.'\);/,
    );
  });

  it('V-359 rotateSecret: 24h grace default; cannot rotate disabled; emits webhook_endpoint.secret_rotated audit with new+old prefix + grace_expires_at', () => {
    expect(body).toMatch(
      /V-359 — rotate the signing secret with a 24h grace\. Returns the\s*\*\s*fresh plaintext secret ONCE alongside the updated row\./,
    );
    expect(body).toMatch(
      /if \(before\.disabledAt !== null\) \{\s*throw new ConflictError\('Cannot rotate the secret on a disabled endpoint\.'\);/,
    );
    expect(body).toMatch(
      /const graceMs = opts\.graceMs \?\? 24 \* 60 \* 60 \* 1000; \/\/ 24h default/,
    );
    expect(body).toMatch(
      /'webhook_endpoint\.secret_rotated',\s*`webhook_endpoint_\$\{id\}`,\s*\{\s*new_secret_prefix: newPrefix,\s*old_secret_prefix: before\.secretPrefix,\s*grace_expires_at: graceExpiresAt\.toISOString\(\),/,
    );
  });

  it('delete: idempotent on already-disabled (no audit emit on no-op); emits webhook_endpoint.deleted audit otherwise', () => {
    expect(body).toMatch(
      /if \(row\.disabledAt !== null\) return; \/\/ idempotent — no audit emit on no-op/,
    );
    expect(body).toMatch(/await this\.repo\.disableEndpoint\(id, new Date\(\)\);/);
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(\s*ctx,\s*accountId,\s*'webhook_endpoint\.deleted',\s*`webhook_endpoint_\$\{id\}`,/,
    );
  });

  it('V-185 listWithCounts: 2-query parallel Promise.all + per-endpoint zeros default + V-330f read-only role-agnostic', () => {
    expect(body).toMatch(
      /V-185 — list endpoints \+ per-endpoint aggregate delivery counts\s*\*\s*\(delivered \/ failed \/ dlq\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-330f — when effectiveAccountId is set, lists the OWNER's\s*\/\/ endpoints\. Read-only; both 'member' and 'admin' roles allowed\./,
    );
    expect(body).toMatch(
      /const \[endpoints, countsMap\] = await Promise\.all\(\[\s*this\.repo\.listEndpoints\(accountId\),\s*this\.repo\.deliveryCountsByEndpoint\(accountId\),\s*\]\);/,
    );
    expect(body).toMatch(
      /counts: countsMap\.get\(endpoint\.id\) \?\? \{ delivered: 0, failed: 0, dlq: 0 \},/,
    );
  });

  it('V-356 sendTestEvent: synthetic test.ping; admin/team-admin gate; disabled-endpoint → BadRequestError', () => {
    expect(body).toMatch(
      /V-356 — enqueue a one-off `test\.ping` delivery to a single\s*\*\s*endpoint, regardless of subscription\./,
    );
    expect(body).toMatch(
      /if \(!row\.active \|\| row\.disabledAt !== null\) \{\s*throw new BadRequestError\(\s*'This endpoint is paused\. Re-enable it before sending a test event\.',\s*\);/,
    );
    expect(body).toMatch(/type: 'test\.ping' as WebhookEventType,/);
    expect(body).toMatch(/triggered_by_account_id: `acc_\$\{ctx\.account\.id\}`,/);
  });

  // S32 2026-07-07 (fable-frontend-audit) — replay now honours team act-as like every other
  // delivery surface (it was the only one scoping ownership to the
  // member's own account, so team replays 404'd). Scope check is
  // skipped when the route resolved an effective team account
  // (mirrors create()/listDeliveries()).
  it('V-307+S32 replayDeliveryAsCustomer: effective-account ownership + conditional scope + webhook_delivery.replayed audit', () => {
    expect(body).toMatch(/replay was the ONLY delivery surface that\s*\/\/ ignored team act-as/);
    expect(body).toMatch(
      /if \(opts\.effectiveAccountId === undefined\) \{\s*throwIfMissingScope\(ctx, 'account_owner'\);/,
    );
    expect(body).toMatch(
      /const endpoint = await this\.repo\.findEndpoint\(delivery\.webhookId, accountId\);/,
    );
    expect(body).toMatch(
      /action: 'webhook_delivery\.replayed',\s*targetResourceId: `wdl_\$\{deliveryId\}`,/,
    );
  });

  it('enqueueEvent: session.failed is closed before lookup/persistence; unrelated event data passes through; disabled endpoints are skipped', () => {
    expect(body).toMatch(
      /const closedData = eventType === 'session\.failed' \? projectSessionFailedData\(data\) : data;/,
    );
    expect(body).toMatch(
      /\/\/ Skip endpoints that are disabled even if listEndpointsSubscribedTo\s*\/\/ returned them \(defence in depth\)\.\s*if \(!ep\.active \|\| ep\.disabledAt !== null\) continue;/,
    );
    expect(body).toMatch(
      /const payload = \{ id: eventId, type: eventType, created_at: createdAt, data: closedData \};/,
    );
  });

  it('V-225 emitAuditBestEffort: 4-action union (webhook_endpoint.created/updated/deleted/secret_rotated)', () => {
    expect(body).toMatch(
      /V-225 — optional customer-facing audit log\. When wired, emits\s*\*\s*webhook_endpoint\.created \/ webhook_endpoint\.deleted entries\./,
    );
    expect(body).toMatch(
      /action:\s*\| 'webhook_endpoint\.created'\s*\| 'webhook_endpoint\.updated'\s*\| 'webhook_endpoint\.deleted'\s*\| 'webhook_endpoint\.secret_rotated',/,
    );
    // V-735 — the row is scoped to the passed account; only the ACTOR is the
    // caller. Both halves matter: an owner-scoped row with the member recorded
    // as actor is what makes a team change answerable to the owner.
    expect(body).toMatch(
      /private async emitAuditBestEffort\(\s*ctx: AccountContext,\s*accountId: string,/,
    );
    expect(body).toMatch(
      /await this\.accountAudit\.record\(\{\s*accountId,\s*actorType: 'customer',\s*actorAccountId: ctx\.account\.id,/,
    );
  });

  it('WebhooksAdminService: all six operations require exact driftstack_internal_admin; legacy customer admin is insufficient; requeueFromDlq refuses non-DLQ status', () => {
    expect(body).toMatch(/export class WebhooksAdminService \{/);
    const adminService = body.slice(
      body.indexOf('export class WebhooksAdminService'),
      body.indexOf('function parseHttpsUrl'),
    );
    expect(
      adminService.match(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/g) ?? [],
    ).toHaveLength(6);
    expect(adminService).not.toMatch(/throwIfMissingScope\(ctx, 'admin'\);/);
    expect(body).toMatch(
      /async requeueFromDlq\(ctx: AccountContext, deliveryId: string\): Promise<WebhookDeliveryRow> \{\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/,
    );
    expect(body).toMatch(/if \(current\.status !== 'dlq'\) \{\s*throw new ConflictError\(/);
  });

  it('parseHttpsUrl: https:// only; http:// rejected for security; malformed → ConflictError', () => {
    expect(body).toMatch(
      /function parseHttpsUrl\(raw: string\): string \{\s*let url: URL;\s*try \{\s*url = new URL\(raw\);\s*\} catch \{\s*throw new ConflictError\(`Invalid URL: \$\{raw\}`\);/,
    );
    expect(body).toMatch(
      /if \(url\.protocol !== 'https:'\) \{\s*throw new ConflictError\('Webhook URL must use https:\/\/ — http:\/\/ is rejected for security\.'\);/,
    );
  });

  it("V-512 listDlqDeliveries opts: optional endpointId drills into one webhook's DLQ; unset returns rows across every account", () => {
    expect(body).toMatch(
      /V-512 — optional `endpointId` drills into one webhook endpoint's\s*\*\s*DLQ rows \(uuid; the route layer strips the `webhook_endpoint_`\s*\*\s*prefix before forwarding\)\. When unset, returns rows across every\s*\*\s*account\./,
    );
    expect(body).toMatch(
      /listDlqDeliveries\(opts: \{\s*limit: number;\s*cursor\?: string;\s*endpointId\?: string;\s*\}\): Promise<ListDeliveriesPage>;/,
    );
  });

  it('imports: randomUUID + errors/scope/signing + closed session.failed projector + service types', () => {
    expect(body).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
    expect(body).toMatch(
      /import \{ generateWebhookSecret, webhookSecretPrefix \} from '\.\.\/lib\/webhook-signing\.js';/,
    );
    expect(body).toMatch(
      /import \{ projectSessionFailedData \} from '\.\.\/lib\/session-event-metadata\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
