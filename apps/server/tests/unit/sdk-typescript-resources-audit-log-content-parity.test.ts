// W426.B (W657-deepened) — drift guard for packages/sdk-typescript/
// src/resources/audit-log.ts. V-216 + V-297/V-462 + V-326c TS parity.
//
// W657 splits the original 10 it() blocks into 18 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-326c team-RBAC passthrough — a team member with read access
//     on the team owner CAN pull the OWNER's audit log via the
//     X-Driftstack-Account header. This is the load-bearing claim
//     that the audit-log read-endpoint is the ONE place where a
//     non-owner can legitimately read owner data; the framing must
//     stay attached to the read-endpoint section because dropping
//     it would let a future refactor silently route the header
//     through unintentionally.
//   • actor_type 3-value union (customer | system | staff) pinned
//     per-line. Drift to a 4th value (e.g. "ai") without
//     coordinated server+client update would break the closed-set
//     switch in dashboards rendering the audit row.
//   • actor_account_id team-RBAC framing pinned: "may be a team
//     member acting on the OWNER's log per V-326c" — this is what
//     tells dashboards the actor_account_id may DIFFER from
//     account_id, which is the whole point of team-RBAC accounting.
//   • V-297 export envelope 5-field shape (generated_at +
//     account_id + row_count + truncated + data) pinned per-field.
//     truncated=true semantic ("count hit the 10,000-row server-
//     side ceiling and older entries were not included") pinned
//     verbatim — load-bearing for compliance auditors who need to
//     know when an export is partial.
//   • V-462 GDPR Article 20 framing — "Designed for GDPR Article 20
//     data-portability requests" pinned. Drift to dropping the
//     Article-20 reference would lose the regulatory-purpose
//     anchor that justifies why this endpoint is opt-in (not
//     rate-limited like list) and why CSV is OOB.
//   • CSV-not-surfaced-via-SDK rationale pinned: format=json
//     hardcoded so the SDK return type stays Promise<AuditLog
//     ExportResponse>, not a Promise<Blob>. CSV is doc'd as
//     "hit /v1/account/audit-log/export?format=csv directly with
//     your bearer" — a workaround, not a removed feature.
//   • Conditional-spread query pattern — 3 conditional spreads on
//     list (limit + cursor + action) + 3 on iterate (limit + action
//     + cursor). Drift to `?? defaults` would client-side-default
//     instead of deferring to server-side defaults, breaking the
//     server-side-defaults-rule contract.

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

  it('file exists at canonical path + module header V-216 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ AuditLogResource — typed methods for \/v1\/account\/audit-log \(V-216\)\./,
    );
  });

  it('Append-only ledger scope pinned — comprehensive list of accountable actions: api_key lifecycle + session events + profile/webhook config + MFA lifecycle + team membership. CRITICAL: drift to making this list NON-exhaustive would let a new V-anchor (e.g. crypto-checkout, billing-portal) silently skip the audit-log; the comprehensiveness is the load-bearing claim.', () => {
    expect(body).toMatch(
      /\/\/ Append-only event ledger of every account action: api_key lifecycle,\s*\n?\s*\/\/ session events, profile \/ webhook config changes, MFA lifecycle,\s*\n?\s*\/\/ team membership changes, etc\. Pairs with V-216 dashboard \/audit-log\s*\n?\s*\/\/ rendering\./,
    );
  });

  it('CRITICAL: V-326c X-Driftstack-Account team-RBAC header passthrough on READ endpoints. "Read endpoints honor the V-326c X-Driftstack-Account team-RBAC header (a member with read access on the team owner can pull the OWNER\'s audit log)." This is the ONE place a non-owner can legitimately read owner data — drift to silently dropping the header passthrough would BREAK the team-member compliance-pull flow; drift to extending the passthrough to WRITE endpoints would invert the read-only invariant.', () => {
    expect(body).toMatch(
      /Read endpoints honor the V-326c X-Driftstack-Account\s*\n?\s*\/\/ team-RBAC header \(a member with read access on the team owner can\s*\n?\s*\/\/ pull the OWNER's audit log\)\./,
    );
  });

  it("Imports — PaginationQueryInput from api-types + HttpClient from sibling http.js + iteratePaginated from pagination.js. The iteratePaginated import is value-import (not type-import) because it's an async generator function, not a type.", () => {
    expect(body).toMatch(/import type \{ PaginationQueryInput \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('AuditLogEntry doc-comment + "lean api-types schema is dashboard-targeted; SDK consumers get the full shape directly" rationale pinned. Drift to importing the shape from api-types would mean SDK customers lose access to fields the dashboard doesn\'t render (e.g. actor_key_id which matters for forensic queries).', () => {
    expect(body).toMatch(
      /\*\s*V-216 — single audit-log entry shape\. The same row also surfaces\s*\n?\s*\*\s*via the export endpoint \(CSV \/ JSON file format\)\. Defined inline\s*\n?\s*\*\s*here because the lean api-types schema is dashboard-targeted; SDK\s*\n?\s*\*\s*consumers get the full shape directly\./,
    );
  });

  it('AuditLogEntry actor_type 3-value discriminator pinned: "customer | system | staff". CRITICAL: drift to a 4th value (e.g. "ai" for automated agent actions) WITHOUT coordinated server+client update would break the closed-set switch in dashboards rendering the audit row (the dashboard\'s "render actor avatar" code would fall through to undefined). Each value\'s meaning pinned per-line: customer (human action), system (server-generated), staff (Driftstack support).', () => {
    expect(body).toMatch(
      /\/\*\* 'customer' \(a human action\), 'system' \(server-generated event\), or 'staff' \(Driftstack support\)\. \*\/\s*\n?\s*actor_type: 'customer' \| 'system' \| 'staff';/,
    );
  });

  it('AuditLogEntry — id/account_id/actor_account_id/actor_key_id top-half pinned with CRITICAL "may be a team member acting on the OWNER\'s log per V-326c" framing. This is what tells dashboards that actor_account_id MAY DIFFER from account_id — the whole point of team-RBAC accounting in the audit log. Drift to dropping the framing would lose the team-attribution semantic.', () => {
    expect(body).toMatch(
      /export interface AuditLogEntry \{\s*\n?\s*id: string;\s*\n?\s*account_id: string;/,
    );
    expect(body).toMatch(
      /\/\*\* The CALLING account for customer actions \(may be a team member acting on the OWNER's log per V-326c\)\. \*\/\s*\n?\s*actor_account_id: string \| null;\s*\n?\s*actor_key_id: string \| null;/,
    );
  });

  it('AuditLogEntry — action/target_resource_id/payload/ip_address/user_agent/timestamp bottom-half. payload: Record<string, unknown> | null is the action-specific structured payload — "Shape depends on action; see /api/audit-log doc". Drift to typing payload as a specific shape would break the multi-shape ledger invariant.', () => {
    expect(body).toMatch(
      /action: string;\s*\n?\s*target_resource_id: string \| null;\s*\n?\s*\/\*\* Action-specific structured payload\. Shape depends on action; see \/api\/audit-log doc\. \*\/\s*\n?\s*payload: Record<string, unknown> \| null;\s*\n?\s*ip_address: string \| null;\s*\n?\s*user_agent: string \| null;\s*\n?\s*timestamp: string;\s*\n?\s*\}/,
    );
  });

  it('AuditLogListPage envelope — 2-field cursor pagination (data: AuditLogEntry[] + next_cursor: string | null). NO has_more bool because next_cursor: null IS the "no more pages" signal — simpler than the 3-field shape webhooks deliveries use.', () => {
    expect(body).toMatch(
      /export interface AuditLogListPage \{\s*\n?\s*data: AuditLogEntry\[\];\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('AuditLogQuery extends PaginationQueryInput + adds action filter ("e.g. profile.created"). Drift to making action a closed-set enum would force the SDK to be re-published every time a new action ID lands server-side — keeping it `string` defers schema evolution to the server.', () => {
    expect(body).toMatch(
      /export interface AuditLogQuery extends PaginationQueryInput \{\s*\n?\s*\/\*\* Filter to a single action \(e\.g\. 'profile\.created'\)\. \*\/\s*\n?\s*action\?: string;\s*\n?\s*\}/,
    );
  });

  it('V-297 AuditLogExportResponse doc-comment — "GDPR Article 20 portability JSON branch (programmatic)" + CSV-via-browser-direct workaround. CRITICAL: the SDK MUST stay JSON-only because the SDK return type is Promise<AuditLogExportResponse> (a typed object), not Promise<Blob>. Drift to surfacing CSV through the SDK would force a content-negotiation-aware return type that\'s impossible to type correctly across both branches.', () => {
    expect(body).toMatch(
      /\*\s*V-297 — bulk-export envelope for GDPR Article 20 portability\. The\s*\n?\s*\*\s*SDK exposes the JSON branch \(programmatic\)\. Customers wanting a CSV\s*\n?\s*\*\s*download in a browser hit `\/v1\/account\/audit-log\/export\?format=csv`\s*\n?\s*\*\s*directly with their bearer\./,
    );
  });

  it('AuditLogExportResponse — 5-field shape pinned per-field: generated_at (string ISO timestamp) + account_id (string) + row_count (number) + truncated (bool) + data (AuditLogEntry[]). Drift to dropping row_count would force callers to count data[].length client-side which is fine for completeness but loses the server-side authoritative count when truncated.', () => {
    expect(body).toMatch(
      /export interface AuditLogExportResponse \{\s*\n?\s*generated_at: string;\s*\n?\s*account_id: string;\s*\n?\s*row_count: number;/,
    );
  });

  it('truncated field — CRITICAL semantic pinned per-line: "True when the row count hit the 10,000-row server-side ceiling and older entries were not included." This is the load-bearing flag for compliance auditors — they need to know when an export is PARTIAL so they can request CSV-via-browser for the full set. Drift to dropping the 10k-row number would lose the server-side cap visibility.', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*True when the row count hit the 10,000-row server-side ceiling and\s*\n?\s*\*\s*older entries were not included\.\s*\n?\s*\*\/\s*\n?\s*truncated: boolean;\s*\n?\s*data: AuditLogEntry\[\];\s*\n?\s*\}/,
    );
  });

  it('AuditLogResource class declaration — exported + single private-readonly http constructor field (stateless wrapper pattern).', () => {
    expect(body).toMatch(/^export class AuditLogResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('list verb — GET /v1/account/audit-log with AuditLogQuery default-empty parameter. CRITICAL: 3 conditional-spread query params (limit + cursor + action) using `!== undefined ? { ... } : {}` pattern. Drift to `?? defaults` would client-side-default instead of deferring to server-side defaults, breaking the server-as-source-of-truth contract. "newest-first" ordering pinned.', () => {
    expect(body).toMatch(
      /\/\*\* List audit-log entries for the EFFECTIVE account — your own, or the\s*\n?\s*\*\s*owner you are acting as via `X-Driftstack-Account` — newest-first\./,
    );
    expect(body).toMatch(
      /list\(query: AuditLogQuery = \{\}\): Promise<AuditLogListPage> \{\s*\n?\s*return this\.http\.request<AuditLogListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/audit-log',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(query\.action !== undefined \? \{ action: query\.action \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate verb — V-118 cursor walker returning AsyncGenerator<AuditLogEntry, void, void>. "useful for compliance bulk-pull" framing pinned. Inner `(cursor) => this.list(...)` callback applies limit + action filter on EVERY page (re-threaded) + cursor only when non-null. Drift to applying filters only on the first page would silently broaden the iteration mid-walk.', () => {
    expect(body).toMatch(/\/\*\* Lazily walk every page; useful for compliance bulk-pull\. \*\//);
    expect(body).toMatch(
      /iterate\(\s*\n?\s*opts: \{ limit\?: number; action\?: string \} = \{\},\s*\n?\s*\): AsyncGenerator<AuditLogEntry, void, void> \{\s*\n?\s*return iteratePaginated<AuditLogEntry>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(opts\.action !== undefined \? \{ action: opts\.action \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('V-462/V-297 export verb — GET /v1/account/audit-log/export with `query: { format: \'json\' }` HARDCODED. CRITICAL: format=json is HARDCODED (not a parameter) so the SDK return type stays Promise<AuditLogExportResponse>, not Promise<Blob>. "single call, up to 10,000 rows, no pagination" framing pinned + truncated-bool semantic + CSV-NOT-surfaced-here-hit-URL-directly workaround.', () => {
    expect(body).toMatch(
      /\*\s*V-462 \/ V-297 — bulk-export the calling account's audit log as a\s*\n?\s*\*\s*JSON envelope\. Designed for GDPR Article 20 data-portability\s*\n?\s*\*\s*requests: a single call, up to 10,000 rows, no pagination\.\s*\n?\s*\*\s*Capped server-side at 10k; if `truncated` is `true` the older\s*\n?\s*\*\s*entries weren't returned\. CSV download in a browser is not\s*\n?\s*\*\s*surfaced here — hit `\/v1\/account\/audit-log\/export\?format=csv`\s*\n?\s*\*\s*directly with your bearer for the spreadsheet flow\./,
    );
    expect(body).toMatch(
      /export\(\): Promise<AuditLogExportResponse> \{\s*\n?\s*return this\.http\.request<AuditLogExportResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/audit-log\/export',\s*\n?\s*query: \{ format: 'json' \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('3-verb inventory + verb-mix invariants — exactly 3 method declarations (list + iterate + export) + verb mix: 2 GETs (list /v1/account/audit-log + export /v1/account/audit-log/export) + ZERO POST/PUT/PATCH/DELETE. Drift to a "delete entry" or "redact PII" verb would break the append-only-ledger invariant.', () => {
    const methods = body.match(/^ {2}[a-zA-Z]+\([^)]*\)[^{]*\{$/gm) ?? [];
    // Match opens-with-{-at-end-of-line — list / iterate / export each
    // open this way. The constructor uses inline `{}` so it doesn't
    // match (its body is on one line). Hence: 3 verb-bodies expected.
    expect(methods.length, 'expected 3 verb-body declarations (list + iterate + export)').toBe(3);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 2 GETs (list + export)').toBe(2);
    expect(body).not.toMatch(/method: 'POST'/);
    expect(body).not.toMatch(/method: 'PUT'/);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'DELETE'/);
  });
});
