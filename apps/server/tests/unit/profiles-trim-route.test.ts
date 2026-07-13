// Profile-trim (doc-150 §8) — POST /v1/profiles/:id/trim. Out-of-session storage
// eviction: the route resolves the profile DEK + a presigned R2 GET/PUT, picks a
// healthy node from the fleet registry, relays a `trimProfile`, awaits `trimResult`,
// and UPDATEs size_bytes from the re-sealed size on success. Direct route
// registration against a stub Fastify with a fake ProfilesService + fake R2 + a REAL
// FleetControlRegistry (so the node-reply round-trip exercises the real correlator) —
// mirrors fleet-node-control-endpoint.test.ts. The node reply is mocked by the
// registered connection's echoing socket, exactly as the cookies-route tests do.

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerProfileRoutes } from '../../src/routes/profiles.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { NotFoundError } from '../../src/lib/errors.js';
import type { ProfilesService } from '../../src/services/profiles.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { R2 } from '../../src/lib/r2.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_UUID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = `prof_${PROFILE_UUID}`;
const DEK = Buffer.alloc(32, 9);

/** A ProfilesService stub exposing only the four methods the trim route calls.
 *  `recordTrim` captures its args so a test can assert the size_bytes persist. */
function fakeService(opts: {
  ownedProfileUuid?: string; // get() resolves this id; anything else 404s
  dek?: Buffer | null; // getProfileDek() return
  dekThrows?: boolean; // getProfileDek() rejects (corrupt/rotated wrapped-DEK)
}): {
  service: ProfilesService;
  recordTrimCalls: Array<{ profileId: string; accountId: string; newSizeBytes: number }>;
} {
  const recordTrimCalls: Array<{ profileId: string; accountId: string; newSizeBytes: number }> = [];
  const service = {
    get: (args: { id: string; accountId: string }) => {
      if (opts.ownedProfileUuid !== undefined && args.id === opts.ownedProfileUuid) {
        return Promise.resolve({ id: args.id, accountId: args.accountId } as never);
      }
      return Promise.reject(new NotFoundError('Profile not found.'));
    },
    getProfileDek: (_args: { profileId: string; accountId: string }) =>
      opts.dekThrows === true
        ? Promise.reject(new Error('unwrapProfileDek: corrupt/rotated wrapped-DEK'))
        : Promise.resolve(opts.dek === undefined ? DEK : opts.dek),
    recordTrim: (args: { profileId: string; accountId: string; newSizeBytes: number }) => {
      recordTrimCalls.push(args);
      return Promise.resolve();
    },
  } as unknown as ProfilesService;
  return { service, recordTrimCalls };
}

/** A fake R2 — headObject(exists) drives whether buildAssignProfileBlock mints a
 *  GET URL (i.e. whether there's saved state to trim). presign returns stub URLs. */
function fakeR2(opts: { blobExists: boolean }): R2 {
  return {
    headObject: (_key: string) => Promise.resolve({ exists: opts.blobExists }),
    presignGet: ({ key }: { key: string }) => Promise.resolve(`https://r2-fake/${key}?get=1`),
    presignPut: ({ key }: { key: string }) => Promise.resolve(`https://r2-fake/${key}?put=1`),
    putObject: () => Promise.resolve(),
  } as unknown as R2;
}

const fakeAuthRepo = {} as unknown as AccountAuthRepo;

