// W426.B — drift guard for packages/sdk-typescript/src/resources/audit-log.ts.
// V-216 AuditLogResource — append-only event ledger; pairs with
// V-216 dashboard /audit-log; honors V-326c team-RBAC header for
// team-member reads of owner's log. Drift here either drops the
// V-297/V-462 export envelope (GDPR Article 20 portability breaks)
// or strips the team-RBAC framing (read-leak risk if mis-routed).
//
//   • Framing pinned: V-216 + dashboard pairing + V-326c team-RBAC
//     X-Driftstack-Account header.
//   • AuditLogEntry shape pinned: id + account_id + actor_type union
//     (customer|system|staff) + actor_account_id/key_id +
//     action/target/payload + ip_address/user_agent/timestamp.
//   • AuditLogListPage envelope: data[] + next_cursor.
//   • AuditLogQuery extends PaginationQueryInput with action filter.
//   • V-297/V-462 AuditLogExportResponse: generated_at + account_id +
//     row_count + truncated + data[]; 10k server-side ceiling.
//   • list + iterate (V-118 walker) + export verbs.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W426.B packages/sdk-typescript/src/resources/audit-log.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-216 typed methods for /v1/account/audit-log + V-216 dashboard pairing + V-326c team-RBAC X-Driftstack-Account header passthrough', () => {
    expect(body).toMatch(
      /\/\/ AuditLogResource — typed methods for \/v1\/account\/audit-log \(V-216\)\./,
    );
    expect(body).toMatch(
      /\/\/ Append-only event ledger of every account action: api_key lifecycle,\s*\n?\s*\/\/ session events, profile \/ webhook config changes, MFA lifecycle,\s*\n?\s*\/\/ team membership changes, etc\. Pairs with V-216 dashboard \/audit-log\s*\n?\s*\/\/ rendering\. Read endpoints honor the V-326c X-Driftstack-Account\s*\n?\s*\/\/ team-RBAC header \(a member with read access on the team owner can\s*\n?\s*\/\/ pull the OWNER's audit log\)\./,
    );
  });

  it('imports: PaginationQueryInput + HttpClient + iteratePaginated', () => {
    expect(body).toMatch(/import type \{ PaginationQueryInput \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('AuditLogEntry shape pinned: id + account_id + actor_type union + actor_account/key_id + action/target/payload + ip/UA/timestamp; lean-api-types rationale comment', () => {
    expect(body).toMatch(
      /\*\s*V-216 — single audit-log entry shape\. The same row also surfaces\s*\n?\s*\*\s*via the export endpoint \(CSV \/ JSON file format\)\. Defined inline\s*\n?\s*\*\s*here because the lean api-types schema is dashboard-targeted; SDK\s*\n?\s*\*\s*consumers get the full shape directly\./,
    );
    expect(body).toMatch(
      /export interface AuditLogEntry \{\s*\n?\s*id: string;\s*\n?\s*account_id: string;\s*\n?\s*\/\*\* 'customer' \(a human action\), 'system' \(server-generated event\), or 'staff' \(Driftstack support\)\. \*\/\s*\n?\s*actor_type: 'customer' \| 'system' \| 'staff';/,
    );
    expect(body).toMatch(
      /\/\*\* The CALLING account for customer actions \(may be a team member acting on the OWNER's log per V-326c\)\. \*\/\s*\n?\s*actor_account_id: string \| null;\s*\n?\s*actor_key_id: string \| null;\s*\n?\s*action: string;\s*\n?\s*target_resource_id: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* Action-specific structured payload\. Shape depends on action; see \/api\/audit-log doc\. \*\/\s*\n?\s*payload: Record<string, unknown> \| null;\s*\n?\s*ip_address: string \| null;\s*\n?\s*user_agent: string \| null;\s*\n?\s*timestamp: string;\s*\n?\s*\}/,
    );
  });

  it('AuditLogListPage envelope: data: AuditLogEntry[] + next_cursor: string | null', () => {
    expect(body).toMatch(
      /export interface AuditLogListPage \{\s*\n?\s*data: AuditLogEntry\[\];\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('AuditLogQuery extends PaginationQueryInput + adds action filter (e.g. profile.created)', () => {
    expect(body).toMatch(
      /export interface AuditLogQuery extends PaginationQueryInput \{\s*\n?\s*\/\*\* Filter to a single action \(e\.g\. 'profile\.created'\)\. \*\/\s*\n?\s*action\?: string;\s*\n?\s*\}/,
    );
  });

  it('V-297 AuditLogExportResponse: GDPR Article 20 portability JSON branch (CSV via browser direct); generated_at + account_id + row_count + truncated + data[]; 10k ceiling explanation', () => {
    expect(body).toMatch(
      /\*\s*V-297 — bulk-export envelope for GDPR Article 20 portability\. The\s*\n?\s*\*\s*SDK exposes the JSON branch \(programmatic\)\. Customers wanting a CSV\s*\n?\s*\*\s*download in a browser hit `\/v1\/account\/audit-log\/export\?format=csv`\s*\n?\s*\*\s*directly with their bearer\./,
    );
    expect(body).toMatch(
      /export interface AuditLogExportResponse \{\s*\n?\s*generated_at: string;\s*\n?\s*account_id: string;\s*\n?\s*row_count: number;/,
    );
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*True when the row count hit the 10,000-row server-side ceiling and\s*\n?\s*\*\s*older entries were not included\.\s*\n?\s*\*\/\s*\n?\s*truncated: boolean;\s*\n?\s*data: AuditLogEntry\[\];\s*\n?\s*\}/,
    );
  });

  it('list: GET /v1/account/audit-log; limit + cursor + action conditional-spread query', () => {
    expect(body).toMatch(
      /\/\*\* List audit-log entries for the calling account, newest-first\. \*\//,
    );
    expect(body).toMatch(
      /list\(query: AuditLogQuery = \{\}\): Promise<AuditLogListPage> \{\s*\n?\s*return this\.http\.request<AuditLogListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/audit-log',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(query\.action !== undefined \? \{ action: query\.action \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate: V-118 cursor walker; AsyncGenerator<AuditLogEntry, void, void>; action filter passthrough', () => {
    expect(body).toMatch(/\/\*\* Lazily walk every page; useful for compliance bulk-pull\. \*\//);
    expect(body).toMatch(
      /iterate\(\s*\n?\s*opts: \{ limit\?: number; action\?: string \} = \{\},\s*\n?\s*\): AsyncGenerator<AuditLogEntry, void, void> \{\s*\n?\s*return iteratePaginated<AuditLogEntry>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(opts\.action !== undefined \? \{ action: opts\.action \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('V-462/V-297 export: GET /v1/account/audit-log/export with format=json query; 10k row cap; CSV NOT surfaced here (browser direct)', () => {
    expect(body).toMatch(
      /\*\s*V-462 \/ V-297 — bulk-export the calling account's audit log as a\s*\n?\s*\*\s*JSON envelope\. Designed for GDPR Article 20 data-portability\s*\n?\s*\*\s*requests: a single call, up to 10,000 rows, no pagination\.\s*\n?\s*\*\s*Capped server-side at 10k; if `truncated` is `true` the older\s*\n?\s*\*\s*entries weren't returned\. CSV download in a browser is not\s*\n?\s*\*\s*surfaced here — hit `\/v1\/account\/audit-log\/export\?format=csv`\s*\n?\s*\*\s*directly with your bearer for the spreadsheet flow\./,
    );
    expect(body).toMatch(
      /export\(\): Promise<AuditLogExportResponse> \{\s*\n?\s*return this\.http\.request<AuditLogExportResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/audit-log\/export',\s*\n?\s*query: \{ format: 'json' \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
