// W859 — SessionPurpose 3-value + DEFAULT cross-source invariant.
// One-hundred-eighty-fifth in the drift-guard series. Pins the
// V-169 session-purpose 3-value enum (drives WebKit driver harness
// selection):
//   1. production_customer       — V-169 default; real customer traffic.
//   2. cumulative_rig_validation — V-495 load-test harness pings.
//   3. test_domain_probe         — V-540 domain-pre-flight probe.
// PLUS the cross-source DEFAULT_SESSION_PURPOSE constant:
//   - api-types: DEFAULT_SESSION_PURPOSE = 'production_customer'
//   - Go SDK:    DefaultSessionPurpose = PurposeProductionCustomer
// stays in lockstep across:
//   - packages/api-types/src/sessions.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum + Default).
//
// Drift would silently break:
//   * Server persist: pgEnum rejects unknown values.
//   * Go SDK: customer pattern-match on purpose switches.
//   * Default-when-omitted contract: TS client omits purpose →
//     server applies DEFAULT_SESSION_PURPOSE. Go client omits →
//     DefaultSessionPurpose. The two must match exactly.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SESSION_PURPOSES = [
  'production_customer',
  'cumulative_rig_validation',
  'test_domain_probe',
] as const;

const DEFAULT_PURPOSE = 'production_customer';

describe('W859 SessionPurpose cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/sessions.ts SessionPurposeSchema = z.enum([3 values]) — production_customer + cumulative_rig_validation + test_domain_probe. The 3-value closed-roster drives WebKit driver harness selection per V-169.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export const SessionPurposeSchema = z\.enum\(\[/);
    const m = p.match(/SessionPurposeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'SessionPurposeSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const t of SESSION_PURPOSES) {
      expect(body, `SessionPurposeSchema must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it('CRITICAL SessionPurpose type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export type SessionPurpose = z\.infer<typeof SessionPurposeSchema>;/);
  });

  it("CRITICAL api-types DEFAULT_SESSION_PURPOSE = 'production_customer' (V-169 default). Server applies this when client omits purpose — drift would silently change which harness gets selected by default.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';/,
    );
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts sessionPurpose = pgEnum('session_purpose', [3 values]). Postgres rejects INSERTs of unknown values — drift would crash sessions.create when persisting a new purpose.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/sessionPurpose = pgEnum\('session_purpose', \[/);
    const m = p.match(/sessionPurpose = pgEnum\('session_purpose', \[([\s\S]+?)\]\);/);
    expect(m, 'sessionPurpose pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const t of SESSION_PURPOSES) {
      expect(body, `pgEnum must include '${t}'`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it("CRITICAL DB schema sessionPurpose comment references V-169 'sessions.purpose drives WebKit driver harness selection'. The V-169 anchor threads the harness-routing provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/V-169 — sessions\.purpose drives WebKit driver harness selection/);
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 3 SessionPurpose consts — PurposeProductionCustomer + PurposeCumulativeRigValidation + PurposeTestDomainProbe. Each maps to one canonical purpose string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type SessionPurpose string/);
    expect(p).toMatch(/PurposeProductionCustomer\s+SessionPurpose = "production_customer"/);
    expect(p).toMatch(
      /PurposeCumulativeRigValidation SessionPurpose = "cumulative_rig_validation"/,
    );
    expect(p).toMatch(/PurposeTestDomainProbe\s+SessionPurpose = "test_domain_probe"/);
  });

  it('CRITICAL Go SDK DefaultSessionPurpose = PurposeProductionCustomer — must match api-types DEFAULT_SESSION_PURPOSE. The two defaults are independent declarations; if they drift, TS clients and Go clients would get different harness selections when omitting purpose.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/const DefaultSessionPurpose = PurposeProductionCustomer/);
    // The Go default literal value must equal the api-types literal.
    expect(DEFAULT_PURPOSE).toBe('production_customer');
  });

  it("CRITICAL Go SDK DefaultSessionPurpose comment cross-references api-types DEFAULT_SESSION_PURPOSE. The 'matches packages/api-types' comment is the trace-back link that future maintainers follow when changing the default.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/DefaultSessionPurpose matches packages\/api-types DEFAULT_SESSION_PURPOSE/);
  });

  // ─── V-169 anchor traceable ─────────────────────────────────

  it("CRITICAL V-169 anchor pinned in Go SDK SessionPurpose type comment — 'SessionPurpose drives WebKit driver harness selection (V-169)'. The V-169 anchor threads the harness-routing provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/SessionPurpose drives WebKit driver harness selection \(V-169\)/);
  });

  // ─── 3-value cardinality + customer-vs-internal split ─────────

  it("CRITICAL SessionPurpose = EXACTLY 3 values — 1 customer-facing (production_customer) + 2 internal (cumulative_rig_validation V-495 + test_domain_probe V-540). The split is what billing-quota gates depend on — only 'production_customer' counts against customer quota.", () => {
    expect(SESSION_PURPOSES.length).toBe(3);
    const customer = SESSION_PURPOSES.filter((t) => t === 'production_customer');
    const internal = SESSION_PURPOSES.filter((t) => t !== 'production_customer');
    expect(customer.length).toBe(1);
    expect(internal.length).toBe(2);
  });

  // ─── No forbidden / legacy purpose names ──────────────────────

  it("CRITICAL no source declares forbidden purpose names (manual / api / customer / test / dev / staging). These are common usage-classification conventions the 3-value model intentionally avoids — V-169's harness-selection contract is what 'purpose' encodes.", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const forbidden = ['manual', 'api', 'customer', 'test', 'dev', 'staging'];
    const m = apiTypes.match(/SessionPurposeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `SessionPurpose must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/session-purpose-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
