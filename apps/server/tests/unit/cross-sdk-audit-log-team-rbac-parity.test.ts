// W697 — cross-SDK V-216/V-326c audit-log team-RBAC passthrough
// parity. Twenty-fourth in the cross-SDK drift-guard series (W649 +
// W675 + W676 + W677 + W678 + W679 + W680 + W681 + W682 + W683 +
// W684 + W685 + W686 + W687 + W688 + W689 + W690 + W691 + W692 +
// W693 + W694 + W695 + W696 + W697).
//
// Asserts the V-216 audit-log + V-326c team-RBAC passthrough +
// V-449 export contract is consistent across all 3 SDKs:
//
//   - V-216 anchor pinned on the resource header per-SDK
//   - V-326c X-Driftstack-Account team-RBAC header pinned in
//     sdk-typescript + sdk-go (a member with read access on the
//     team owner can pull the OWNER's audit log)
//   - V-449 OR V-216 audit-log feature reference present in all 3
//   - 3-verb surface (list + iterate + export) language-canonical
//   - 2 wire-paths: /v1/account/audit-log + /v1/account/audit-
//     log/export
//   - 11-field AuditLogEntry shape (id + account_id + actor_type +
//     actor_account_id + actor_key_id + action + target_resource_id
//     + payload + ip_address + user_agent + timestamp) in TS + Go
//   - V-462/V-297 GDPR export 10,000-row cap pinned per-SDK
//   - "Append-only" ledger framing
//
// CRITICAL invariant: actor_account_id is a SEPARATE field from
// account_id — drift to merging would collapse the team-passthrough
// distinction (the OWNER whose log is being read vs. the team-
// member doing the reading).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_AUDIT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts');
const GO_AUDIT = resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go');
const PY_AUDIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/audit_log.py');

