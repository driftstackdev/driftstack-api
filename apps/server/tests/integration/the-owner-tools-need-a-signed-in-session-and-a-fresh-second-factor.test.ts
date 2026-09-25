// The owner tools need a signed-in session and a fresh second factor
// (security sweep #17).
//
// Revealing a platform secret returns its plaintext. That route, the secret writes
// and the price edit were gated by the staff scope and the owner check alone, so an
// owner web-session token — kept in the admin panel's localStorage — revealed every
// secret however old its two-factor proof was, while turning two-factor OFF demanded
// a fresh code. An owner API key carrying the staff scope reached them too, and the
// step-up gate lets every API key through by design.
//
// Now secret reveal, write and delete, the price edit, and rate-card publish and
// withdraw need a signed-in session (an API key is refused) and, when two-factor is
// on, a second factor proved in the last five minutes. The rate-card routes refuse an
// API key too: an owner session holds the staff scope, so a stolen one whose second
// factor is an hour old could otherwise mint a staff key (POST /v1/api-keys has no
// step-up) and use it to skip the fresh factor entirely.
// The step-up itself is the existing POST /v1/auth/mfa/step-up; the admin panel asks
// for the code and retries.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import authPlugin from '../../src/middleware/auth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerAdminOwnerRoutes } from '../../src/routes/admin-owner.js';
import { registerAdminAiCreditsRoutes } from '../../src/routes/admin-ai-credits.js';
import { registerAdminRoutes } from '../../src/routes/admin.js';
import { ApiKeysService } from '../../src/services/api-keys.js';
import type { UsageService } from '../../src/services/usage.js';
import { PlatformSecretsService } from '../../src/services/platform-secrets.js';
import { PricingService } from '../../src/services/pricing.js';
import { AdminAuditService } from '../../src/services/admin-audit.js';
import type { MfaService } from '../../src/services/mfa.js';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import type { AiCreditsReportReader } from '../../src/db/ai-credits-report-repo.js';
import type { AccountAuthRepo, AccountContext, ApiKeyRow } from '../../src/services/auth.js';
import { type AuthCache, sha256Hex } from '../../src/services/auth-cache.js';
import { InMemoryPlatformSecretsRepo } from './_helpers/in-memory-platform-secrets-repo.js';
import { InMemoryPricingRepo } from './_helpers/in-memory-pricing-repo.js';
import { InMemoryAdminAuditLogRepo } from './_helpers/in-memory-admin-audit-repo.js';
import { InMemoryApiKeysRepo } from './_helpers/in-memory-api-keys-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';

const OWNER_EMAIL = 'owner-17@driftstack.test';
const OWNER_ID = '00000000-0000-4000-8000-00000000d171';
const STALE_TOKEN = 'ds_web_stale_owner_session_token_0001';
const FRESH_TOKEN = 'ds_web_fresh_owner_session_token_0002';
const KEY_TOKEN = 'ds_live_kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
const STALE_SESSION_ID = '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e171';
const FRESH_SESSION_ID = '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e172';
const OWNER_KEY_ID = '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e173';
const SECRET_VALUE = 'sk-live-OWNER-ONLY-17';

