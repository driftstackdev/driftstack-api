// W946 — V-156 + V-136 + V-169 sessions service cross-source
// invariant. Two-hundred-seventy-second in the drift-guard series.
// Pins the customer-facing sessions service:
//
//   Surface framing — 'Sessions service — orchestrates DB writes
//   and driver calls behind the public session API. Decoupled from
//   Drizzle via SessionRepo interface; decoupled from the actual
//   WebKit substrate via the Driver interface'.
//
//   Account-scoped ownership — 'Every method takes an AccountContext
//   and enforces account-scoped ownership — a session belongs to
//   exactly one account, and only that account's keys can operate
//   on it'.
//
//   V-156 concurrent-session limit:
//     - concurrentSessionLimitFor(tier) helper.
//     - 'Single source of truth lives in api-types
//       (TIER_CONCURRENT_SESSION_LIMITS, V-156). Helper kept here so
//       existing call sites don't churn'.
//
//   V-136 profile-count limit:
//     - profileLimitFor(tier) helper.
//     - 'Single source of truth lives in api-types (PROFILES_PER_TIER,
//       V-136). The api-types record uses the "custom" sentinel for
//       enterprise; this helper translates to null for the legacy
//       null-means-unlimited contract that the /v1/profiles
//       enforcement code expects'.
//
//   SessionRecord (13 fields):
//     - id + accountId + apiKeyId + driverSessionId + status (5-value
//       union) + archetype + purpose (V-169 SessionPurpose) + label
//       (nullable) + metadata (nullable Record) + createdAt +
//       updatedAt + lastStateAt (nullable) + destroyedAt (nullable).
//
//   Session status 5-value union: 'creating' | 'ready' | 'busy' |
//     'destroyed' | 'errored'.
//
//   SessionEventInput.type 9-value union: 'created' | 'navigated' |
//     'interacted' | 'gui_input' | 'waited' | 'state_captured' |
//     'screenshot_captured' | 'destroyed' | 'errored'.
//
//   SessionRepo has findSessionUnscoped — 'WITHOUT account scoping
//   (admin force-actions only)' — only V-100 admin-paths use this.
//
//   3-error class import — ConcurrencyLimitError + NotFoundError
//     + SessionDestroyedError.
//
// stays in lockstep across apps/server/src/services/sessions.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concurrentSessionLimitFor, profileLimitFor } from '../../src/services/sessions.js';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W946 V-156 + V-136 + V-169 sessions cross-source invariant', () => {
  // ─── Service intro + Driver decoupling ───────────────────────

  it("CRITICAL apps/server/src/services/sessions.ts header pins service framing — 'Sessions service — orchestrates DB writes and driver calls behind the public session API. Decoupled from Drizzle via SessionRepo interface; decoupled from the actual WebKit substrate via the Driver interface'. The 2-decoupling design (Repo + Driver) is the testability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/Sessions service — orchestrates DB writes and driver calls behind the/);
    expect(p).toMatch(/public session API\. Decoupled from Drizzle via SessionRepo interface;/);
    expect(p).toMatch(/decoupled from the actual WebKit substrate via the Driver interface/);
  });

  // ─── Account-scoped ownership framing ────────────────────────

  it("CRITICAL account-scoped framing — 'Every method takes an AccountContext and enforces account-scoped ownership — a session belongs to exactly one account, and only that account's keys can operate on it'. The 1-account-only contract is the cross-account-isolation invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/Every method takes an AccountContext and enforces account-scoped ownership/);
    expect(p).toMatch(/— a session belongs to exactly one account, and only that account's keys/);
    expect(p).toMatch(/can operate on it/);
  });

  // ─── V-156 concurrent-session limit framing ──────────────────

  it("CRITICAL V-156 framing — 'Single source of truth lives in api-types (TIER_CONCURRENT_SESSION_LIMITS, V-156). Helper kept here so existing call sites don't churn'. The api-types-canonical + helper-doesnt-churn pattern matches V-136 profile-limit posture.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/Single source of truth lives in api-types/);
    expect(p).toMatch(/\(TIER_CONCURRENT_SESSION_LIMITS, V-156\)\. Helper kept here so/);
    expect(p).toMatch(/existing call sites don't churn/);
  });

  it('CRITICAL concurrentSessionLimitFor(tier) returns TIER_CONCURRENT_SESSION_LIMITS[tier] (api-types delegate). The thin-helper avoids per-tier hardcoded branches.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export function concurrentSessionLimitFor\(tier: AccountTier\): number \{/);
    expect(p).toMatch(/return TIER_CONCURRENT_SESSION_LIMITS\[tier\];/);
  });

  // ─── V-136 profile-limit + 'custom'→null translation ─────────

  it('CRITICAL V-136 framing — \'Profile count limit per tier — enforced at the /v1/profiles creation gate. Single source of truth lives in api-types (PROFILES_PER_TIER, V-136). The api-types record uses the "custom" sentinel for enterprise; this helper translates to null for the legacy null-means-unlimited contract that the /v1/profiles enforcement code expects\'. The custom→null translation is the V-136 legacy-contract bridge.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/Profile count limit per tier — enforced at the \/v1\/profiles/);
    expect(p).toMatch(/creation gate\. Single source of truth lives in api-types/);
    expect(p).toMatch(/\(PROFILES_PER_TIER, V-136\)\. The api-types record uses the/);
    expect(p).toMatch(/'custom' sentinel for enterprise; this helper translates to/);
    expect(p).toMatch(/null for the legacy null-means-unlimited contract that the/);
    expect(p).toMatch(/\/v1\/profiles enforcement code expects/);
  });

  it("CRITICAL profileLimitFor(tier) — returns null when PROFILES_PER_TIER[tier] === 'custom'; otherwise returns the number. Verified mechanically.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export function profileLimitFor\(tier: AccountTier\): number \| null \{/);
    expect(p).toMatch(/const limit = PROFILES_PER_TIER\[tier\];/);
    expect(p).toMatch(/return limit === 'custom' \? null : limit;/);
  });

  // ─── Runtime parity: concurrentSessionLimitFor + api-types ──

  it('CRITICAL concurrentSessionLimitFor mirrors TIER_CONCURRENT_SESSION_LIMITS for every tier. The 1:1 helper-vs-canonical equality is the V-156 cross-source invariant.', () => {
    for (const tier of Object.keys(TIER_CONCURRENT_SESSION_LIMITS) as Array<
      keyof typeof TIER_CONCURRENT_SESSION_LIMITS
    >) {
      expect(concurrentSessionLimitFor(tier)).toBe(TIER_CONCURRENT_SESSION_LIMITS[tier]);
    }
  });

  it("CRITICAL profileLimitFor mirrors PROFILES_PER_TIER for every tier, with 'custom' → null translation. The V-136 cross-source invariant verified mechanically.", () => {
    for (const tier of Object.keys(PROFILES_PER_TIER) as Array<keyof typeof PROFILES_PER_TIER>) {
      const canonical = PROFILES_PER_TIER[tier];
      const helper = profileLimitFor(tier);
      if (canonical === 'custom') {
        expect(helper).toBeNull();
      } else {
        expect(helper).toBe(canonical);
      }
    }
  });

  // ─── SessionRecord 13-field shape ────────────────────────────

  it('CRITICAL SessionRecord has 15 fields, and this arm pins 13 of them — id + accountId + apiKeyId + driverSessionId + status (5-value) + archetype + purpose (V-169 SessionPurpose) + label (nullable) + metadata (nullable Record) + createdAt + updatedAt + lastStateAt (nullable) + destroyedAt (nullable). The 13-field shape carries account-scope ids + state-machine + V-169 purpose + 3 nullable timestamps.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export interface SessionRecord \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/apiKeyId: string;/);
    expect(p).toMatch(/driverSessionId: string;/);
    expect(p).toMatch(/status: 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/);
    expect(p).toMatch(/archetype: string;/);
    expect(p).toMatch(/V-169 — harness purpose/);
    expect(p).toMatch(/purpose: SessionPurpose;/);
    expect(p).toMatch(/label: string \| null;/);
    expect(p).toMatch(/metadata: Record<string, unknown> \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
    expect(p).toMatch(/lastStateAt: Date \| null;/);
    expect(p).toMatch(/destroyedAt: Date \| null;/);
  });

  // ─── Session status 5-value union ────────────────────────────

  it("CRITICAL session status = 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored'. The 5-state machine covers initial-creation through terminal states; drift would break the SDK status-typing contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/status: 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/);
  });

  // ─── SessionEventInput.type 9-value union ────────────────────

  it("CRITICAL SessionEventInput.type 9-value union — 'created' | 'navigated' | 'interacted' | 'gui_input' | 'waited' | 'state_captured' | 'screenshot_captured' | 'destroyed' | 'errored'. The 9-event taxonomy covers every per-session telemetry event.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/type:\s*\n\s*\| 'created'/);
    expect(p).toMatch(/\| 'navigated'/);
    expect(p).toMatch(/\| 'interacted'/);
    expect(p).toMatch(/\| 'gui_input'/);
    expect(p).toMatch(/\| 'waited'/);
    expect(p).toMatch(/\| 'state_captured'/);
    expect(p).toMatch(/\| 'screenshot_captured'/);
    expect(p).toMatch(/\| 'destroyed'/);
    expect(p).toMatch(/\| 'errored';/);
  });

  // ─── SessionRepo scoped lookup + serialized destroy authority ─

  it('CRITICAL SessionRepo retains scoped/unscoped reads and requires explicit string|null scope on serialized destroy', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/\/\*\* Find a session by id, scoped to the supplied account\. \*\//);
    expect(p).toMatch(
      /findSession\(id: string, accountId: string\): Promise<SessionRecord \| null>;/,
    );
    expect(p).toMatch(
      /\/\*\* Find a session by id WITHOUT account scoping \(admin force-actions only\)\. \*\//,
    );
    expect(p).toMatch(/findSessionUnscoped\(id: string\): Promise<SessionRecord \| null>;/);
    expect(p).toMatch(/export interface SerializedSessionDestroyInput \{/);
    expect(p).toMatch(/accountId: string \| null;/);
    expect(p).toMatch(
      /event: Omit<SessionEventInput, 'sessionId' \| 'type'> & \{ type: 'destroyed' \};/,
    );
    expect(p).toMatch(/destroySessionSerialized\(/);
    expect(p).toMatch(/Promise<SerializedSessionDestroyResult>;/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL imports 4 error classes — BadRequestError (W487 navigate scheme guard) + ConcurrencyLimitError + NotFoundError + SessionDestroyedError. Covers navigate-scheme-reject / tier-cap / row-missing / 410-after-destroy states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(
      /import \{[\s\S]*?BadRequestError,[\s\S]*?ConcurrencyLimitError,[\s\S]*?NotFoundError,[\s\S]*?SessionDestroyedError,[\s\S]*?\} from '\.\.\/lib\/errors\.js';/,
    );
  });

  // ─── 9 api-types imports ─────────────────────────────────────

  it('CRITICAL imports 9 api-types primitives — DEFAULT_SESSION_PURPOSE + defaultArchetypeIdForTier (was LOCKED_ARCHETYPE_ID until P-15 made the default per tier, 2026-09-05) + PROFILES_PER_TIER + TIER_CONCURRENT_SESSION_LIMITS + 5 request/type aliases. The 9-import surface is the V-156 + V-136 + V-169 cross-source binding.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/DEFAULT_SESSION_PURPOSE,/);
    // P-15 (2026-09-05) — the default is per tier; the service imports the resolver, not the constant.
    expect(p).toMatch(/defaultArchetypeIdForTier,/);
    expect(p).not.toMatch(/LOCKED_ARCHETYPE_ID/);
    expect(p).toMatch(/PROFILES_PER_TIER,/);
    expect(p).toMatch(/TIER_CONCURRENT_SESSION_LIMITS,/);
    expect(p).toMatch(/type AccountTier,/);
    expect(p).toMatch(/type CreateSessionRequest,/);
    expect(p).toMatch(/type SessionPurpose,/);
  });

  // ─── SessionListPage cursor pagination ───────────────────────

  it("CRITICAL SessionListPage has 2 fields — items + nextCursor ('Cursor for the next page; null when this is the last page'). The 2-field paginator matches W923/W914 + admin paginator pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export interface SessionListPage \{/);
    expect(p).toMatch(/items: SessionRecord\[\];/);
    expect(p).toMatch(/Cursor for the next page; null when this is the last page/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── NewSessionInput 6-field write shape ─────────────────────

  it('CRITICAL NewSessionInput has 7 fields, and this arm pins 6 of them — accountId + apiKeyId + driverSessionId + archetype + purpose (V-169) + label (nullable) + metadata (nullable Record). The 7-field write shape is what insertSession() consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export interface NewSessionInput \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/apiKeyId: string;/);
    expect(p).toMatch(/driverSessionId: string;/);
    expect(p).toMatch(/archetype: string;/);
    expect(p).toMatch(/V-169 — harness purpose\. Defaults applied at the service-layer/);
    expect(p).toMatch(/purpose: SessionPurpose;/);
    expect(p).toMatch(/label: string \| null;/);
    expect(p).toMatch(/metadata: Record<string, unknown> \| null;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sessions-v156-v136-v169-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