describe('W697 cross-SDK V-216/V-326c audit-log team-RBAC passthrough parity', () => {
  it('all 3 SDK audit-log files exist at canonical paths', () => {
    expect(existsSync(TS_AUDIT), `missing ${TS_AUDIT}`).toBe(true);
    expect(existsSync(GO_AUDIT), `missing ${GO_AUDIT}`).toBe(true);
    expect(existsSync(PY_AUDIT), `missing ${PY_AUDIT}`).toBe(true);
  });

  it('CRITICAL V-216 anchor pinned in all 3 SDKs. V-216 is the audit-log resource feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    expect(ts).toMatch(/V-216/);
    expect(go).toMatch(/V-216/);
    expect(py).toMatch(/V-216/);
  });

  it("CRITICAL V-326c X-Driftstack-Account team-RBAC passthrough header pinned in sdk-typescript + sdk-go on the audit-log resource header. The team-passthrough is what lets a team member with read access on the OWNER pull the OWNER's audit log — drift to dropping would silently break the team-admin compliance flow. sdk-python (next regen pass) does not yet mention V-326c in its docstring.", () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);

    // sdk-typescript: "V-326c X-Driftstack-Account team-RBAC header"
    expect(ts).toMatch(/V-326c X-Driftstack-Account/);
    expect(ts).toMatch(/team-RBAC header/);

    // sdk-go: "V-326c X-Driftstack-Account team-RBAC header"
    expect(go).toMatch(/V-326c X-Driftstack-Account/);
    expect(go).toMatch(/team-RBAC/);
  });

  it('CRITICAL "member with read access on the team owner can pull the OWNER\'s audit log" framing pinned in TS + Go. The full claim is the customer-facing semantic of the team-passthrough; drift to dropping would let callers think the audit-log endpoint always returns ONLY their own log (and miss the team-admin path).', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);

    // sdk-typescript: "a member with read access on the team owner can\n// pull the OWNER's audit log"
    expect(ts).toMatch(
      /a member with read access on the team owner[\s\S]{0,80}pull the OWNER's audit log/,
    );

    // sdk-go: same.
    expect(go).toMatch(
      /a member with read access on the team owner[\s\S]{0,80}pull the\s*\/\/\s*OWNER's audit log/,
    );
  });

  it('CRITICAL 3-verb surface pinned in all 3 SDKs — list + iterate + export. The 3-verb set covers the entire customer audit-log flow (page, walk, bulk-export). Drift to dropping any verb would break compliance flows.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: list / iterate / export.
    expect(ts).toMatch(/list\(query:/);
    expect(ts).toMatch(/iterate\(/);
    expect(ts).toMatch(/export\(\)/);

    // sdk-go: List / Iterate / Export.
    expect(go).toMatch(/func \(r \*AuditLogResource\) List\(/);
    expect(go).toMatch(/func \(r \*AuditLogResource\) Iterate\(/);
    expect(go).toMatch(/func \(r \*AuditLogResource\) Export\(/);

    // sdk-python: list / iterate / export.
    expect(py).toMatch(/def list\(/);
    expect(py).toMatch(/def iterate\(/);
    expect(py).toMatch(/def export\(self/);
  });

  it('CRITICAL 2 wire-paths pinned per-SDK: /v1/account/audit-log + /v1/account/audit-log/export. Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/account\/audit-log/);
      expect(sdk).toMatch(/\/v1\/account\/audit-log\/export/);
    }
  });

  it('CRITICAL 11-field AuditLogEntry shape pinned in TS + Go — id + account_id + actor_type + actor_account_id + actor_key_id + action + target_resource_id + payload + ip_address + user_agent + timestamp. Drift to dropping ANY field would break dashboards that render that column.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);

    const fields = [
      'id',
      'account_id',
      'actor_type',
      'actor_account_id',
      'actor_key_id',
      'action',
      'target_resource_id',
      'payload',
      'ip_address',
      'user_agent',
      'timestamp',
    ];

    for (const field of fields) {
      const fieldRegex = new RegExp(`\\b${field}\\b`);
      expect(ts, `sdk-typescript AuditLogEntry field ${field}`).toMatch(fieldRegex);
      expect(go, `sdk-go AuditLogEntry field ${field}`).toMatch(fieldRegex);
    }
  });

  it('CRITICAL account_id vs actor_account_id distinction pinned in sdk-typescript + sdk-go. The TWO separate fields are what carry the team-passthrough semantic: account_id = the OWNER whose log is being read; actor_account_id = the CALLING (team-member) account. Drift to merging would collapse the team-passthrough distinction.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);

    // sdk-typescript: "actor_account_id" with "CALLING account for customer actions" framing.
    expect(ts).toMatch(/CALLING account for customer actions/);
    expect(ts).toMatch(/may be a team member acting on the OWNER's log per V-326c/);

    // sdk-go: ActorAccountID with separate AccountID.
    expect(go).toMatch(/ActorAccountID\s+\*string\s+`json:"actor_account_id"`/);
    expect(go).toMatch(/AccountID\s+string\s+`json:"account_id"`/);
  });

  it("CRITICAL actor_type 3-value enum pinned in sdk-typescript ('customer' | 'system' | 'staff'). The closed-3 set is what dashboards anchor their actor-badge rendering on. Drift to a 4th value would break the closed-set switch.", () => {
    const ts = read(TS_AUDIT);

    // sdk-typescript: literal union.
    expect(ts).toMatch(/actor_type: 'customer' \| 'system' \| 'staff'/);

    // sdk-go: comment-based enum (Go has no compile-time literal-unions on struct fields).
    const go = read(GO_AUDIT);
    expect(go).toMatch(/"customer" \| "system" \| "staff"/);
  });

  it("CRITICAL V-462/V-297 GDPR Article 20 export 10,000-row cap pinned per-SDK. The 10k cap is server-side; `truncated` flips to true when older entries weren't returned. Drift to dropping the cap mention would let callers think bulk-export returns everything.", () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // V-462/V-297 anchors.
    expect(ts).toMatch(/V-462 \/ V-297/);
    expect(go).toMatch(/V-462 \/ V-297/);
    expect(py).toMatch(/V-462 \/ V-297/);

    // 10,000-row cap.
    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/10,000 rows|10,000-row|10k rows/);
    }
  });

  it('CRITICAL "CSV branch is not surfaced" framing pinned in all 3 SDKs — the SDK export() only returns the JSON envelope; CSV download is for a browser bearer call directly. Drift to surfacing CSV through the SDK would force the SDK to handle binary streaming.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // sdk-typescript: "CSV download in a browser is not\n   * surfaced here"
    expect(ts).toMatch(/CSV download[\s\S]{0,80}not\s*\*\s*surfaced here/);

    // sdk-go: "CSV branch is not surfaced through the SDK"
    expect(go).toMatch(/CSV branch is not\s*\/\/\s*surfaced through the SDK/);

    // sdk-python: "CSV branch is not exposed here"
    expect(py).toMatch(/CSV branch is not[\s\S]{0,30}exposed here/);
  });

  it("CRITICAL Append-only ledger framing pinned in all 3 SDKs. The 'Append-only event ledger' wording is what tells customers the audit-log is IMMUTABLE (no DELETE/UPDATE verbs). Drift to dropping would let callers expect mutations.", () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    expect(ts).toMatch(/Append-only event ledger/);
    expect(go).toMatch(/Append-only ledger/);
    expect(py).toMatch(/Append-only event ledger/);
  });

  it('CRITICAL no mutation verbs (no DELETE / no PATCH / no POST) on audit-log resource. The audit log is APPEND-ONLY — drift to adding a delete/patch verb would break the immutable-ledger invariant.', () => {
    const ts = read(TS_AUDIT);
    const go = read(GO_AUDIT);
    const py = read(PY_AUDIT);

    // No DELETE / POST / PATCH method on audit-log.
    for (const sdk of [ts, go, py]) {
      expect(sdk, "no 'DELETE' method").not.toMatch(/method:\s*['"]DELETE['"]/);
      expect(sdk, "no 'PATCH' method").not.toMatch(/method:\s*['"]PATCH['"]/);
      expect(sdk, "no 'POST' method").not.toMatch(/method:\s*['"]POST['"]/);
    }
  });

  it('Cross-SDK V-216 5-invariant cluster — V-216 anchor + 3-verb surface (list/iterate/export) + 2 wire-paths + V-462/V-297 GDPR export + Append-only framing. Drift on any would fragment the cross-language audit-log contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_AUDIT),
      'sdk-go': read(GO_AUDIT),
      'sdk-python': read(PY_AUDIT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-216`).toMatch(/V-216/);
      expect(body, `${name} V-462/V-297`).toMatch(/V-462 \/ V-297/);
      expect(body, `${name} audit-log path`).toMatch(/\/v1\/account\/audit-log/);
      expect(body, `${name} Append-only`).toMatch(/[Aa]ppend-only/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-audit-log-team-rbac-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
