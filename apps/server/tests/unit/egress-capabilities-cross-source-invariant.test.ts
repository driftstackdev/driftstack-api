// Arc 5 EGRESS eg.6 — cross-source invariant for the egress capability
// surface. Pins the shape across three layers so renames break CI:
//
//   1. packages/api-types/src/egress.ts EgressCapabilitiesSchema
//      (the wire shape that Zod parses + the SDK consumes)
//   2. apps/server/src/db/schema.ts sessions.egressCapabilities +
//      sessions.egressCapabilityReport (the Drizzle column types)
//   3. apps/server/src/services/sessions.ts SessionRecord
//      (the service-layer record shape that the route surfaces)
//
// Plus the migrations themselves:
//   - 0045 adds egress_capabilities (derived view)
//   - 0054 adds egress_capability_report (raw harness payload)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/egress.ts');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const SESSIONS_SVC = resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts');
const SESSIONS_REPO = resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts');
const MIGRATION_0045 = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0045_sessions_egress_capabilities.sql',
);
const MIGRATION_0054 = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0054_sessions_egress_capability_report.sql',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Arc 5 EGRESS eg.6 cross-source invariant', () => {
  it('all source files exist at the expected paths', () => {
    expect(existsSync(API_TYPES)).toBe(true);
    expect(existsSync(SCHEMA)).toBe(true);
    expect(existsSync(SESSIONS_SVC)).toBe(true);
    expect(existsSync(SESSIONS_REPO)).toBe(true);
    expect(existsSync(MIGRATION_0045)).toBe(true);
    expect(existsSync(MIGRATION_0054)).toBe(true);
  });

  it('migration 0045 + 0054 columns are declared on the sessions Drizzle schema', () => {
    const schema = read(SCHEMA);
    expect(schema).toMatch(/egressCapabilities: jsonb\('egress_capabilities'\)/);
    expect(schema).toMatch(/egressCapabilityReport: jsonb\('egress_capability_report'\)/);
  });

  it('Drizzle schema egressCapabilities typed view matches EgressCapabilitiesSchema (api-types)', () => {
    const schema = read(SCHEMA);
    // Drizzle column .$type<>() carries all four fields.
    expect(schema).toMatch(/udp_associate: boolean;/);
    expect(schema).toMatch(/quic_route: 'proxy' \| 'direct' \| 'disabled';/);
    expect(schema).toMatch(/dns_remote_resolve: boolean;/);
    expect(schema).toMatch(/warnings: string\[\];/);

    const types = read(API_TYPES);
    expect(types).toMatch(/export const EgressCapabilitiesSchema = z\.object\(\{/);
    expect(types).toMatch(/udp_associate: z\.boolean\(\)/);
    expect(types).toMatch(/quic_route: z\.enum\(\['proxy', 'direct', 'disabled'\]\)/);
    expect(types).toMatch(/dns_remote_resolve: z\.boolean\(\)/);
    expect(types).toMatch(/warnings: z\.array\(z\.string\(\)\)/);
  });

  it('SessionRecord (service layer) carries BOTH egressCapabilities + egressCapabilityReport', () => {
    const svc = read(SESSIONS_SVC);
    expect(svc).toMatch(/egressCapabilities: \{/);
    expect(svc).toMatch(/egressCapabilityReport: Record<string, unknown> \| null;/);
  });

  it('SessionRepo interface declares setEgressCapabilityReport with the wire-pinned signature', () => {
    const svc = read(SESSIONS_SVC);
    expect(svc).toMatch(/setEgressCapabilityReport\(args: \{/);
    expect(svc).toMatch(/sessionId: string;/);
    expect(svc).toMatch(/derived: \{/);
    expect(svc).toMatch(/raw: Record<string, unknown>;/);
  });

  it('Drizzle row-to-record mapper threads BOTH egress columns', () => {
    const repo = read(SESSIONS_REPO);
    expect(repo).toMatch(/egressCapabilities: r\.egressCapabilities/);
    expect(repo).toMatch(/egressCapabilityReport: r\.egressCapabilityReport/);
  });

  it('migration 0054 ALTER TABLE uses jsonb DEFAULT NULL (same nullability semantics as 0045)', () => {
    const m = read(MIGRATION_0054);
    expect(m).toMatch(
      /ALTER TABLE "sessions" ADD COLUMN "egress_capability_report" jsonb DEFAULT NULL/,
    );
  });

  it('migration 0054 framing explicitly documents the "raw vs derived" split', () => {
    const m = read(MIGRATION_0054);
    expect(m).toMatch(/derived/);
    // Tolerate whitespace between RAW + harness-emitted because the
    // SQL comment wraps across lines.
    expect(m).toMatch(/RAW[\s\S]*harness-emitted/);
    expect(m).toMatch(/Forensics/i);
  });

  // EG-WK-1.9 (founder verdict 2026-05-17 ~20:15 UTC) added the
  // dns_remote_resolve field to EgressCapabilitiesSchema. The Drizzle
  // column .$type<>() declaration MUST include it — otherwise the
  // SDK would receive a field the DB schema can't typecheck against.
  it('EG-WK-1.9 dns_remote_resolve field present in both api-types + Drizzle schema typed view', () => {
    expect(read(API_TYPES)).toMatch(/dns_remote_resolve: z\.boolean\(\)/);
    expect(read(SCHEMA)).toMatch(/dns_remote_resolve: boolean;/);
  });
});
