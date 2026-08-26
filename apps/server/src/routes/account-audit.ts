// V-216 — customer-facing audit log read endpoint.
// GET /v1/account/audit-log — list the calling account's own audit
// entries (newest first, cursor-paginated, optional action filter).
//
// V-297 — `GET /v1/account/audit-log/export?format=csv|json` exports
// the full audit log for the calling account as a single download.
// CSV for spreadsheets / GDPR Article 20 portability; JSON for
// programmatic consumers. Server-side ceiling: 10,000 rows per export
// to avoid pathological cases. Pagination via subsequent
// `?since=<timestamp>` calls if more is needed (rare in practice).

import type { FastifyInstance } from 'fastify';
import { ListAccountAuditLogQuerySchema } from '@driftstack/api-types';
import type { AccountAuditEntryRow, AccountAuditService } from '../services/account-audit.js';
import { BadRequestError } from '../lib/errors.js';
import { buildCsv } from '../lib/csv.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { z } from 'zod';

// The list cursor is the opaque bare-uuid id of the prior page's last row,
// keyset-looked-up via `eq(accountAuditLog.id, cursor)` against a Postgres
// uuid column → a malformed/tampered cursor would hit PG as an invalid uuid
// cast (500). Validate at the boundary so a bad cursor is a clean 400.
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Payload keys that carry the acting customer's network identity (IP /
// user-agent) — emitted by the auth-flow events (login / logout /
// password-change / MFA). The OWNER reading their OWN audit log keeps them
// (GDPR Art-15 right of access to own data; effectively a "devices that
// signed in" view). But a TEAM MEMBER reading the owner's log via
// X-Driftstack-Account must NOT see the owner's IP/UA — scrub them on that
// cross-actor read path. Doing it at serialization fixes BOTH new and
// historical rows with no data backfill.
const ACTOR_PRIVACY_PAYLOAD_KEYS = new Set([
  'issued_from_ip',
  'source_ip',
  'ip_address',
  'user_agent',
  'issued_user_agent',
]);

