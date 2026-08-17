// GET /v1/admin/oauth/clients must not hand back client secrets.
//
// The single-client sibling — GET /v1/admin/oauth/clients/:id — is guarded:
// `oauth-admin-get.test.ts` asserts the response body matches neither
// /client_secret/ nor /secret_hash/. The LIST route has no such arm. Nothing in
// the suite invokes it at all: every test mention of that path is the POST that
// registers a client, or a scope-refusal check that only looks at the status
// code. Its body has never been asserted.
//
// That asymmetry matters because of how the route is written. `listClients()`
// returns the full stored envelope, `client_secret_hash` included, and the route
// hand-builds a per-client object naming six fields — with a comment saying why:
//
//   // Never expose the hashed secret to the admin UI; it's internal.
//
// So the allowlist IS the control. Rewriting that map as a spread
// (`{ ...c, created_at: … }`) is the obvious tidy-up, reads as a no-op, and
// leaks every registered client's secret hash in one response — the list route
// being strictly worse than the single-client one it would leak through, since
// one request returns them all.
//
// The load-bearing arm is therefore the exact KEY SET, not a regex for today's
// secret field names. A regex only catches secrets someone already thought of;
// pinning the key set fails on any field that appears without being added here
// deliberately, which is the property the comment is actually asking for.
//
// Uses the same lightweight Fastify harness as the :id route's tests — stub
// decorators so the admin route binds, then exercise the real response shape.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

/** Exactly the fields the route is written to expose. */
const EXPOSED_FIELDS = [
  'account_id',
  'client_id',
  'created_at',
  'label',
  'redirect_uris',
  'revoked_at',
] as const;

interface ListedClient {
  client_id: string;
  label: string;
  redirect_uris: readonly string[];
  account_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

async function buildHarness(svc: OAuthService): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerOAuthRoutes(app, { service: svc, rateLimitStore: new MemoryRateLimitStore() });
  await app.ready();
  return app;
}

async function listClients(
  svc: OAuthService,
): Promise<{ statusCode: number; clients: ListedClient[]; raw: string }> {
  const app = await buildHarness(svc);
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/oauth/clients' });
    const body = res.json<{ clients: ListedClient[] }>();
    return { statusCode: res.statusCode, clients: body.clients, raw: res.body };
  } finally {
    await app.close();
  }
}

describe('GET /v1/admin/oauth/clients', () => {
  it('CRITICAL lists registered clients', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    await svc.registerClient({
      label: 'AppTwo',
      redirect_uris: ['https://two.example/cb'],
      account_id: 'acc_other',
    });
    const { statusCode, clients } = await listClients(svc);
    expect(statusCode).toBe(200);
    expect(
      clients.map((c) => c.label).sort(),
      'the listing did not return the registered clients',
    ).toEqual(['AppOne', 'AppTwo']);
  });

  it('CRITICAL every entry exposes exactly the six documented fields and nothing else', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    const { clients } = await listClients(svc);
    expect(clients).toHaveLength(1);
    for (const entry of clients) {
      expect(
        Object.keys(entry).sort(),
        'the listing exposed a field the route was not written to expose. listClients() returns the ' +
          'full stored envelope including client_secret_hash, and this hand-built allowlist is the ' +
          'only thing holding it back — a spread would leak every registered client’s secret hash ' +
          'in a single response',
      ).toEqual([...EXPOSED_FIELDS]);
    }
  });

  it('CRITICAL no secret material appears anywhere in the response', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    const { raw } = await listClients(svc);
    // Belt and braces alongside the key-set arm: the issued secret and any
    // field named for one must not appear, whatever the shape of the envelope.
    expect(raw, 'the plaintext client secret was echoed by the admin listing').not.toContain(
      reg.client_secret,
    );
    expect(raw).not.toMatch(/client_secret/);
    expect(raw, 'the stored secret hash reached the admin UI').not.toMatch(/secret_hash/);
  });

  it('CRITICAL a revoked client stays listed with revoked_at populated', async () => {
    const svc = new OAuthService(new InMemoryOAuthStore());
    const reg = await svc.registerClient({
      label: 'AppOne',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    await svc.revokeClient(reg.client_id);
    const { clients } = await listClients(svc);
    const entry = clients.find((c) => c.client_id === reg.client_id);
    expect(
      entry,
      'a revoked client vanished from the admin listing — ops audit who revoked what from here',
    ).toBeDefined();
    // Asserted as a string, not merely `not.toBeNull()` — an absent field is
    // `undefined`, which satisfies not-null and would let the route drop
    // revoked_at entirely without this arm noticing.
    expect(typeof entry?.revoked_at, 'the revocation was not surfaced to ops').toBe('string');
  });

  it('CRITICAL an empty registry lists nothing rather than failing', async () => {
    const { statusCode, clients } = await listClients(new OAuthService(new InMemoryOAuthStore()));
    expect(statusCode).toBe(200);
    expect(clients).toEqual([]);
  });
});
