// W439.A — drift guard for apps/server/src/routes/webhooks.ts.
// Customer-facing webhook subscription routes. Drift here either
// silently extends the customer-self-service-replay endpoint past
// account-scoped 404-on-foreign-delivery (V-307) — leaking other
// accounts' delivery state — or weakens the V-359 rotate-secret
// grace contract (returns the new plaintext more than once / loses
// the prev_secret_prefix first-12-chars convention).
//
//   • POST/GET/GET-one/PATCH/DELETE/deliveries-list +
//     V-307 customer-replay + V-359 rotate-secret + V-356 test.ping.
//   • whk_<uuid> + wdl_<uuid> public-id prefixes.
//   • V-326e5 admin-only gate on team-scoped writes (create / update
//     / delete / rotate-secret / send-test); V-330f reads accept both.
//   • V-359 rotation state surface: prev_secret_prefix = first 12
//     chars of secretPrev (non-sensitive, same shape as
//     secret_prefix); rotation_grace_expires_at lets dashboard show
//     "rotation ends in <X>"; both null when no rotation in flight.
//   • V-185 aggregate per-endpoint delivery_counts on list/get.
//   • V-359 rotate: new plaintext ONCE; worker dual-signs outbound
//     with both new+old while secret_prev_expires_at > now (24h
//     default).
//   • V-356 test.ping: synthetic event bypasses subscription; lets
//     customer verify handler before relying on it.
//   • V-307 customer self-service replay: account-scoped (404 if
//     delivery not owned by calling account); admin-replay path
//     can replay any account's delivery.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W439.A apps/server/src/routes/webhooks.ts content parity', () => {
  const body = read(LIB);

  it('header framing pinned: POST/GET/DELETE /v1/webhooks + GET /v1/webhooks/:id/deliveries', () => {
    expect(body).toMatch(
      /\/\/ Webhook subscription routes — POST\/GET\/DELETE \/v1\/webhooks\s*\n?\s*\/\/ \+ GET \/v1\/webhooks\/:id\/deliveries\./,
    );
  });

  it('imports: CreateWebhookRequest + ListDeliveriesQuery + UpdateWebhookRequest from api-types; BadRequest/Forbidden errors; WebhookDelivery/Endpoint/Service rows; resolveEffectiveAccount', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*CreateWebhookRequestSchema,\s*\n?\s*ListDeliveriesQuerySchema,\s*\n?\s*UpdateWebhookRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*WebhookDeliveryRow,\s*\n?\s*WebhookEndpointRow,\s*\n?\s*WebhooksService,\s*\n?\s*\} from '\.\.\/services\/webhooks\.js';/,
    );
  });

  it('target guard: create + update reject private/reserved or credential-bearing webhook URLs', () => {
    expect(body).toMatch(
      /import \{ unsafeWebhookTargetReason \} from '\.\.\/lib\/webhook-target-guard\.js';/,
    );
    // create path
    expect(body).toMatch(/const unsafe = unsafeWebhookTargetReason\(body\.url\);/);
    expect(body).toMatch(/if \(unsafe !== null\) throw new BadRequestError\(unsafe\);/);
    // update path (url is optional on PATCH)
    expect(body).toMatch(/if \(parsed\.data\.url !== undefined\) \{/);
    expect(body).toMatch(/const unsafe = unsafeWebhookTargetReason\(parsed\.data\.url\);/);
  });

  it('V-326e5 effectiveAccountIdForWrite framing pinned: admin-only gate for webhook write operations on team owners; throws ForbiddenError "Webhook writes on a team owner require admin role on that team."', () => {
    expect(body).toMatch(
      /\*\s*V-326e5 — admin-only gate for webhook write operations on team\s*\n?\s*\*\s*owners\. Returns the effective accountId \(string\) when team write\s*\n?\s*\*\s*should proceed, or undefined when self-scoped\. Throws ForbiddenError\s*\n?\s*\*\s*on member-role team requests\./,
    );
    expect(body).toMatch(
      /throw new ForbiddenError\('Webhook writes on a team owner require admin role on that team\.'\);/,
    );
  });

  it('PUBLIC_ID_RE (3-letter prefix + UUID) + uuidFromPrefixedId expectedPrefix check', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
  });

  it('V-359 publicEndpoint rotation surface framing pinned: prev_secret_prefix = first-12-chars of secretPrev (non-sensitive, same shape as current secret_prefix display); rotation_grace_expires_at lets dashboard show "rotation ends in <X>" so customers know how much longer dual-signing in effect; both null when no rotation in flight', () => {
    expect(body).toMatch(
      /\/\/ V-359 — surface the rotation grace state when active\. The previous\s*\n?\s*\/\/ secret's first-12-chars are non-sensitive \(same shape as the\s*\n?\s*\/\/ current secret_prefix display\); the grace expiry lets the\s*\n?\s*\/\/ dashboard show "rotation ends in <X>" so customers know how much\s*\n?\s*\/\/ longer dual-signing is in effect\. Both null when no rotation in\s*\n?\s*\/\/ flight\./,
    );
    expect(body).toMatch(
      /const rotationActive =\s*\n?\s*row\.secretPrev !== null &&\s*\n?\s*row\.secretPrevExpiresAt !== null &&\s*\n?\s*row\.secretPrevExpiresAt\.getTime\(\) > Date\.now\(\);/,
    );
    expect(body).toMatch(
      /prev_secret_prefix:\s*\n?\s*rotationActive && row\.secretPrev !== null \? row\.secretPrev\.slice\(0, 12\) : null,\s*\n?\s*rotation_grace_expires_at:\s*\n?\s*rotationActive && row\.secretPrevExpiresAt !== null\s*\n?\s*\? row\.secretPrevExpiresAt\.toISOString\(\)\s*\n?\s*: null,/,
    );
  });

  it('V-185 publicEndpoint: aggregate per-endpoint delivery_counts (delivered + failed + dlq); default {0,0,0}', () => {
    expect(body).toMatch(
      /counts: \{ delivered: number; failed: number; dlq: number \} = \{\s*\n?\s*delivered: 0,\s*\n?\s*failed: 0,\s*\n?\s*dlq: 0,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /\/\*\* V-185 — aggregate per-endpoint delivery counts\. \*\/\s*\n?\s*delivery_counts: counts,/,
    );
  });

  it('publicDelivery mapper: id wdl_ + webhook_id whk_ + event_id + event_type + status + attempts + next_attempt_at + last_response_status + last_response_excerpt + last_error + delivered_at nullable + created_at', () => {
    expect(body).toMatch(
      /function publicDelivery\(row: WebhookDeliveryRow\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: `wdl_\$\{row\.id\}`,\s*\n?\s*webhook_id: `whk_\$\{row\.webhookId\}`,\s*\n?\s*event_id: row\.eventId,\s*\n?\s*event_type: row\.eventType,\s*\n?\s*status: row\.status,\s*\n?\s*attempts: row\.attempts,\s*\n?\s*next_attempt_at: row\.nextAttemptAt\.toISOString\(\),\s*\n?\s*last_response_status: row\.lastResponseStatus,\s*\n?\s*last_response_excerpt: row\.lastResponseExcerpt,\s*\n?\s*last_error: row\.lastError,\s*\n?\s*delivered_at: row\.deliveredAt \? row\.deliveredAt\.toISOString\(\) : null,\s*\n?\s*created_at: row\.createdAt\.toISOString\(\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('V-326e5 POST /v1/webhooks: admin-only when targeting team owner; CreateWebhookRequest parse; response = publicEndpoint(created.row) + secret plaintext (returned once)', () => {
    expect(body).toMatch(/\/\/ V-326e5 — admin-only when targeting a team owner\./);
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*\.\.\.publicEndpoint\(created\.row\),\s*\n?\s*secret: created\.plaintextSecret,\s*\n?\s*\}\);/,
    );
  });

  it('V-330f GET /v1/webhooks framing pinned: read endpoints + per-endpoint counts scoped to OWNER when X-Driftstack-Account set; read-only — both roles allowed; POST/DELETE on webhooks remain self-only until V-326e write-side cycle picks them up (admin-only per Q1)', () => {
    expect(body).toMatch(
      /\/\/ V-330f — read endpoints \+ per-endpoint counts, scoped to the\s*\n?\s*\/\/ OWNER when X-Driftstack-Account is set\. Read-only; both roles\s*\n?\s*\/\/ allowed\. POST\/DELETE on webhooks remain self-only until the\s*\n?\s*\/\/ V-326e write-side cycle picks them up \(admin-only per Q1\)\./,
    );
    expect(body).toMatch(
      /const rowsWithCounts = await service\.listWithCounts\(\s*\n?\s*ctx,\s*\n?\s*effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\},\s*\n?\s*\);\s*\n?\s*return \{ data: rowsWithCounts\.map\(\(r\) => publicEndpoint\(r\.endpoint, r\.counts\)\) \};/,
    );
  });

  it('V-351 PATCH /v1/webhooks/:id framing pinned: partial update; mirror of POST/DELETE V-326e5 admin-only-on-team gate; disabled endpoints cannot be updated (repo enforces; 409); UpdateWebhookRequest safeParse → BadRequest with first-issue message fallback "Invalid body."', () => {
    expect(body).toMatch(
      /\/\/ V-351 — partial update\. Mirror of POST \+ DELETE for the\s*\n?\s*\/\/ V-326e5 admin-only-on-team gate\. Disabled endpoints cannot be\s*\n?\s*\/\/ updated \(the repo enforces; this returns 409\)\./,
    );
    expect(body).toMatch(
      /const parsed = UpdateWebhookRequestSchema\.safeParse\(request\.body\);\s*\n?\s*if \(!parsed\.success\)\s*\n?\s*throw new BadRequestError\(parsed\.error\.issues\[0\]\?\.message \?\? 'Invalid body\.'\);/,
    );
  });

  it('GET /v1/webhooks/:id/deliveries: ListDeliveriesQuery parse; service.listDeliveries({limit, cursor?, status?, effectiveAccountId?}) → data + has_more (nextCursor !== null) + next_cursor', () => {
    expect(body).toMatch(
      /const page = await service\.listDeliveries\(ctx, id, \{\s*\n?\s*limit: query\.limit,\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(query\.status !== undefined \? \{ status: query\.status \} : \{\}\),\s*\n?\s*\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),\s*\n?\s*\}\);\s*\n?\s*return \{\s*\n?\s*data: page\.items\.map\(publicDelivery\),\s*\n?\s*has_more: page\.nextCursor !== null,\s*\n?\s*next_cursor: page\.nextCursor,\s*\n?\s*\};/,
    );
  });

  it("V-307 customer self-service replay framing pinned: account-scoped; 404s if delivery not owned by calling account; different from admin /v1/admin/webhook-deliveries/:id/replay which can replay any account's delivery; 200 with publicDelivery(updated)", () => {
    expect(body).toMatch(
      /\/\/ V-307 — customer self-service replay\. Different from the admin\s*\n?\s*\/\/ \/v1\/admin\/webhook-deliveries\/:id\/replay \(which can replay any\s*\n?\s*\/\/ account's delivery\): this one is account-scoped and 404s if the\s*\n?\s*\/\/ delivery isn't owned by the calling account\./,
    );
    // Fable audit-2 2026-07-08 (C5) — replay RE-FIRES the delivery (a write), so
    // it takes the admin-only-on-team gate (effectiveAccountIdForWrite throws for
    // a member role), NOT the read-only act-as S32 originally wired. Same gate as
    // create/update/delete/rotate.
    expect(body).toMatch(
      /const deliveryId = uuidFromPrefixedId\(request\.params\.deliveryId, 'wdl'\);/,
    );
    expect(body).toMatch(
      /const eff = effectiveAccountIdForWrite\(request, ctx\);\s*\n?\s*const updated = await service\.replayDeliveryAsCustomer\(ctx, deliveryId, \{\s*\n?\s*\.\.\.\(eff !== undefined \? \{ effectiveAccountId: eff \} : \{\}\),\s*\n?\s*\}\);\s*\n?\s*return reply\.code\(200\)\.send\(publicDelivery\(updated\)\);/,
    );
  });

  it('V-359 rotate-secret framing pinned: 24h grace; new plaintext returned ONCE; worker dual-signs every outbound delivery with both new+old while secret_prev_expires_at > now; admin-only on team-scoped (same gate as create/update/delete/send-test); response: id whk_ + secret plaintext + secret_prefix + prev_secret_prefix first-12-chars + grace_expires_at ISO fallback now()', () => {
    expect(body).toMatch(
      /\/\/ V-359 — rotate the signing secret with a 24h grace\. New plaintext\s*\n?\s*\/\/ returned ONCE; worker dual-signs every outbound delivery with both\s*\n?\s*\/\/ the new \+ old secret while `secret_prev_expires_at > now`\.\s*\n?\s*\/\/ Admin-only on team-scoped requests \(same gate as create \/ update \/\s*\n?\s*\/\/ delete \/ send-test\)\./,
    );
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*id: `whk_\$\{result\.row\.id\}`,\s*\n?\s*secret: result\.plaintextSecret,\s*\n?\s*secret_prefix: result\.row\.secretPrefix,\s*\n?\s*prev_secret_prefix: result\.row\.secretPrev \? result\.row\.secretPrev\.slice\(0, 12\) : '',\s*\n?\s*grace_expires_at: result\.row\.secretPrevExpiresAt\s*\n?\s*\? result\.row\.secretPrevExpiresAt\.toISOString\(\)\s*\n?\s*: new Date\(\)\.toISOString\(\),\s*\n?\s*\}\);/,
    );
  });

  it('V-356 test.ping framing pinned: synthetic event bypassing subscription; lets customer verify handler before relying on it for real events; admin-only when targeting team owner (same gate as create/update/delete); 202 with delivery_id wdl_ + event_id + event_type "test.ping"', () => {
    expect(body).toMatch(
      /\/\/ V-356 — send a synthetic test\.ping event to the endpoint,\s*\n?\s*\/\/ bypassing subscription\. Lets the customer verify their handler\s*\n?\s*\/\/ before relying on it for real events\. Admin-only when targeting\s*\n?\s*\/\/ a team owner \(same gate as create \/ update \/ delete\)\./,
    );
    expect(body).toMatch(
      /return reply\.code\(202\)\.send\(\{\s*\n?\s*delivery_id: `wdl_\$\{result\.deliveryId\}`,\s*\n?\s*event_id: result\.eventId,\s*\n?\s*event_type: 'test\.ping',\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
