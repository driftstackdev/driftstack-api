// AuditLogResource — typed methods for /v1/account/audit-log (V-216).
//
// Append-only event ledger of every account action: api_key lifecycle,
// session events, profile / webhook config changes, MFA lifecycle,
// team membership changes, etc. Pairs with V-216 dashboard /audit-log
// rendering. Read endpoints honor the V-326c X-Driftstack-Account
// team-RBAC header (a member with read access on the team owner can
// pull the OWNER's audit log).

import type { PaginationQueryInput } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

/**
 * V-216 — single audit-log entry shape. The same row also surfaces
 * via the export endpoint (CSV / JSON file format). Defined inline
 * here because the lean api-types schema is dashboard-targeted; SDK
 * consumers get the full shape directly.
 */
export interface AuditLogEntry {
  id: string;
  account_id: string;
  /** 'customer' (a human action), 'system' (server-generated event), or 'staff' (Driftstack support). */
  actor_type: 'customer' | 'system' | 'staff';
  /** The CALLING account for customer actions (may be a team member acting on the OWNER's log per V-326c). */
  actor_account_id: string | null;
  actor_key_id: string | null;
  action: string;
  target_resource_id: string | null;
  /** Action-specific structured payload. Shape depends on action; see /api/audit-log doc. */
  payload: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
}

export interface AuditLogListPage {
  data: AuditLogEntry[];
  next_cursor: string | null;
}

export interface AuditLogQuery extends PaginationQueryInput {
  /** Filter to a single action (e.g. 'profile.created'). */
  action?: string;
}

/**
 * V-297 — bulk-export envelope for GDPR Article 20 portability. The
 * SDK exposes the JSON branch (programmatic). Customers wanting a CSV
 * download in a browser hit `/v1/account/audit-log/export?format=csv`
 * directly with their bearer.
 */
export interface AuditLogExportResponse {
  generated_at: string;
  account_id: string;
  row_count: number;
  /**
   * True when the row count hit the 10,000-row server-side ceiling and
   * older entries were not included.
   */
  truncated: boolean;
  data: AuditLogEntry[];
}

export class AuditLogResource {
  constructor(private readonly http: HttpClient) {}

  /** List audit-log entries for the EFFECTIVE account — your own, or the
   *  owner you are acting as via `X-Driftstack-Account` — newest-first. */
  list(query: AuditLogQuery = {}): Promise<AuditLogListPage> {
    return this.http.request<AuditLogListPage>({
      method: 'GET',
      path: '/v1/account/audit-log',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.action !== undefined ? { action: query.action } : {}),
      },
    });
  }

  /** Lazily walk every page; useful for compliance bulk-pull. */
  iterate(
    opts: { limit?: number; action?: string } = {},
  ): AsyncGenerator<AuditLogEntry, void, void> {
    return iteratePaginated<AuditLogEntry>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.action !== undefined ? { action: opts.action } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /**
   * V-462 / V-297 — bulk-export the calling account's audit log as a
   * JSON envelope. Designed for GDPR Article 20 data-portability
   * requests: a single call, up to 10,000 rows, no pagination.
   * Capped server-side at 10k; if `truncated` is `true` the older
   * entries weren't returned. CSV download in a browser is not
   * surfaced here — hit `/v1/account/audit-log/export?format=csv`
   * directly with your bearer for the spreadsheet flow.
   */
  export(): Promise<AuditLogExportResponse> {
    return this.http.request<AuditLogExportResponse>({
      method: 'GET',
      path: '/v1/account/audit-log/export',
      query: { format: 'json' },
    });
  }
}
