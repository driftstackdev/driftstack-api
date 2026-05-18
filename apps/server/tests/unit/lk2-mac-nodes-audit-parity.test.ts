// LK.2 follow-up — drift guard pinning the admin-audit emission
// wiring around POST /v1/mac-nodes/register.
//
// Operators provisioning Macs is exactly the kind of event the
// admin audit log exists to capture. The route MUST emit one row
// per successful registration so auditors can reconstruct credential
// provisioning history without grepping operator logs.
//
// Pins:
// - migration 0057 adds the enum value
// - meta/_journal.json carries the matching idx
// - AdminAuditAction type union carries the value
// - route wires AdminAuditService through its deps
// - route calls audit.record with the LK.2 action + non-secret payload
// - app.ts threads adminAuditService into the registerMacNodesRoutes call

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const MIGRATION = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0057_admin_audit_mac_node_livekit_registered.sql',
);
const JOURNAL = resolve(REPO_ROOT, 'apps/server/src/db/migrations/meta/_journal.json');
const ADMIN_AUDIT_TS = resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts');
const ROUTE_TS = resolve(REPO_ROOT, 'apps/server/src/routes/mac-nodes-register.ts');
const APP_TS = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

describe('LK.2 mac_node.livekit_registered audit parity', () => {
  it('migration 0057 exists', () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  it('migration 0057 adds the mac_node.livekit_registered enum value', () => {
    const body = readFileSync(MIGRATION, 'utf8');
    expect(body).toMatch(
      /ALTER TYPE "public"\."admin_audit_action"[\s\S]+ADD VALUE IF NOT EXISTS 'mac_node\.livekit_registered'/,
    );
  });

  it('meta/_journal.json carries idx 57 pointing at the new migration', () => {
    const body = readFileSync(JOURNAL, 'utf8');
    expect(body).toMatch(/"idx":\s*57/);
    expect(body).toMatch(/"tag":\s*"0057_admin_audit_mac_node_livekit_registered"/);
  });

  it('AdminAuditAction union carries the LK.2 value', () => {
    const body = readFileSync(ADMIN_AUDIT_TS, 'utf8');
    expect(body).toMatch(/'mac_node\.livekit_registered'/);
  });

  it('mac-nodes-register route imports AdminAuditService', () => {
    const body = readFileSync(ROUTE_TS, 'utf8');
    expect(body).toMatch(
      /import type \{ AdminAuditService \} from '\.\.\/services\/admin-audit\.js'/,
    );
  });

  it('mac-nodes-register deps interface carries adminAudit?: AdminAuditService', () => {
    const body = readFileSync(ROUTE_TS, 'utf8');
    expect(body).toMatch(/adminAudit\?:\s*AdminAuditService/);
  });

  it('mac-nodes-register handler calls adminAudit.record with the LK.2 action', () => {
    const body = readFileSync(ROUTE_TS, 'utf8');
    expect(body).toMatch(/deps\.adminAudit\.record\(\{[\s\S]+'mac_node\.livekit_registered'/);
  });

  it('audit payload carries targetResourceId with mac_node_ prefix + ws_url (NOT api_key/api_secret)', () => {
    const body = readFileSync(ROUTE_TS, 'utf8');
    expect(body).toMatch(/targetResourceId:\s*`mac_node_\$\{body\.mac_node_id\}`/);
    expect(body).toMatch(/inputPayload:\s*\{\s*ws_url:\s*body\.livekit\.ws_url\s*\}/);
    // Belt-and-suspenders: ensure the secret material never appears
    // in any audit-emission payload literal.
    const auditRecordSlice = body.slice(
      body.indexOf('deps.adminAudit.record('),
      body.indexOf('// Response is intentionally minimal'),
    );
    expect(auditRecordSlice).not.toMatch(/api_key/);
    expect(auditRecordSlice).not.toMatch(/api_secret/);
    expect(auditRecordSlice).not.toMatch(/ciphertextBase64/);
  });

  it('handler swallows audit errors so credential persistence does not break on audit hiccups', () => {
    const body = readFileSync(ROUTE_TS, 'utf8');
    // The try/catch wrapping the record() call.
    expect(body).toMatch(/try \{[\s\S]+deps\.adminAudit\.record\([\s\S]+\} catch \{/);
  });

  it('app.ts threads deps.adminAuditService into the registerMacNodesRoutes call', () => {
    const body = readFileSync(APP_TS, 'utf8');
    const slice = body.slice(
      body.indexOf('registerMacNodesRoutes(app, {'),
      body.indexOf('// LK.3'),
    );
    expect(slice).toMatch(/adminAudit:\s*deps\.adminAuditService/);
  });
});