const ACCOUNT = {
  id: OWNER_ID,
  email: OWNER_EMAIL,
  name: null,
  tier: 'api_builder' as const,
  status: 'active' as const,
  timezone: null,
  avatarR2Key: null,
  slug: null,
  region: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function webSessionKey(sessionId: string): ApiKeyRow {
  return {
    id: `wsk_${sessionId}`,
    accountId: OWNER_ID,
    name: 'web-session',
    keyPrefix: 'web_session',
    keyHash: '',
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const OWNER_KEY: ApiKeyRow = {
  id: OWNER_KEY_ID,
  accountId: OWNER_ID,
  name: 'owner staff key',
  keyPrefix: 'ds_live_kkkk',
  keyHash: 'owner-key-hash',
  scopes: ['read', 'write', 'driftstack_internal_admin'],
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function ctx(apiKey: ApiKeyRow, webSessionId: string | null): AccountContext {
  return {
    account: ACCOUNT,
    apiKey,
    rateLimitOverrides: {},
    teams: [],
    webSession: webSessionId === null ? null : { id: webSessionId, mfaSatisfiedAt: null },
  };
}

const CONTEXTS = new Map<string, AccountContext>([
  [sha256Hex(STALE_TOKEN), ctx(webSessionKey(STALE_SESSION_ID), STALE_SESSION_ID)],
  [sha256Hex(FRESH_TOKEN), ctx(webSessionKey(FRESH_SESSION_ID), FRESH_SESSION_ID)],
  [sha256Hex(KEY_TOKEN), ctx(OWNER_KEY, null)],
]);

/** When each session last proved its second factor — read live on every request. */
function mfaSatisfiedAt(sessionId: string): Date {
  return sessionId === FRESH_SESSION_ID
    ? new Date(Date.now() - 30_000)
    : new Date(Date.now() - 60 * 60_000);
}

/** `minted` holds every key POST /v1/api-keys creates, so a freshly minted key authenticates. */
function makeRepo(minted: InMemoryAuthRepo): AccountAuthRepo {
  const sessions = new Map([
    [sha256Hex(STALE_TOKEN), STALE_SESSION_ID],
    [sha256Hex(FRESH_TOKEN), FRESH_SESSION_ID],
  ]);
  return {
    findApiKeyByPrefix: (prefix: string) =>
      prefix === OWNER_KEY.keyPrefix
        ? Promise.resolve(OWNER_KEY)
        : minted.findApiKeyByPrefix(prefix),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveWebSession: ({ tokenHash }: { tokenHash: string }) => {
      const id = sessions.get(tokenHash);
      return Promise.resolve(
        id === undefined
          ? null
          : {
              id,
              accountId: OWNER_ID,
              expiresAt: new Date('2027-01-01T00:00:00Z'),
              revokedAt: null,
              lastUsedAt: null,
              mfaSatisfiedAt: mfaSatisfiedAt(id),
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
      );
    },
    getAccount: (id: string) => Promise.resolve(id === OWNER_ID ? ACCOUNT : null),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
  } as unknown as AccountAuthRepo;
}

function makeCache(): AuthCache {
  return {
    get: (sha: string) => Promise.resolve(CONTEXTS.get(sha) ?? null),
    set: () => Promise.resolve(),
    invalidateKey: () => Promise.resolve(),
    invalidateAccount: () => Promise.resolve(),
  };
}

/** Two-factor is ON for the owner. */
const MFA_ON = {
  getStatus: () => Promise.resolve({ enrolled: true }),
} as unknown as MfaService;

/** Nothing here may reach the credits runtime: every refused or validated call stops first. */
const UNREACHABLE = new Proxy(
  {},
  {
    get: () => {
      throw new Error('a refused request must not reach the credits runtime');
    },
  },
);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  const minted = new InMemoryAuthRepo();
  const authRepo = makeRepo(minted);
  await app.register(authPlugin, {
    authRepo,
    authCache: makeCache(),
    authCoalescer: null,
    ownerEmail: OWNER_EMAIL,
    staffEmails: new Set([OWNER_EMAIL]),
    mfaService: MFA_ON,
  });
  app.decorate('rateLimit', () => async () => {});
  const secretsRepo = new InMemoryPlatformSecretsRepo();
  const secrets = new PlatformSecretsService(secretsRepo, randomBytes(32).toString('base64'));
  await secrets.set({ name: 'stripe_secret_key', value: SECRET_VALUE });
  registerAdminOwnerRoutes(app, {
    platformStatus: {
      billing: false,
      livekit: false,
      crypto: false,
      oauth_client: false,
      sentry: false,
      permissive_cors: false,
    },
    pricing: new PricingService(new InMemoryPricingRepo()),
    secrets,
    audit: new AdminAuditService(new InMemoryAdminAuditLogRepo()),
  });
  registerAdminAiCreditsRoutes(app, {
    report: UNREACHABLE as AiCreditsReportReader,
    aiCredits: UNREACHABLE as AiCreditsRuntime,
    authRepo: { getAccount: () => Promise.resolve(null) },
  });
  // Key minting, so a test can try turning an owner session into a staff API key.
  registerAdminRoutes(app, {
    apiKeysService: new ApiKeysService(new InMemoryApiKeysRepo(minted)),
    usageService: UNREACHABLE as UsageService,
    authRepo,
  });
  await app.ready();
  return app;
}

const SECRET_AND_PRICE_ROUTES: ReadonlyArray<{
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'POST', url: '/v1/admin/owner/secrets/stripe_secret_key/reveal' },
  { method: 'PUT', url: '/v1/admin/owner/secrets/other_key', payload: { value: 'x' } },
  { method: 'DELETE', url: '/v1/admin/owner/secrets/other_key' },
  { method: 'PATCH', url: '/v1/admin/owner/pricing/api_builder', payload: { monthly_cents: 1 } },
];

const RATE_CARD_ROUTES = [
  '/v1/admin/credit-rate-cards',
  '/v1/admin/credit-rate-cards/1/withdraw',
] as const;

function as(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('the owner tools need a signed-in session and a fresh second factor', () => {
  it('CRITICAL an owner session whose second factor is an hour old cannot reveal a secret, write or delete one, or change a price', async () => {
    const app = await buildApp();
    for (const r of SECRET_AND_PRICE_ROUTES) {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: as(STALE_TOKEN),
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body}`).toBe(403);
      expect(res.json<{ requires_mfa_step_up?: boolean }>().requires_mfa_step_up).toBe(true);
      expect(res.body).not.toContain(SECRET_VALUE);
    }
    await app.close();
  });

  it('CRITICAL an owner API key with the staff scope cannot reveal a secret, write or delete one, or change a price', async () => {
    const app = await buildApp();
    for (const r of SECRET_AND_PRICE_ROUTES) {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: as(KEY_TOKEN),
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body}`).toBe(403);
      expect(res.body).not.toContain(SECRET_VALUE);
    }
    await app.close();
  });

  it('CRITICAL rate-card publish and withdraw need a fresh second factor from a signed-in session', async () => {
    const app = await buildApp();
    for (const url of RATE_CARD_ROUTES) {
      const res = await app.inject({ method: 'POST', url, headers: as(STALE_TOKEN), payload: {} });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
      expect(res.json<{ requires_mfa_step_up?: boolean }>().requires_mfa_step_up).toBe(true);
    }
    await app.close();
  });

  it('CRITICAL an owner API key with the staff scope cannot publish or withdraw a rate card', async () => {
    const app = await buildApp();
    for (const url of RATE_CARD_ROUTES) {
      const res = await app.inject({ method: 'POST', url, headers: as(KEY_TOKEN), payload: {} });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/signed-in admin session/);
    }
    await app.close();
  });

  it('CRITICAL a stale owner session cannot skip the fresh second factor by minting a staff key and using that', async () => {
    const app = await buildApp();
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: as(STALE_TOKEN),
      payload: {
        name: 'minted from a stale session',
        scopes: ['read', 'driftstack_internal_admin'],
      },
    });
    // Minting itself is not the owner tool; what matters is that the key it yields
    // gets no further than the session that minted it.
    expect(mint.statusCode, mint.body).toBe(201);
    const staffKey = mint.json<{ plaintext: string; scopes: string[] }>();
    expect(staffKey.scopes).toContain('driftstack_internal_admin');
    // Positive control: the minted key authenticates as the owner with the staff
    // scope — an owner read that needs no fresh factor answers it — so the refusals
    // below are the owner-tool gate, not a dead credential.
    const status = await app.inject({
      method: 'GET',
      url: '/v1/admin/owner/platform-status',
      headers: as(staffKey.plaintext),
    });
    expect(status.statusCode, status.body).toBe(200);
    for (const url of RATE_CARD_ROUTES) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: as(staffKey.plaintext),
        payload: {},
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
    }
    for (const r of SECRET_AND_PRICE_ROUTES) {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: as(staffKey.plaintext),
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}: ${res.body}`).toBe(403);
      expect(res.body).not.toContain(SECRET_VALUE);
    }
    await app.close();
  });

  it('CONTROL a session that proved its second factor a moment ago reveals the secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/owner/secrets/stripe_secret_key/reveal',
      headers: as(FRESH_TOKEN),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ value: string }>().value).toBe(SECRET_VALUE);
    await app.close();
  });

  it('CONTROL the rate-card publish route still reaches its handler from a session that proved its second factor a moment ago (an empty body is its own 400)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/credit-rate-cards',
      headers: as(FRESH_TOKEN),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(400);
    await app.close();
  });
});
