// W1043 — routes/admin-webhooks V-281 + V-512 cross-source invariant.
// Pins the apps/server/src/routes/admin-webhooks.ts admin webhook ops
// routes:
//
//   Header anchor — 'Admin-only webhook ops routes — replay, requeue,
//   get-by-id, DLQ list. All require admin scope. Each mutating
//   endpoint records an audit row before returning (D-025 audit-write-
//   before-response contract)'.
//
//   Endpoint roster — 4 routes:
//     GET   /v1/admin/webhook-deliveries/:id
//     POST  /v1/admin/webhook-deliveries/:id/replay
//     GET   /v1/admin/webhook-dlq
//     POST  /v1/admin/webhook-dlq/:id/requeue
//
//   driftstack_internal_admin scope + global rate-limit on every route.
//
//   PUBLIC_ID_RE prefix_uuid pattern matching the rest of the admin
//   surface (same regex as admin-incidents).
//
//   publicDelivery envelope — 11 fields including wdl_-prefixed id +
//   whk_-prefixed webhook_id + event_id + event_type + status +
//   attempts + next_attempt_at ISO + last_response_status +
//   last_response_excerpt + last_error + delivered_at ISO|null +
//   created_at ISO.
//
//   AdminAuditAction taxonomy — 'webhook_delivery.replayed' +
//   'webhook_delivery.requeued'.
//
//   V-512 endpoint_id filter — accepts the 'webhook_endpoint_' public
//   form or a bare uuid, refuses anything else, and calls the repo with
//   the uuid. V-1590 — it previously stripped without validating.
//
//   trustProxy-resolved request.ip derivation (per D-025
//   admin-audit IP capture).
//
// stays in lockstep across apps/server/src/routes/admin-webhooks.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1043 routes/admin-webhooks V-281 + V-512 cross-source invariant', () => {
  // ─── Header anchor ───────────────────────────────────────────

  it("CRITICAL header anchor — 'Admin-only webhook ops routes — replay, requeue, get-by-id, DLQ list. All require admin scope. Each mutating endpoint records an audit row before returning (D-025 audit-write-before-response contract)'. The 4-endpoint surface + audit-write-before-response is the canonical contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/Admin-only webhook ops routes — replay, requeue, get-by-id, DLQ list\./);
    expect(p).toMatch(/All require admin scope\. Each mutating endpoint records an audit row/);
    expect(p).toMatch(/before returning \(D-025 audit-write-before-response contract\)\./);
  });

  // ─── 4-endpoint roster ───────────────────────────────────────

  it('CRITICAL endpoint roster — 4 admin routes (get / replay / dlq-list / requeue). The exhaustive section banner comments document the canonical surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/'\/v1\/admin\/webhook-deliveries\/:id'/);
    expect(p).toMatch(/'\/v1\/admin\/webhook-deliveries\/:id\/replay'/);
    expect(p).toMatch(/'\/v1\/admin\/webhook-dlq'/);
    expect(p).toMatch(/'\/v1\/admin\/webhook-dlq\/:id\/requeue'/);
  });

  it("CRITICAL driftstack_internal_admin + global rate-limit on every route. The 4 occurrences are the canonical 'admin + rate-limit' chain.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    const refs =
      p.match(
        /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\]/g,
      ) ?? [];
    expect(refs.length, 'admin + rate-limit preHandler chain count').toBeGreaterThanOrEqual(4);
  });

  // ─── PUBLIC_ID_RE ────────────────────────────────────────────

  it("CRITICAL PUBLIC_ID_RE — '^[a-z]{3}_(uuid)$' (same shape as admin-incidents). The shared regex is one of the cross-cutting prefix-id family conventions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
  });

  // ─── publicDelivery envelope ─────────────────────────────────

  it("CRITICAL publicDelivery envelope — 11 fields (wdl_-prefixed id / whk_-prefixed webhook_id / event_id / event_type satisfies WebhookEventType / status satisfies WebhookDeliveryStatus / attempts / next_attempt_at ISO / last_response_status / last_response_excerpt / last_error / delivered_at ISO|null / created_at ISO). The 'satisfies'-typed event_type + status fields keep the union narrow without widening to string.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/id: `wdl_\$\{row\.id\}`,/);
    expect(p).toMatch(/webhook_id: `whk_\$\{row\.webhookId\}`,/);
    expect(p).toMatch(/event_id: row\.eventId,/);
    expect(p).toMatch(/event_type: row\.eventType satisfies WebhookEventType,/);
    expect(p).toMatch(/status: row\.status satisfies WebhookDeliveryStatus,/);
    expect(p).toMatch(/attempts: row\.attempts,/);
    expect(p).toMatch(/next_attempt_at: row\.nextAttemptAt\.toISOString\(\),/);
    expect(p).toMatch(/last_response_status: row\.lastResponseStatus,/);
    expect(p).toMatch(/last_response_excerpt: row\.lastResponseExcerpt,/);
    expect(p).toMatch(/last_error: row\.lastError,/);
    expect(p).toMatch(
      /delivered_at: row\.deliveredAt \? row\.deliveredAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  // ─── AdminAuditAction taxonomy ───────────────────────────────

  it("CRITICAL audit action taxonomy — 'webhook_delivery.replayed' + 'webhook_delivery.requeued'. The two distinct action strings let the admin-audit-log UI render 'replayed: we asked for this' vs 'requeued: this was stuck' separately.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/withAudit\(\s*\n?\s*request,\s*\n?\s*'webhook_delivery\.replayed',/);
    expect(p).toMatch(/withAudit\(\s*\n?\s*request,\s*\n?\s*'webhook_delivery\.requeued',/);
  });

  it("CRITICAL withAudit pattern — audit-on-success + audit-on-error with error-code derivation (lowercase + strip 'Error' suffix). Same pattern as admin-incidents withAudit; drift would diverge admin-audit-log filter chips.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/Wrap a mutation in audit-on-success \/ audit-on-error\. The/);
    expect(p).toMatch(/targetResourceId is the public-prefixed delivery id/);
    expect(p).toMatch(
      /err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown'/,
    );
    expect(p).toMatch(/result: `error: \$\{code\}`/);
  });

  // ─── V-512 endpoint_id filter ────────────────────────────────

  it("CRITICAL V-512 endpoint_id filter — accepts the 'webhook_endpoint_' public form or a bare uuid, refuses anything else, and calls the repo with the uuid. Keeping the public-id convention out of the storage layer is why the route translates; V-1590 is why it also judges, since the value lands in a uuid column and a strip alone made a mistyped filter a 500.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(
      /V-512 — accept the public `webhook_endpoint_` form on the optional\s*\n?\s*\/\/\s*drill-down filter and hand the repo a bare uuid\./,
    );
    // V-1590 — a strip is not a check, and the stripped value reaches a uuid
    // column. The filter is now validated and the refusal is a bad request.
    expect(p).toMatch(/endpointUuidFromFilter\(endpointIdRaw\)/);
    expect(p).toMatch(/\(\?:webhook_endpoint_\)\?/);
  });

  // ─── DLQ pagination envelope ─────────────────────────────────

  it('CRITICAL DLQ list response — {data: [...], next_cursor}. The shared paged envelope keeps the admin-audit-log + dlq + crypto-orders list endpoints consistent.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(/data: page\.items\.map\(publicDelivery\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  // ─── trusted-proxy-aware client IP ───────────────────────────

  it('CRITICAL clientIp uses shared trustProxy-resolved request.ip for D-025 audit-IP capture.', () => {
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(route).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/client-ip.ts'));
    expect(lib).toMatch(/return request\.ip \?\? null;/);
    expect(lib).not.toMatch(/request\.headers\['x-forwarded-for'\]/);
  });

  // ─── id-format error message ─────────────────────────────────

  it('CRITICAL id-format error — \'Invalid id format. Expected "<prefix>_<uuid>".\' (same error string as admin-incidents). Cross-route consistency for the prefix-uuid validators is part of the API UX contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts'));
    expect(p).toMatch(
      /throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\)/,
    );
  });
});
