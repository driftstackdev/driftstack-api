// W419.A — drift guard for apps/server/src/routes/admin-webhooks.ts.
// Admin webhook ops — get-by-id, replay, requeue, DLQ list. Each
// mutating endpoint records an audit row before returning (D-025
// audit-write-before-response contract). Drift here either drops the
// D-025 contract (silent admin actions) or breaks the V-512 endpoint-
// id prefix strip (admin GUI DLQ drill-down filter stops working).
//
//   • Framing pinned: 5 routes (get/replay/requeue/DLQ list/discard); admin
//     scope; D-025 audit-write-before-response.
//   • PUBLIC_ID_RE shared helper + uuidFromPrefixedId.
//   • publicDelivery: id=wdl_ + webhook_id=whk_ + event_id +
//     event_type satisfies WebhookEventType + status satisfies
//     WebhookDeliveryStatus + attempts + next_attempt_at ISO +
//     last_response_status/excerpt/error + delivered_at nullable +
//     created_at ISO.
//   • withAudit wrapper: targetResourceId is PUBLIC-prefixed id
//     (audit captures what admin sees, not raw uuid); dual-write on
//     success + error with err.name lowercase /error$/ strip.
//   • clientIp helper: shared Fastify trustProxy-resolved request.ip
//     to request.ip.
//   • V-512 endpoint_id filter: the public `webhook_endpoint_` form or a bare
//     uuid is accepted, anything else refused, and the repo sees the uuid.
//     V-1590 — this used to remove the prefix without judging the remainder.
//   • Scope-gate: requireScope('driftstack_internal_admin') +
//     rateLimit('global') on ALL 5 routes.
//   • ListDlqQuerySchema + ListDlqQueryInput from @driftstack/api-types.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W419.A apps/server/src/routes/admin-webhooks.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: 5 routes (get/replay/DLQ list/requeue/discard); admin scope; D-025 audit-write-before-response contract. The count said 4 until V-1021 — the DLQ discard route was never added to it', () => {
    // V-1021 — derived, so the roster count cannot drift from the file again.
    const registrations = [
      ...body.matchAll(/app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*'(\/v1\/[^']*)'/g),
    ];
    expect(registrations.length, 'routes registered in admin-webhooks.ts').toBe(5);
    expect(body).toMatch(
      /Admin-only webhook ops routes — replay, requeue, get-by-id, DLQ list\.\s*\n?\s*\/\/\s*All require admin scope\. Each mutating endpoint records an audit row\s*\n?\s*\/\/\s*before returning \(D-025 audit-write-before-response contract\)\./,
    );
  });

  it('publicDelivery: id=wdl_ + webhook_id=whk_ + event_id + event_type satisfies WebhookEventType + status satisfies WebhookDeliveryStatus + attempts + ISO timestamps', () => {
    expect(body).toMatch(
      /function publicDelivery\(row: WebhookDeliveryRow\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: `wdl_\$\{row\.id\}`,/);
    expect(body).toMatch(/webhook_id: `whk_\$\{row\.webhookId\}`,/);
    expect(body).toMatch(/event_id: row\.eventId,/);
    expect(body).toMatch(/event_type: row\.eventType satisfies WebhookEventType,/);
    expect(body).toMatch(/status: row\.status satisfies WebhookDeliveryStatus,/);
    expect(body).toMatch(/next_attempt_at: row\.nextAttemptAt\.toISOString\(\),/);
    expect(body).toMatch(/last_response_status: row\.lastResponseStatus,/);
    expect(body).toMatch(/last_response_excerpt: row\.lastResponseExcerpt,/);
    expect(body).toMatch(/last_error: row\.lastError,/);
    expect(body).toMatch(
      /delivered_at: row\.deliveredAt \? row\.deliveredAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it('clientIp uses shared readClientIp helper from lib/client-ip (extracted to collapse drift across admin-webhooks / admin-force-actions / admin-accounts)', () => {
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(/ipAddress: readClientIp\(request\),/);
  });

  it('withAudit framing pinned: targetResourceId is PUBLIC-prefixed id (audit captures what admin sees, not raw uuid); dual-write success + error with err.name lowercase /error$/ strip', () => {
    expect(body).toMatch(
      /\/\/ Wrap a mutation in audit-on-success \/ audit-on-error\. The\s*\n?\s*\/\/ targetResourceId is the public-prefixed delivery id \(the audit row\s*\n?\s*\/\/ captures what the admin sees, not the raw uuid\)\./,
    );
    expect(body).toMatch(
      /const code =\s*\n?\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
    expect(body).toMatch(/result: 'success',/);
    expect(body).toMatch(/result: `error: \$\{code\}`,/);
  });

  it("Scope-gate on ALL 5 routes: requireScope('driftstack_internal_admin') + rateLimit('global'). 2026-05-22 — POST /webhook-dlq/:id/discard added (17126865); the hard-delete endpoint MUST carry the same staff-scope gate as the existing GET-by-id / replay / list-dlq / requeue routes.", () => {
    const matches = body.match(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/g,
    );
    expect(matches?.length).toBe(5);
  });

  it('GET delivery-by-id: typed Params + uuidFromPrefixedId(id, "wdl"); webhooksAdmin.getDelivery; returns publicDelivery(row)', () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/webhook-deliveries\/:id',[\s\S]+?const id = uuidFromPrefixedId\(request\.params\.id, 'wdl'\);\s*\n?\s*const row = await webhooksAdmin\.getDelivery\(ctx, id\);\s*\n?\s*return publicDelivery\(row\);/,
    );
  });

  it("POST replay: action='webhook_delivery.replayed'; targetResourceId is request.params.id (prefixed); empty inputPayload {}; webhooksAdmin.replayDelivery", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/webhook-deliveries\/:id\/replay',/,
    );
    expect(body).toMatch(
      /const updated = await withAudit\(\s*\n?\s*request,\s*\n?\s*'webhook_delivery\.replayed',\s*\n?\s*request\.params\.id,\s*\n?\s*\{\},\s*\n?\s*\(\) => webhooksAdmin\.replayDelivery\(ctx, id\),\s*\n?\s*\);/,
    );
  });

  // V-1590 — this pinned a prefix removal. Removing a prefix says nothing about
  // what is left, and what is left reaches a uuid column, so a mistyped filter
  // was a cast error answered as 500. The route now judges the shape and the
  // public form is one of two it accepts.
  it('V-512 endpoint_id filter: accepts `webhook_endpoint_<uuid>` or a bare uuid and refuses anything else, passing the bare uuid to the repo (admin GUI drill-down compatibility)', () => {
    expect(body).toMatch(
      /const ENDPOINT_FILTER_RE =\s*\n?\s*\/\^\(\?:webhook_endpoint_\)\?\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/i;/,
    );
    expect(body).toMatch(
      /throw new BadRequestError\(\s*\n?\s*'Invalid endpoint_id\. Expected "webhook_endpoint_<uuid>" or a bare UUID\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const endpointId =\s*\n?\s*endpointIdRaw !== undefined \? endpointUuidFromFilter\(endpointIdRaw\) : undefined;/,
    );
  });

  it('GET DLQ list: ListDlqQuerySchema.parse + spread-conditional cursor + endpointId; reply { data: page.items.map(publicDelivery), next_cursor }', () => {
    expect(body).toMatch(
      /const rawQuery = \(request\.query \?\? \{\}\) as ListDlqQueryInput;\s*\n?\s*const query = ListDlqQuerySchema\.parse\(rawQuery\);/,
    );
    expect(body).toMatch(
      /const page = await webhooksAdmin\.listDlq\(ctx, \{\s*\n?\s*limit: query\.limit,\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(endpointId !== undefined \? \{ endpointId \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*data: page\.items\.map\(publicDelivery\),\s*\n?\s*next_cursor: page\.nextCursor,\s*\n?\s*\};/,
    );
  });

  it("POST DLQ requeue: action='webhook_delivery.requeued'; webhooksAdmin.requeueFromDlq", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/webhook-dlq\/:id\/requeue',/,
    );
    expect(body).toMatch(
      /const updated = await withAudit\(\s*\n?\s*request,\s*\n?\s*'webhook_delivery\.requeued',\s*\n?\s*request\.params\.id,\s*\n?\s*\{\},\s*\n?\s*\(\) => webhooksAdmin\.requeueFromDlq\(ctx, id\),\s*\n?\s*\);/,
    );
  });

  it('AdminWebhooksRoutesOptions: webhooksAdmin (WebhooksAdminService) + audit (AdminAuditService)', () => {
    expect(body).toMatch(
      /export interface AdminWebhooksRoutesOptions \{\s*\n?\s*webhooksAdmin: WebhooksAdminService;\s*\n?\s*audit: AdminAuditService;\s*\n?\s*\}/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + ListDlqQuerySchema/ListDlqQueryInput + WebhookDeliveryRow/EventType/Status/Service + AdminAuditAction/Service + BadRequestError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import \{ ListDlqQuerySchema, type ListDlqQueryInput \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*WebhookDeliveryRow,\s*\n?\s*WebhookEventType,\s*\n?\s*WebhookDeliveryStatus,\s*\n?\s*WebhooksAdminService,\s*\n?\s*\} from '\.\.\/services\/webhooks\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AdminAuditAction, AdminAuditService \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
