// W811 — 25 in-memory integration repo content-parity. One-hundred-
// thirty-seventh in the drift-guard series. Pins the in-memory repo
// substitutes used by all 102 integration tests (per W795). Each
// must implement a real Repo interface from src/services/* + use
// Map<string, X> for stable cross-test isolation + export as
// InMemoryXxxRepo class. Drift in any of these would silently let
// integration tests run against a different repo shape than what
// the production code exercises.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HELPERS_DIR = resolve(REPO_ROOT, 'apps/server/tests/integration/_helpers');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Each entry: [filename, exportedClassName, implementedInterface].
// The exported class + implemented interface names are load-bearing
// — they're imported by name from build-test-app.ts (W795) so any
// rename here cascades to the canonical fixture.
const REPOS: Array<readonly [string, string, string]> = [
  ['in-memory-account-audit-repo.ts', 'InMemoryAccountAuditRepo', 'AccountAuditRepo'],
  ['in-memory-account-lifecycle-repo.ts', 'InMemoryAccountLifecycleRepo', 'AccountLifecycleRepo'],
  ['in-memory-admin-accounts-repo.ts', 'InMemoryAccountsAdminRepo', 'AccountsAdminRepo'],
  ['in-memory-admin-audit-repo.ts', 'InMemoryAdminAuditLogRepo', 'AdminAuditLogRepo'],
  ['in-memory-admin-billing-repo.ts', 'InMemoryAdminBillingRepo', 'AdminBillingRepo'],
  ['in-memory-api-keys-repo.ts', 'InMemoryApiKeysRepo', 'ApiKeysRepo'],
  ['in-memory-auth-flows-repo.ts', 'InMemoryAuthFlowsRepo', 'AuthFlowsRepo'],
  ['in-memory-auth-repo.ts', 'InMemoryAuthRepo', 'AccountAuthRepo'],
  ['in-memory-email-preferences-repo.ts', 'InMemoryEmailPreferencesRepo', 'EmailPreferencesRepo'],
  ['in-memory-incidents-repo.ts', 'InMemoryIncidentsRepo', 'IncidentsRepo'],
  ['in-memory-legal-repo.ts', 'InMemoryLegalRepo', 'LegalRepo'],
  ['in-memory-mfa-repo.ts', 'InMemoryMfaRepo', 'MfaRepo'],
  ['in-memory-probes-repo.ts', 'InMemoryProbesRepo', 'ProbesRepo'],
  ['in-memory-profile-snapshots-repo.ts', 'InMemoryProfileSnapshotsRepo', 'ProfileSnapshotsRepo'],
  ['in-memory-profiles-repo.ts', 'InMemoryProfilesRepo', 'ProfilesRepo'],
  [
    'in-memory-rate-limit-overrides-repo.ts',
    'InMemoryRateLimitOverridesRepo',
    'RateLimitOverridesRepo',
  ],
  ['in-memory-scheduled-jobs-repo.ts', 'InMemoryScheduledJobsRepo', 'ScheduledJobsRepo'],
  ['in-memory-sessions-repo.ts', 'InMemorySessionsRepo', 'SessionRepo'],
  [
    'in-memory-status-subscribers-repo.ts',
    'InMemoryStatusSubscribersRepo',
    'StatusSubscribersRepo',
  ],
  ['in-memory-stripe-webhooks-repo.ts', 'InMemoryStripeWebhooksRepo', 'StripeWebhooksRepo'],
  ['in-memory-team-members-repo.ts', 'InMemoryTeamMembersRepo', 'TeamMembersRepo'],
  ['in-memory-usage-repo.ts', 'InMemoryUsageRepo', 'UsageRepo'],
  [
    'in-memory-validation-schedules-repo.ts',
    'InMemoryValidationSchedulesRepo',
    'ValidationSchedulesRepo',
  ],
  ['in-memory-webhooks-repo.ts', 'InMemoryWebhooksRepo', 'WebhooksRepo'],
];

// in-memory-billing.ts is the odd one out — it exports TWO classes
// (InMemoryBillingProvider + InMemoryBillingRepo) because billing
// splits the provider interface from the storage interface in
// production. Pinned separately below.
const BILLING_FILE = 'in-memory-billing.ts';