function scrubActorPrivacy(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!ACTOR_PRIVACY_PAYLOAD_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Whether a given ROW's IP/UA/payload-network-fields must be redacted,
 * independent of who is reading it.
 *
 * The request-level `effective.kind === 'team'` check only covers a
 * cross-account TEAM MEMBER reading the OWNER's log. It says nothing
 * about rows where the acting principal recorded on the row itself
 * differs from the account whose log this is — e.g. a Driftstack
 * staff member's `admin.support_note` / `admin.refund_recorded` note
 * lands on the CUSTOMER's own account_audit_log (accountId = customer)
 * with `actorAccountId` = the staff member's internal account and
 * `ipAddress` = the staff member's real IP. When that customer later
 * self-reads/exports their OWN log (effective.kind === 'self'), the
 * old request-level-only check let the staff member's IP leak
 * verbatim. Union both signals: redact when EITHER the reader is a
 * cross-account team member, OR the row's own actor differs from the
 * account the row belongs to.
 */
function rowNeedsActorPrivacyRedaction(row: AccountAuditEntryRow): boolean {
  return row.actorAccountId !== null && row.actorAccountId !== row.accountId;
}

function publicEntry(
  row: AccountAuditEntryRow,
  redactActorPrivacy = false,
): Record<string, unknown> {
  const redact = redactActorPrivacy || rowNeedsActorPrivacyRedaction(row);
  return {
    id: row.id,
    account_id: `acc_${row.accountId}`,
    actor_type: row.actorType,
    actor_account_id: row.actorAccountId ? `acc_${row.actorAccountId}` : null,
    actor_key_id: row.actorKeyId ? `key_${row.actorKeyId}` : null,
    action: row.action,
    target_resource_id: row.targetResourceId,
    payload: redact ? scrubActorPrivacy(row.payload) : row.payload,
    ip_address: redact ? null : row.ipAddress,
    user_agent: redact ? null : row.userAgent,
    timestamp: row.timestamp.toISOString(),
  };
}

export interface AccountAuditRoutesOptions {
  accountAudit: AccountAuditService;
}

export function registerAccountAuditRoutes(
  app: FastifyInstance,
  opts: AccountAuditRoutesOptions,
): void {
  const { accountAudit } = opts;

  app.get(
    '/v1/account/audit-log',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ListAccountAuditLogQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');
      if (parsed.data.cursor !== undefined && !CURSOR_UUID_RE.test(parsed.data.cursor)) {
        throw new BadRequestError('Invalid cursor.');
      }

      // V-330b — honor X-Driftstack-Account: a team member with a
      // valid membership reads the owner's audit log. Read-only;
      // both 'member' and 'admin' roles allowed.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));

      const page = await accountAudit.list(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
        // V-484 — additional filters forwarded to the service layer.
        ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
        ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
        ...(parsed.data.actor_type !== undefined ? { actorType: parsed.data.actor_type } : {}),
        ...(parsed.data.target_resource_id !== undefined
          ? { targetResourceId: parsed.data.target_resource_id }
          : {}),
        ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
      });

      // Cross-actor read (team member viewing the owner's log) → scrub the
      // owner's IP/UA from auth-flow payloads; self-view keeps them (Art-15).
      // This is only the REQUEST-level half of the redaction decision —
      // publicEntry() unions it with the per-ROW check (rowNeedsActorPrivacyRedaction)
      // so a self-view still scrubs any individual row whose own recorded
      // actor differs from the account (e.g. a staff support-note row).
      const redactActorPrivacy = effective.kind === 'team';
      return {
        data: page.items.map((row) => publicEntry(row, redactActorPrivacy)),
        next_cursor: page.nextCursor,
      };
    },
  );

  // V-297 — export
  const ExportQuerySchema = z.object({
    format: z.enum(['csv', 'json']).default('json'),
  });
  const EXPORT_MAX_ROWS = 10_000;
  const EXPORT_PAGE_SIZE = 200;

  app.get(
    '/v1/account/audit-log/export',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ExportQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');
      const format = parsed.data.format;

      // V-330c — same effective-account semantic as the read endpoint
      // above. A team member can export the owner's audit log when
      // they pass X-Driftstack-Account.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));

      // Walk pages until we have all rows or hit the ceiling. Service
      // already enforces account-scoping; we just iterate.
      const all: AccountAuditEntryRow[] = [];
      let cursor: string | undefined;
      // V-1793 — `exhausted` records WHICH exit the loop took, because the row
      // count cannot distinguish them. The cap divides exactly by the page size,
      // so a log holding precisely EXPORT_MAX_ROWS fills the last page, is told by
      // the repo's limit+1 lookahead that there is no successor, and leaves through
      // the `break` having lost nothing — while `all.length >= EXPORT_MAX_ROWS`
      // reported that as truncation. A complete compliance export that calls itself
      // partial is the same defect as a partial one that stays silent, reversed.
      let exhausted = false;
      while (all.length < EXPORT_MAX_ROWS) {
        const page = await accountAudit.list(ctx, {
          limit: EXPORT_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
        });
        all.push(...page.items);
        if (page.nextCursor === null) {
          exhausted = true;
          break;
        }
        cursor = page.nextCursor;
      }
      const truncated = !exhausted;
      // Same cross-actor scrub as the read endpoint (a team member exporting
      // the owner's log must not receive the owner's IP/UA). Request-level
      // only — see rowNeedsActorPrivacyRedaction for the per-row half that
      // publicEntry() (JSON branch below) and the CSV branch both union in.
      const redactActorPrivacy = effective.kind === 'team';

      const filenameBase = `driftstack-audit-log-${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        const header = [
          'timestamp',
          'action',
          'actor_type',
          'actor_account_id',
          'actor_key_id',
          'target_resource_id',
          'ip_address',
          'user_agent',
          'payload',
        ];
        const rows = all.map((row) => {
          // Same union as publicEntry: a cross-account team-header export
          // OR a row whose own recorded actor differs from the account
          // (e.g. a staff support-note on a customer's log) both redact.
          const redact = redactActorPrivacy || rowNeedsActorPrivacyRedaction(row);
          const payload = redact ? scrubActorPrivacy(row.payload) : row.payload;
          return [
            row.timestamp.toISOString(),
            row.action,
            row.actorType,
            row.actorAccountId ? `acc_${row.actorAccountId}` : '',
            row.actorKeyId ? `key_${row.actorKeyId}` : '',
            row.targetResourceId ?? '',
            redact ? '' : (row.ipAddress ?? ''),
            redact ? '' : (row.userAgent ?? ''),
            payload === null || payload === undefined ? '' : JSON.stringify(payload),
          ];
        });
        // buildCsv applies the shared CSV formula-injection guard
        // (CWE-1236) — audit rows carry client-controlled free text
        // (user_agent especially) that a spreadsheet would otherwise
        // evaluate as a formula on open.
        const csv = buildCsv({ header, rows });
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${filenameBase}.csv"`)
          .header('x-driftstack-export-truncated', truncated ? 'true' : 'false')
          .send(csv);
      }

      // JSON envelope.
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filenameBase}.json"`)
        .header('x-driftstack-export-truncated', truncated ? 'true' : 'false')
        .send({
          generated_at: new Date().toISOString(),
          // Label the envelope with the account whose rows these ARE — the
          // owner under a team export, the caller otherwise — mirroring the
          // data scope above (effectiveAccountId when team).
          account_id: `acc_${effective.kind === 'team' ? effective.accountId : ctx.account.id}`,
          row_count: all.length,
          truncated,
          data: all.map((row) => publicEntry(row, redactActorPrivacy)),
        });
    },
  );
}