async function buildHarness(deps: {
  service: ProfilesService;
  fleetControlRegistry?: FleetControlRegistry;
  r2?: R2;
  /** #14 — count of active sessions bound to the profile (0 → not in use). */
  activeForProfile?: number;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = { account: { id: ACCOUNT_ID, tier: 'api_builder' }, teams: [] };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  const agentSessions =
    deps.activeForProfile !== undefined
      ? ({
          countActiveForProfile: (_id: string) => Promise.resolve(deps.activeForProfile),
        } as unknown as AgentSessionsRepo)
      : undefined;
  registerProfileRoutes(app, {
    service: deps.service,
    authRepo: fakeAuthRepo,
    ...(deps.fleetControlRegistry !== undefined
      ? { fleetControlRegistry: deps.fleetControlRegistry }
      : {}),
    ...(deps.r2 !== undefined ? { r2: deps.r2 } : {}),
    ...(agentSessions !== undefined ? { agentSessions } : {}),
  });
  await app.ready();
  return app;
}

function trim(app: FastifyInstance, id = PROFILE_ID) {
  return app.inject({
    method: 'POST',
    url: `/v1/profiles/${id}/trim`,
    headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
    // The trim route takes no body, but Fastify 400s an empty-body JSON POST — send {}.
    payload: {},
  });
}

async function waitFor(cond: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface TrimBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
  size_bytes?: number;
  bytes_reclaimed?: number;
}

/** Register a node whose socket echoes a trimResult for the trimProfile it receives.
 *  The inbound REQUEST carries snake_case `profile_id` (the harness Codable wire shape);
 *  the echoed RESULT keeps `profileId` (the node→CP trimResult contract). The reply
 *  callback receives the request's profileId (read from `profile_id`) for convenience. */
function registerEchoNode(
  registry: FleetControlRegistry,
  nodeId: string,
  reply: (frame: { requestId: string; profileId: string }) => Record<string, unknown>,
): { sentTrim: Array<Record<string, unknown>> } {
  const sentTrim: Array<Record<string, unknown>> = [];
  const conn = registry.register(nodeId, (data) => {
    const frame = JSON.parse(data) as { type?: string; requestId: string; profile_id: string };
    if (frame.type === 'trimProfile') {
      sentTrim.push(frame);
      conn.handleInbound(
        JSON.stringify({
          type: 'trimResult',
          requestId: frame.requestId,
          ...reply({ requestId: frame.requestId, profileId: frame.profile_id }),
        }),
      );
    }
  });
  return { sentTrim };
}

describe('POST /v1/profiles/:id/trim', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('unknown/foreign profile id → 404 (never confirms another account’s profile)', async () => {
    const { service } = fakeService({ ownedProfileUuid: 'someone-elses-uuid' });
    app = await buildHarness({
      service,
      fleetControlRegistry: new FleetControlRegistry(),
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(404);
  });

  it('getProfileDek throws (corrupt/rotated wrapped-DEK) → 200 { status:"unavailable" }, NOT a raw 500', async () => {
    // Regression for the profile-lifecycle audit: unwrapProfileDek can throw on a
    // corrupt / rotated-but-not-rewrapped DEK; the route must degrade gracefully
    // (mirroring the buildAssignProfileBlock catch) rather than surfacing a 500.
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID, dekThrows: true });
    app = await buildHarness({
      service,
      fleetControlRegistry: new FleetControlRegistry(),
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/encryption key/);
  });

  it('#14: profile bound to a live session → 200 { status:"unavailable" } BEFORE any node round-trip (avoids the R2 lost-update race)', async () => {
    const { service, recordTrimCalls } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    const registry = new FleetControlRegistry();
    // An echo node IS connected + a blob exists — so absent the guard the trim
    // would proceed and race the live session's save-back. The guard must short-
    // circuit to `unavailable` first, never touching the node or persisting.
    const { sentTrim } = registerEchoNode(registry, 'node-trim-busy', (frame) => ({
      profileId: frame.profileId,
      ok: true,
      newSizeBytes: 1,
      bytesReclaimed: 1,
    }));
    app = await buildHarness({
      service,
      fleetControlRegistry: registry,
      r2: fakeR2({ blobExists: true }),
      activeForProfile: 1,
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/currently in use/);
    // The node was never asked to trim and no size was persisted.
    expect(sentTrim).toHaveLength(0);
    expect(recordTrimCalls).toHaveLength(0);
  });

  it('#14: profile NOT in use (0 active sessions) → the trim proceeds normally (guard does not block)', async () => {
    const { service, recordTrimCalls } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    const registry = new FleetControlRegistry();
    registerEchoNode(registry, 'node-trim-free', (frame) => ({
      profileId: frame.profileId,
      ok: true,
      newSizeBytes: 4_000,
      bytesReclaimed: 6_000,
    }));
    app = await buildHarness({
      service,
      fleetControlRegistry: registry,
      r2: fakeR2({ blobExists: true }),
      activeForProfile: 0,
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'ok', size_bytes: 4_000 });
    expect(recordTrimCalls).toHaveLength(1);
  });

  it('control plane / R2 not wired → 200 { status:"unavailable" }', async () => {
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    app = await buildHarness({ service }); // no registry, no r2
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/not enabled/);
  });

  it('profile has no DEK (feature inert) → 200 { status:"unavailable" }', async () => {
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID, dek: null });
    app = await buildHarness({
      service,
      fleetControlRegistry: new FleetControlRegistry(),
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/no encrypted store/);
  });

  it('no sealed blob yet (fresh profile, nothing to trim) → 200 { status:"unavailable" }', async () => {
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    app = await buildHarness({
      service,
      fleetControlRegistry: new FleetControlRegistry(),
      r2: fakeR2({ blobExists: false }), // headObject → no GET URL minted
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/no saved state to trim/);
  });

  it('wired + blob exists but NO node connected → 200 { status:"unavailable" }', async () => {
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    app = await buildHarness({
      service,
      fleetControlRegistry: new FleetControlRegistry(), // empty
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({ status: 'unavailable' });
    expect(res.json<TrimBody>().reason).toMatch(/no fleet node is connected/);
  });

  it('connected node confirms the trim → 200 { status:"ok", size_bytes, bytes_reclaimed } + persists the new size', async () => {
    const { service, recordTrimCalls } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    const registry = new FleetControlRegistry();
    const { sentTrim } = registerEchoNode(registry, 'node-trim-1', (frame) => ({
      profileId: frame.profileId,
      ok: true,
      newSizeBytes: 4_000,
      bytesReclaimed: 6_000,
    }));
    app = await buildHarness({
      service,
      fleetControlRegistry: registry,
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<TrimBody>()).toMatchObject({
      status: 'ok',
      size_bytes: 4_000,
      bytes_reclaimed: 6_000,
    });
    // The op carried the JIT crypto envelope (dek + both presigned URLs), keyed by
    // profile_id. The wire payload keys are snake_case (the harness Codable shape).
    expect(sentTrim).toHaveLength(1);
    expect(sentTrim[0]).toMatchObject({
      type: 'trimProfile',
      profile_id: PROFILE_UUID,
      dek: DEK.toString('base64'),
      sealed_blob_put_url: expect.stringContaining('put=1'),
      sealed_blob_url: expect.stringContaining('get=1'),
    });
    // The new (smaller) size was persisted to the OWNER's row.
    expect(recordTrimCalls).toEqual([
      { profileId: PROFILE_UUID, accountId: ACCOUNT_ID, newSizeBytes: 4_000 },
    ]);
  });

  it('admits one expensive trim per owner account and releases the slot after settle', async () => {
    const { service } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    const registry = new FleetControlRegistry();
    const sentTrim: Array<Record<string, unknown>> = [];
    const nodeId = 'node-trim-account-cap';
    const hanging = registry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type === 'trimProfile') sentTrim.push(frame);
      // Keep the first request pending so the account reservation stays held.
    });
    app = await buildHarness({
      service,
      fleetControlRegistry: registry,
      r2: fakeR2({ blobExists: true }),
    });

    const first = trim(app);
    await waitFor(() => sentTrim.length === 1, 'first profile trim relayed');

    const second = await trim(app);
    expect(second.statusCode).toBe(200);
    expect(second.json<TrimBody>()).toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/another profile cache trim is already in progress/i),
    });
    expect(sentTrim).toHaveLength(1); // the second request never reached the worker

    // Settling the first request must run the route's finally and release the
    // account slot, regardless of the node-reported outcome.
    hanging.close('test release');
    await first;

    registerEchoNode(registry, nodeId, (frame) => ({
      profileId: frame.profileId,
      ok: true,
      newSizeBytes: 4_000,
      bytesReclaimed: 6_000,
    }));
    const afterRelease = await trim(app);
    expect(afterRelease.statusCode).toBe(200);
    expect(afterRelease.json<TrimBody>().status).toBe('ok');
  });

  it('connected node reports an error → 200 { status:"error", reason } + does NOT persist', async () => {
    const { service, recordTrimCalls } = fakeService({ ownedProfileUuid: PROFILE_UUID });
    const registry = new FleetControlRegistry();
    registerEchoNode(registry, 'node-trim-err', (frame) => ({
      profileId: frame.profileId,
      error:
        'reseal failed on 10.48.0.12 at https://admin:password@example.com/reseal?token=secret with Bearer abcdefgh',
    }));
    app = await buildHarness({
      service,
      fleetControlRegistry: registry,
      r2: fakeR2({ blobExists: true }),
    });
    const res = await trim(app);
    expect(res.statusCode).toBe(200);
    const body = res.json<TrimBody>();
    expect(body).toMatchObject({ status: 'error' });
    expect(body.reason).toContain('reseal failed');
    expect(body.reason).not.toContain('10.48.0.12');
    expect(body.reason).not.toContain('password');
    expect(body.reason).not.toContain('secret');
    expect(body.reason).not.toContain('abcdefgh');
    expect(recordTrimCalls).toEqual([]); // the row is untouched on failure
  });

  it('connected node never replies → 200 { status:"timeout" } + does NOT persist', async () => {
    vi.useFakeTimers();
    try {
      const { service, recordTrimCalls } = fakeService({ ownedProfileUuid: PROFILE_UUID });
      const registry = new FleetControlRegistry();
      // A node that ACKs nothing (A3's trim handler not yet present).
      registry.register('node-trim-silent', () => {});
      app = await buildHarness({
        service,
        fleetControlRegistry: registry,
        r2: fakeR2({ blobExists: true }),
      });
      const resP = trim(app);
      // Advance past the trim timeout so the correlator resolves `timeout`.
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await resP;
      expect(res.statusCode).toBe(200);
      expect(res.json<TrimBody>()).toMatchObject({ status: 'timeout' });
      expect(recordTrimCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