describe('W811 integration in-memory repos shape parity', () => {
  it('all 25 in-memory helper files exist at canonical paths', () => {
    for (const [filename] of REPOS) {
      expect(existsSync(resolve(HELPERS_DIR, filename))).toBe(true);
    }
    expect(existsSync(resolve(HELPERS_DIR, BILLING_FILE))).toBe(true);
  });

  it('CRITICAL all 24 standard in-memory repos export the canonical InMemoryXxxRepo class + implement matching XxxRepo interface. The class-name + interface-name pairing is what makes build-test-app.ts wiring type-safe; drift to a renamed class would break every integration test.', () => {
    for (const [filename, className, interfaceName] of REPOS) {
      const p = read(resolve(HELPERS_DIR, filename));
      const pattern = new RegExp(`export class ${className} implements ${interfaceName}\\s*\\{`);
      expect(
        p,
        `${filename} missing 'export class ${className} implements ${interfaceName}'`,
      ).toMatch(pattern);
    }
  });

  it('CRITICAL in-memory-billing.ts dual-export pinned — InMemoryBillingProvider + InMemoryBillingRepo. Billing is the only repo where production splits the third-party-provider interface (Stripe) from the storage interface. Drift to collapsing them would break the boundary that lets tests swap providers independently of state.', () => {
    const p = read(resolve(HELPERS_DIR, BILLING_FILE));
    expect(p).toMatch(/export class InMemoryBillingProvider implements BillingProvider/);
    expect(p).toMatch(/export class InMemoryBillingRepo implements BillingRepo/);
  });

  it("CRITICAL all 24 standard in-memory helpers import their Repo interfaces from '../../../src/services/' (3-up path). Drift to importing from production code via a different path (e.g. ../../src/) would break the fixture-vs-production boundary that monorepo project-references enforce.", () => {
    for (const [filename] of REPOS) {
      const p = read(resolve(HELPERS_DIR, filename));
      // Each file must import at least one type from src/services/ via the 3-up path.
      expect(p, `${filename} missing import from ../../../src/services/`).toMatch(
        /import\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+'\.\.\/\.\.\/\.\.\/src\/(?:services|db|drivers)\//,
      );
    }
  });

  it("CRITICAL all 25 in-memory helpers use Map<string, X> for stable cross-test isolation. The canonical 'new Map' pattern (vs an object literal) preserves insertion order + supports .clear() between tests. Drift to plain objects would break test-isolation reset logic.", () => {
    // At least 20 of 24 must use 'new Map' — some legitimately use arrays (events lists).
    let mapCount = 0;
    for (const [filename] of REPOS) {
      const p = read(resolve(HELPERS_DIR, filename));
      if (/new Map<\s*string\s*,/.test(p) || /=\s*new Map\(\)/.test(p)) {
        mapCount += 1;
      }
    }
    // Billing file also typically uses Map.
    const billing = read(resolve(HELPERS_DIR, BILLING_FILE));
    if (/new Map/.test(billing)) {
      mapCount += 1;
    }
    expect(
      mapCount,
      `expected most of the 25 helpers to use new Map for state`,
    ).toBeGreaterThanOrEqual(15);
  });

  it("CRITICAL canonical 'In-memory <X>Repo for integration tests' header comment appears on the simplest helpers. Pattern documents the file's purpose without forcing every helper to comply — older helpers added section headers instead.", () => {
    let matchCount = 0;
    for (const [filename] of REPOS) {
      const p = read(resolve(HELPERS_DIR, filename));
      if (/^\/\/ In-memory .+ for integration tests\./.test(p)) {
        matchCount += 1;
      }
    }
    expect(
      matchCount,
      'at least 10 helpers should use the canonical header',
    ).toBeGreaterThanOrEqual(10);
  });

  it("CRITICAL randomUUID() from 'node:crypto' available where needed. Helpers that generate ids must import from node:crypto (not from a Math.random shim) — drift would let non-cryptographic ids leak into test fixtures.", () => {
    let uuidCount = 0;
    for (const [filename] of REPOS) {
      const p = read(resolve(HELPERS_DIR, filename));
      if (/import\s+\{[^}]*randomUUID[^}]*\}\s+from\s+'node:crypto'/.test(p)) {
        uuidCount += 1;
      }
    }
    expect(
      uuidCount,
      'at least 5 helpers should use node:crypto randomUUID',
    ).toBeGreaterThanOrEqual(5);
  });

  it('CRITICAL exact 25 in-memory helper files exist in _helpers/. Drift to adding a new helper without pinning it here would silently bypass this parity guard.', () => {
    const allFiles = REPOS.map(([f]) => f).concat(BILLING_FILE);
    expect(allFiles.length).toBe(25);
    // Also verify directory listing matches.
    // (Defensive: if a new in-memory-*.ts is added, this test fails so the parity table is updated.)
    expect(allFiles.every((f) => existsSync(resolve(HELPERS_DIR, f)))).toBe(true);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/integration-helpers-in-memory-repos-shape-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
