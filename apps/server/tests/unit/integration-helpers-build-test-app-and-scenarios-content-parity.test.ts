// W795 — apps/server/tests/integration/_helpers/build-test-app.ts +
// scenarios.ts content parity. One-hundred-twenty-first in the
// cross-SDK drift-guard series.
//
// build-test-app.ts is the canonical Fastify-app fixture for all 102
// integration tests. scenarios.ts (V-130) layers shared "with N
// profiles/sessions/webhooks/subscription" shapes on top. Drift to
// either file silently changes the test setup for every integration
// test — far worse than drift in a per-test fixture would be.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const BUILD_APP = resolve(REPO_ROOT, 'apps/server/tests/integration/_helpers/build-test-app.ts');
const SCENARIOS = resolve(REPO_ROOT, 'apps/server/tests/integration/_helpers/scenarios.ts');

describe('W795 integration _helpers/build-test-app + scenarios parity', () => {
  it('both files exist at canonical paths', () => {
    expect(existsSync(BUILD_APP)).toBe(true);
    expect(existsSync(SCENARIOS)).toBe(true);
  });

  // ─── build-test-app.ts ────────────────────────────────────────

  it("CRITICAL build-test-app 4-bullet config framing pinned. The 'Builds a Fastify app instance configured for integration tests' + 'silent logger (no log spam in test output)' + 'in-memory auth repo seeded with one Pro-tier account + one API key' + 'in-memory rate limiter' + 'permissive CORS' wording is the canonical test-fixture contract.", () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(/\/\/ Builds a Fastify app instance configured for integration tests:/);
    expect(p).toMatch(/\/\/\s+- silent logger \(no log spam in test output\)/);
    expect(p).toMatch(
      /\/\/\s+- in-memory auth repo seeded with one Pro-tier account \+ one API key/,
    );
    expect(p).toMatch(/\/\/\s+- in-memory rate limiter/);
    expect(p).toMatch(/\/\/\s+- permissive CORS/);
  });

  it("CRITICAL returns-helpers framing pinned. The 'Returns the app, plain-text key, and helpers for direct repo manipulation' wording explains the 3-thing fixture API.", () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(
      /\/\/ Returns the app, plain-text key, and helpers for direct repo manipulation\./,
    );
  });

  it('CRITICAL 5-export-interface set pinned — TestAppOptions + SeedAdditionalOpts + AdditionalAccount + TestAppFixture + R2FakeStore. Drift to dropping any would break every integration test using the corresponding shape.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(/export interface TestAppOptions \{/);
    expect(p).toMatch(/export interface SeedAdditionalOpts \{/);
    expect(p).toMatch(/export interface AdditionalAccount \{/);
    expect(p).toMatch(/export interface TestAppFixture \{/);
    expect(p).toMatch(/export interface R2FakeStore \{/);
  });

  it('CRITICAL 2 exported async functions — buildTestApp + seedAdditionalAccount. Drift to dropping seedAdditionalAccount would break multi-account integration tests.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(
      /export async function buildTestApp\(opts: TestAppOptions = \{\}\): Promise<TestAppFixture> \{/,
    );
    expect(p).toMatch(/export async function seedAdditionalAccount\(/);
  });

  it('CRITICAL real-services + in-memory-repos pattern pinned. The fixture imports real service classes (SessionsService, ApiKeysService, etc.) but wires them up against InMemoryXxxRepo implementations. Drift to mocking the services would lose the end-to-end-validated-state property that 102 integration tests rely on.', () => {
    const p = read(BUILD_APP);

    // Real services imported from production paths.
    expect(p).toMatch(
      /import \{ SessionsService \} from '\.\.\/\.\.\/\.\.\/src\/services\/sessions\.js';/,
    );
    expect(p).toMatch(
      /import \{ ApiKeysService \} from '\.\.\/\.\.\/\.\.\/src\/services\/api-keys\.js';/,
    );
    expect(p).toMatch(
      /import \{ WebhooksService, WebhooksAdminService \} from '\.\.\/\.\.\/\.\.\/src\/services\/webhooks\.js';/,
    );
    expect(p).toMatch(
      // S45 2026-07-07 — the fixture also imports IncidentRow (typed
      // helper for the incident.broadcast publish mirror).
      /import \{ IncidentsService, type IncidentRow \} from '\.\.\/\.\.\/\.\.\/src\/services\/incidents\.js';/,
    );

    // In-memory repo imports from the _helpers/ sibling directory.
    expect(p).toMatch(
      /import \{ InMemoryIncidentsRepo \} from '\.\/in-memory-incidents-repo\.js';/,
    );
    expect(p).toMatch(
      /import \{ InMemoryStatusSubscribersRepo \} from '\.\/in-memory-status-subscribers-repo\.js';/,
    );
    expect(p).toMatch(
      /import \{ InMemoryEmailPreferencesRepo \} from '\.\/in-memory-email-preferences-repo\.js';/,
    );
  });

  it('CRITICAL MockDriver-as-default + WebKit-driver-not-integrated framing pinned. The MockDriver import shape matches W761 /api/sessions driver-not-integrated 503 contract for non-mock environments.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(/import \{ MockDriver \} from '\.\.\/\.\.\/\.\.\/src\/drivers\/mock\.js';/);
  });

  it('CRITICAL InMemoryAuthCache + AuthCoalescer + MemoryRateLimitStore wired. Matches W793 V-120 bench InMemoryAuthCache imports + V-123 MemoryRateLimitStore. Drift to a different cache impl would change auth-path timing in every integration test.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(
      /import \{ InMemoryAuthCache \} from '\.\.\/\.\.\/\.\.\/src\/services\/auth-cache\.js';/,
    );
    expect(p).toMatch(
      /import \{ AuthCoalescer \} from '\.\.\/\.\.\/\.\.\/src\/services\/auth-coalescer\.js';/,
    );
    expect(p).toMatch(
      /import \{ MemoryRateLimitStore \} from '\.\.\/\.\.\/\.\.\/src\/lib\/memory-rate-limit-store\.js';/,
    );
  });

  it('CRITICAL real-app-builder pinned — imports buildApp from src/lib/app.js. Drift to inlining the app construction would let the test fixture diverge from production app shape.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(
      /import \{ buildApp, type ReadinessCheck \} from '\.\.\/\.\.\/\.\.\/src\/lib\/app\.js';/,
    );
  });

  it('CRITICAL randomUUID alias + InMemoryCryptoOrdersRepo pinned. Drift would change test-data shape for crypto-orders integration tests.', () => {
    const p = read(BUILD_APP);

    expect(p).toMatch(/import \{ randomUUID as testRandomUUID \} from 'node:crypto';/);
    expect(p).toMatch(/InMemoryCryptoOrdersRepo,/);
  });

  // ─── scenarios.ts ─────────────────────────────────────────────

  it("CRITICAL V-130 + tight-scope framing pinned. The 'V-130: Shared scenario fixtures for integration tests' + 'Tight scope per founder direction (V-130): only the patterns actually duplicated in current tests. Don\\'t speculatively expand' wording is the load-bearing scope-limit anchor.", () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/\/\/ V-130: Shared scenario fixtures for integration tests\./);
    expect(p).toMatch(/\/\/ Tight scope per founder direction \(V-130\): only the patterns/);
    expect(p).toMatch(/\/\/ actually duplicated in current tests\. Don't speculatively expand\./);
  });

  it('CRITICAL layered-on-top-of-buildTestApp framing pinned. The \'Layered on top of buildTestApp — that helper already gives us an authenticated account + API key. These functions add the "with N profiles / sessions / webhooks / subscription" shapes that tests currently inline as for (let i = 0; i < N; i++) loops or one-off repo calls\' wording explains the V-130 dedupe rationale.', () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/\/\/ Layered on top of `buildTestApp` — that helper already gives us an/);
    expect(p).toMatch(/\/\/ authenticated account \+ API key\./);
    expect(p).toMatch(
      /These functions add the "with N\s*\n\/\/ profiles \/ sessions \/ webhooks \/ subscription" shapes that tests/,
    );
    expect(p).toMatch(
      /\/\/ currently inline as `for \(let i = 0; i < N; i\+\+\)` loops or one-off\s*\n\/\/ repo calls\./,
    );
  });

  it('CRITICAL 4-seeder export set pinned — seedProfiles + seedSessions + seedWebhookEndpoints + seedActiveSubscription. Drift to dropping any would force integration tests to re-inline the loops V-130 removed.', () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/export async function seedProfiles\(/);
    expect(p).toMatch(/export async function seedSessions\(/);
    expect(p).toMatch(/export async function seedWebhookEndpoints\(/);
    expect(p).toMatch(/export function seedActiveSubscription\(/);
  });

  it('CRITICAL 4-Seeded interface + 4-Opts set pinned. Each seeder pairs a SeededXxx output type + SeedXxxOpts input type for consistent ergonomics.', () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/export interface SeededProfile \{/);
    expect(p).toMatch(/export interface SeedProfilesOpts \{/);
    expect(p).toMatch(/export interface SeededSession \{/);
    expect(p).toMatch(/export interface SeedSessionsOpts \{/);
    expect(p).toMatch(/export interface SeededWebhook \{/);
    expect(p).toMatch(/export interface SeedWebhookEndpointsOpts \{/);
    expect(p).toMatch(/export interface SeedSubscriptionOpts \{/);
  });

  it("CRITICAL goes-through-HTTP-layer framing pinned. The 'Goes through the HTTP layer (not direct repo writes) so tests get end-to-end-validated state — same audit logging, same tier checks, same shape that production traffic would create' wording is the load-bearing seeder-validity contract.", () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(
      /\* Goes through the HTTP layer \(not direct repo writes\) so tests get\s*\n\s+\* end-to-end-validated state — same audit logging, same tier checks,\s*\n\s+\* same shape that production traffic would create\./,
    );
  });

  it('CRITICAL archetype default iphone17_ios18_7_safari26_4 pinned. Matches W763 /api/profiles + W774 /api/profile-snapshots LOCKED_ARCHETYPE_ID convention.', () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(
      /\*\* Archetype applied to every seeded profile\. Default `'iphone17_ios18_7_safari26_4'`\. \*\//,
    );
  });

  it('CRITICAL AccountTier import from @driftstack/api-types pinned. Matches the cross-app shared-type convention seen in W789 admin-panel mocks + W761 server-side.', () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it("CRITICAL TestAppFixture-import-from-build-test-app pinned. The 'import type { TestAppFixture } from \\'./build-test-app.js\\'' tightly couples scenarios.ts to the canonical fixture — drift would let scenarios drift from the test app it operates on.", () => {
    const p = read(SCENARIOS);

    expect(p).toMatch(/import type \{ TestAppFixture \} from '\.\/build-test-app\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/integration-helpers-build-test-app-and-scenarios-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
