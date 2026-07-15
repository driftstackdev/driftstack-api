// Step A — dispatchSessionAssignOnCreate: session-create dispatches a
// sessionAssign to the connected fleet node (local fleet-demo). Pins: no-op
// when the fleet-CP wiring is absent (prod); dispatch-on-create only if the
// node is connected (A3 W298 at-most-once, no queue); the assign carries a
// PUBLISHER token (canPublish:true) — distinct from the customer's subscriber
// token; best-effort (a decrypt/mint failure never throws).

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSessionAssignOnCreate,
  dispatchSessionEndOnClose,
  dispatchResumeSession,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { ProfilesService } from '../../src/services/profiles.js';
import type { R2 } from '../../src/lib/r2.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import { UnsafeProxyHostError } from '../../src/services/account-proxies.js';
import { InMemoryExitIdentityCache } from '../../src/services/exit-identity-cache.js';
import type { ProbeExitIdentity } from '../../src/services/proxy-connectivity-probe.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-dev-001';
const NODE_UUID = '11111111-1111-4111-8111-111111111111';

const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'default',
  initialUrl: 'https://example.com',
  proxy: { host: '127.0.0.1', port: 1080, udp_associate: true, require_remote_dns: false },
};

function macWithLivekit(overrides: { id?: string; nodeId?: string } = {}) {
  const id = overrides.id ?? NODE_UUID;
  const nodeId = overrides.nodeId ?? NODE_ID;
  const apiKey = 'devkey';
  const wsUrl = 'ws://localhost:7880';
  return {
    id,
    nodeId,
    publicKeyBase64Url: 'pk',
    registeredAt: new Date(),
    revokedAt: null,
    livekit: {
      apiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret('secret', KEY, {
        nodeId: id,
        apiKey,
        wsUrl,
      }),
      wsUrl,
      registeredAt: new Date(),
    },
  };
}

function repoReturning(mac: unknown, spy?: () => void): DrizzleFleetNodesRepo {
  return {
    findAnyWithLivekit: () => {
      spy?.();
      return Promise.resolve(mac);
    },
    // Region-aware dispatch calls findNearestWithLivekit; the stub returns the
    // same node regardless of region (the prefer-region+fallback SQL is covered
    // separately). Same spy so the "no-op when unwired" assertions still hold.
    findNearestWithLivekit: () => {
      spy?.();
      return Promise.resolve(mac);
    },
  } as unknown as DrizzleFleetNodesRepo;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('dispatchSessionAssignOnCreate', () => {
  it('dispatches a sessionAssign to the connected node with a PUBLISHER token', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_demo1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: log,
    });

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame).toMatchObject({
      type: 'sessionAssign',
      sessionId: 'agt_demo1',
      archetype: 'iphone16pro_ios18_6_safari18_6',
      behaviorProfile: 'default',
      initialUrl: 'https://example.com',
    });
    // inlineProxyConfig rides as the base64 wire string
    expect(typeof frame.inlineProxyConfig).toBe('string');
    const lk = frame.livekit as Record<string, unknown>;
    expect(lk).toMatchObject({ room: 'agt_demo1', ws_url: 'ws://localhost:7880' });
    // The harness token MUST be a publisher token (canPublish:true) — the
    // distinguishing detail vs the customer's subscriber token.
    const payload = JSON.parse(
      Buffer.from((lk.token as string).split('.')[1]!, 'base64url').toString('utf8'),
    ) as { video: { canPublish: boolean; room: string } };
    expect(payload.video.canPublish).toBe(true);
    expect(payload.video.room).toBe('agt_demo1');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('customer initial_url OVERRIDES the operator-default (sessionDispatch.initialUrl) on the dispatched assign', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_override',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      initialUrl: 'https://news.example.com/world',
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    // The customer's start URL wins over DISPATCH.initialUrl.
    expect(frame.initialUrl).toBe('https://news.example.com/world');
  });

  it('absent initial_url FALLS BACK to the operator-default (sessionDispatch.initialUrl)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_fallback',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      // no initialUrl → the `?? sessionDispatch.initialUrl` fallback applies
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.initialUrl).toBe(DISPATCH.initialUrl);
  });

  it('geolocation override rides the dispatched assign when passed (A3 contract 2026-07-01)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_geo',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 },
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.geolocation).toEqual({ latitude: 48.8566, longitude: 2.3522, accuracy: 20 });
  });

  it('absent geolocation → omitted from the assign (harness keeps its proxy-exit auto-derive)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_nogeo',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.geolocation).toBeUndefined();
  });

  it('idleTimeoutSeconds (manual-session knob, A3 W2813) rides the assign when passed', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_idle',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      idleTimeoutSeconds: 1800,
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.idleTimeoutSeconds).toBe(1800);
  });

  it('absent idleTimeoutSeconds → omitted from the assign (ai/pair keep the box default)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_noidle',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
    });
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.idleTimeoutSeconds).toBeUndefined();
  });

  it('fails closed when a requested proxy_id is unresolvable — NO operator-default fallback (no sessionAssign sent)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_failclosed',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      accountId: 'acc_x',
      proxyId: 'prx_unresolvable',
      accountProxiesService: {
        resolveForDispatch: () => Promise.resolve(null),
      } as unknown as AccountProxiesService,
    });
    // The customer's requested proxy couldn't resolve → we MUST NOT fall back to the
    // operator-default egress (egress-identity leak). Session created but NOT dispatched.
    expect(sent).toHaveLength(0);
  });

  it('#16: an unresolvable proxy CLOSES the never-dispatched session (egress_unresolved) so it stops counting against the active-session cap', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const closed: Array<{ id: string; reason: string }> = [];
    const agentSessions = {
      closeWithReason: (id: string, reason: string) => {
        closed.push({ id, reason });
        return Promise.resolve({});
      },
      // setNodeId is never reached on the fail-closed path (we return before it).
      setNodeId: () => Promise.resolve({}),
    } as unknown as InstanceType<typeof InMemoryAgentSessionsRepo>;

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_failclosed_close',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      accountId: 'acc_x',
      proxyId: 'prx_unresolvable',
      accountProxiesService: {
        resolveForDispatch: () => Promise.resolve(null),
      } as unknown as AccountProxiesService,
      agentSessions,
    });

    // Never dispatched …
    expect(sent).toHaveLength(0);
    // … and the phantom 'active' row is closed with the terminal reason.
    expect(closed).toEqual([{ id: 'agt_failclosed_close', reason: 'egress_unresolved' }]);
  });

  it('#16: an SSRF-rejected proxy host (UnsafeProxyHostError) ALSO closes the session (egress_unresolved)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const closed: Array<{ id: string; reason: string }> = [];
    const agentSessions = {
      closeWithReason: (id: string, reason: string) => {
        closed.push({ id, reason });
        return Promise.resolve({});
      },
      setNodeId: () => Promise.resolve({}),
    } as unknown as InstanceType<typeof InMemoryAgentSessionsRepo>;

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_ssrf_close',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
      accountId: 'acc_x',
      proxyId: 'prx_internal_host',
      accountProxiesService: {
        resolveForDispatch: () => Promise.reject(new UnsafeProxyHostError('loopback')),
      } as unknown as AccountProxiesService,
      agentSessions,
    });

    expect(sent).toHaveLength(0);
    expect(closed).toEqual([{ id: 'agt_ssrf_close', reason: 'egress_unresolved' }]);
  });

  it('region-aware: an EU viewer routes to the EU node (region threaded to findNearestWithLivekit), not the US node', async () => {
    const sentEu: string[] = [];
    const sentUs: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register('mac-eu-paris-001', (d) => sentEu.push(d));
    registry.register('mac-us-vegas-001', (d) => sentUs.push(d));
    const usNode = macWithLivekit({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      nodeId: 'mac-us-vegas-001',
    });
    const euNode = macWithLivekit({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      nodeId: 'mac-eu-paris-001',
    });
    let regionSeen: string | null | undefined = 'UNSET';
    const regionalRepo = {
      findAnyWithLivekit: () => Promise.resolve(usNode),
      // Mirrors the real repo contract: prefer the home-region node, else any.
      findNearestWithLivekit: (region: string | null | undefined) => {
        regionSeen = region;
        return Promise.resolve(region === 'eu' ? euNode : usNode);
      },
    } as unknown as DrizzleFleetNodesRepo;

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_eu1',
      fleetControlRegistry: registry,
      fleetNodesRepo: regionalRepo,
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountRegion: 'eu',
      logger: logger(),
    });

    // The viewer's region was threaded to the selector…
    expect(regionSeen).toBe('eu');
    // …and the assign went to the EU node, NOT the US node.
    expect(sentEu).toHaveLength(1);
    expect(sentUs).toHaveLength(0);
  });

  it('region-aware: falls back to any node when the home region has none (repo returns the fallback) — session still dispatches', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register('mac-us-vegas-001', (d) => sent.push(d));
    const usNode = macWithLivekit({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      nodeId: 'mac-us-vegas-001',
    });
    const regionalRepo = {
      findAnyWithLivekit: () => Promise.resolve(usNode),
      // apac viewer, no apac node → the repo's fallback returns the US node.
      findNearestWithLivekit: (region: string | null | undefined) =>
        Promise.resolve(region === 'apac' ? usNode : usNode),
    } as unknown as DrizzleFleetNodesRepo;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_apac1',
      fleetControlRegistry: registry,
      fleetNodesRepo: regionalRepo,
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountRegion: 'apac',
      logger: logger(),
    });
    // A far box still beats no box — the session dispatched to the US node.
    expect(sent).toHaveLength(1);
  });

  it('persists the dispatched-to node_id on the agent session (migration 0086) — the same registry key it resolved the connection by', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register('mac-macstadium-us-001', (d) => sent.push(d));
    const agentSessions = new InMemoryAgentSessionsRepo();
    const created = await agentSessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const mac = macWithLivekit({
      id: '3c80787f-95d6-40cf-895d-123456789abc',
      nodeId: 'mac-macstadium-us-001',
    });
    await dispatchSessionAssignOnCreate({
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(mac),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      agentSessions,
      logger: logger(),
    });
    expect(sent).toHaveLength(1);
    // node_id == the registry key (the human node_id), NOT the fleet_nodes uuid.
    const after = await agentSessions.get(created.id);
    expect(after!.nodeId).toBe('mac-macstadium-us-001');
  });

  it('does NOT persist node_id when the node is not connected (no dispatch → no slot held)', async () => {
    const registry = new FleetControlRegistry(); // node never registered
    const agentSessions = new InMemoryAgentSessionsRepo();
    const created = await agentSessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    await dispatchSessionAssignOnCreate({
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      agentSessions,
      logger: logger(),
    });
    const after = await agentSessions.get(created.id);
    expect(after!.nodeId).toBeNull();
  });

  it('a setNodeId failure SKIPS the assign (no owned-but-NULL window) — resolves + logs, never throws', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    const throwingSessions = {
      setNodeId: () => Promise.reject(new Error('db down')),
    } as unknown as InMemoryAgentSessionsRepo;
    await expect(
      dispatchSessionAssignOnCreate({
        sessionId: 'agt_persist_fail',
        fleetControlRegistry: registry,
        fleetNodesRepo: repoReturning(macWithLivekit()),
        livekitSecretEncryptionKey: KEY,
        sessionDispatch: DISPATCH,
        agentSessions: throwingSessions,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    // review w7eu5sw7n: node_id is persisted BEFORE the assign. If the persist
    // fails we must NOT send the assign — doing so would leave the session
    // status='active' with node_id=NULL while a node owns it, and the
    // terminal-close cross-node guard ALLOWS a close on a NULL owner (so another
    // node could close it) + the disconnect reaper can't attribute it. So the
    // dispatch is SKIPPED (no assign), the failure is logged, never thrown; the
    // session stays unowned for the 12h orphan_reap backstop.
    expect(sent).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('a setNodeId null return (row missing or terminal mid-dispatch) SKIPS the assign', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    const deletedSessions = {
      // setNodeId returns null when the row is missing or a close won; there is
      // no active session to dispatch.
      setNodeId: () => Promise.resolve(null),
    } as unknown as InMemoryAgentSessionsRepo;
    await expect(
      dispatchSessionAssignOnCreate({
        sessionId: 'agt_deleted_mid_dispatch',
        fleetControlRegistry: registry,
        fleetNodesRepo: repoReturning(macWithLivekit()),
        livekitSecretEncryptionKey: KEY,
        sessionDispatch: DISPATCH,
        agentSessions: deletedSessions,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('a real closed row that wins during dispatch preparation receives no node owner and no sessionAssign', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    const agentSessions = new InMemoryAgentSessionsRepo();
    const created = await agentSessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const closed = await agentSessions.closeWithReason(created.id, 'customer-closed');

    await expect(
      dispatchSessionAssignOnCreate({
        sessionId: created.id,
        fleetControlRegistry: registry,
        fleetNodesRepo: repoReturning(macWithLivekit()),
        livekitSecretEncryptionKey: KEY,
        sessionDispatch: DISPATCH,
        agentSessions,
        logger: log,
      }),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
    expect(await agentSessions.get(created.id)).toEqual(closed);
    expect(await agentSessions.get(created.id)).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
      nodeId: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: created.id }),
      'session row absent or terminal at node_id ownership claim; skipping assign',
    );
  });

  it('resolves the live connection by node_id (the registry key), NOT the fleet_nodes uuid (migration 0085 / Path C)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    // Prod reality: the WS registry is keyed by the authed node_id (the JWT iss),
    // and the fleet_nodes uuid PK is a DIFFERENT value. The old code looked up by
    // mac.id (the uuid) → would MISS this connection → session created blank.
    registry.register('mac-macstadium-us-001', (d) => sent.push(d));
    const mac = macWithLivekit({
      id: '3c80787f-95d6-40cf-895d-123456789abc',
      nodeId: 'mac-macstadium-us-001',
    });
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_byid',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(mac),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
    });
    // Dispatched → found via node_id. (Would be 0 if it keyed by mac.id.)
    expect(sent).toHaveLength(1);
  });

  it('attaches the profile block (profile_id + base64 DEK) for a profile-backed dispatch (file 57)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const dek = Buffer.alloc(32, 1);
    const profilesService = {
      get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
      getProfileDek: () => Promise.resolve(dek),
    } as unknown as ProfilesService;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_p1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      profileId: 'prof_1',
      profilesService,
      logger: logger(),
    });
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.profile).toMatchObject({ profile_id: 'prof_1', dek: dek.toString('base64') });
  });

  it('with R2 wired, the profile block carries restore (GET) + save-back (PUT) URLs (buildAssignProfileBlock)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const dek = Buffer.alloc(32, 1);
    const profilesService = {
      get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
      getProfileDek: () => Promise.resolve(dek),
    } as unknown as ProfilesService;
    const r2 = {
      bucket: 'b',
      putObject: vi.fn(),
      headObject: vi.fn().mockResolvedValue({ exists: true }), // existing profile → restore GET
      presignGet: vi.fn().mockResolvedValue('https://r2/get'),
      presignPut: vi.fn().mockResolvedValue('https://r2/put'),
    } as unknown as R2;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_p3',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      profileId: 'prof_1',
      profilesService,
      r2,
      logger: logger(),
    });
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.profile).toMatchObject({
      profile_id: 'prof_1',
      dek: dek.toString('base64'),
      sealed_blob_url: 'https://r2/get',
      sealed_blob_put_url: 'https://r2/put',
    });
  });

  it('R2 url-mint failure degrades to a DEK-only dispatch (session still runs) — does NOT abort the dispatch', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const dek = Buffer.alloc(32, 1);
    const profilesService = {
      get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
      getProfileDek: () => Promise.resolve(dek),
    } as unknown as ProfilesService;
    const r2 = {
      bucket: 'b',
      putObject: vi.fn(),
      headObject: vi.fn().mockRejectedValue(new Error('r2 down')),
      presignGet: vi.fn().mockResolvedValue('https://r2/get'),
      presignPut: vi.fn().mockRejectedValue(new Error('r2 down')),
    } as unknown as R2;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_p4',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      profileId: 'prof_1',
      profilesService,
      r2,
      logger: logger(),
    });
    // The dispatch STILL fired (session runs), with a DEK-only profile — no
    // sealed URLs (toEqual, not toMatchObject, asserts the degradation).
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.profile).toEqual({ profile_id: 'prof_1', dek: dek.toString('base64') });
  });

  it('omits the profile block when getProfileDek returns null (no DEK) — stateless assign', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const profilesService = {
      get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
      getProfileDek: () => Promise.resolve(null),
    } as unknown as ProfilesService;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_p2',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      profileId: 'prof_1',
      profilesService,
      logger: logger(),
    });
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.profile).toBeUndefined();
  });

  it('serializes the bound PROFILE archetype (not the static sessionDispatch config) — fingerprint correctness (2026-06-19)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    // The profile carries its OWN archetype, distinct from the operator-config
    // static default — the harness uses the assign's archetype verbatim, so the
    // assign MUST carry the profile's archetype or the box provisions the wrong fp.
    const profilesService = {
      get: () => Promise.resolve({ archetype: 'iphone17_ios18_7_safari26_4' }),
      getProfileDek: () => Promise.resolve(null),
    } as unknown as ProfilesService;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_arch1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH, // static archetype: iphone16pro_ios18_6_safari18_6
      accountId: 'acc_1',
      profileId: 'prof_1',
      profilesService,
      logger: log,
    });
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.archetype).toBe('iphone17_ios18_7_safari26_4');
    expect(frame.archetype).not.toBe(DISPATCH.archetype);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to the static archetype for a no-profile (stateless) dispatch', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_arch2',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      // no accountId/profileId/profilesService → stateless
      logger: logger(),
    });
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.archetype).toBe(DISPATCH.archetype);
  });

  it('best-effort: a profile-fetch failure falls back to the static archetype (does NOT abort the dispatch)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    const dek = Buffer.alloc(32, 1);
    // get() throws (e.g. transient DB error) — the dispatch must STILL fire with
    // the static archetype rather than leaving the session created-but-undispatched.
    const profilesService = {
      get: () => Promise.reject(new Error('db down')),
      getProfileDek: () => Promise.resolve(dek),
    } as unknown as ProfilesService;
    await expect(
      dispatchSessionAssignOnCreate({
        sessionId: 'agt_arch3',
        fleetControlRegistry: registry,
        fleetNodesRepo: repoReturning(macWithLivekit()),
        livekitSecretEncryptionKey: KEY,
        sessionDispatch: DISPATCH,
        accountId: 'acc_1',
        profileId: 'prof_1',
        profilesService,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    // Dispatch still went out, on the static archetype, with the DEK attached.
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.archetype).toBe(DISPATCH.archetype);
    expect(frame.profile).toMatchObject({ profile_id: 'prof_1' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('does NOT dispatch when the node is not connected (no queue) — logs + skips', async () => {
    const registry = new FleetControlRegistry(); // node never registered
    const log = logger();
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_demo2',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: log,
    });
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('founder bug: node not connected at create CLOSES the never-dispatched row (dispatch_no_live_node) so the GUI is not stuck + the cap is freed', async () => {
    const registry = new FleetControlRegistry(); // node never registered (WSS flapping)
    const closed: Array<{ id: string; reason: string }> = [];
    const agentSessions = {
      closeWithReason: (id: string, reason: string) => {
        closed.push({ id, reason });
        return Promise.resolve({});
      },
      // setNodeId is never reached on this path (we return before persisting).
      setNodeId: () => Promise.resolve({}),
    } as unknown as InstanceType<typeof InMemoryAgentSessionsRepo>;
    const sent: string[] = [];
    registry.register('some-other-node', (d) => sent.push(d)); // a DIFFERENT node is up
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_no_live_node',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()), // resolves NODE_ID, which is NOT registered
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      agentSessions,
      logger: logger(),
    });
    // No publisher was dispatched …
    expect(sent).toHaveLength(0);
    // … and the phantom 'active' row is closed honestly so the GUI sees status='closed'
    // (not a permanent "No frame yet") and it stops counting against the active cap.
    expect(closed).toEqual([{ id: 'agt_no_live_node', reason: 'dispatch_no_live_node' }]);
  });

  it('multi-box region: skips the OFFLINE region-nearest box + dispatches to the ONLINE sibling (connectivity-aware listWithLivekitNearest)', async () => {
    const sentOffline: string[] = [];
    const sentOnline: string[] = [];
    const registry = new FleetControlRegistry();
    // Only the SIBLING box is connected; the region-nearest (first) box is offline.
    registry.register('mac-eu-online-002', (d) => sentOnline.push(d));
    const offlineTop = macWithLivekit({
      id: '44444444-4444-4444-8444-444444444444',
      nodeId: 'mac-eu-offline-001',
    });
    const onlineSibling = macWithLivekit({
      id: '55555555-5555-4555-8555-555555555555',
      nodeId: 'mac-eu-online-002',
    });
    let regionSeen: string | null | undefined = 'UNSET';
    const agentSessions = new InMemoryAgentSessionsRepo();
    const created = await agentSessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const candidateRepo = {
      findAnyWithLivekit: () => Promise.resolve(offlineTop),
      findNearestWithLivekit: () => Promise.resolve(offlineTop),
      // Region-nearest CANDIDATE LIST: offline box first, online sibling second.
      listWithLivekitNearest: (region: string | null | undefined) => {
        regionSeen = region;
        return Promise.resolve([offlineTop, onlineSibling]);
      },
    } as unknown as DrizzleFleetNodesRepo;
    await dispatchSessionAssignOnCreate({
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: candidateRepo,
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountRegion: 'eu',
      agentSessions,
      logger: logger(),
    });
    expect(regionSeen).toBe('eu');
    // The publisher went to the ONLINE sibling, NOT the offline region-nearest box.
    expect(sentOffline).toHaveLength(0);
    expect(sentOnline).toHaveLength(1);
    // … and node_id was persisted to that SAME live box (so the viewer token, minted
    // off node_id at the route, binds to the box the publisher actually landed on).
    const after = await agentSessions.get(created.id);
    expect(after!.nodeId).toBe('mac-eu-online-002');
  });

  it('multi-box region: ALL candidate boxes offline → closes the row (dispatch_no_live_node), no dispatch', async () => {
    const registry = new FleetControlRegistry(); // none connected
    const closed: Array<{ id: string; reason: string }> = [];
    const agentSessions = {
      closeWithReason: (id: string, reason: string) => {
        closed.push({ id, reason });
        return Promise.resolve({});
      },
      setNodeId: () => Promise.resolve({}),
    } as unknown as InstanceType<typeof InMemoryAgentSessionsRepo>;
    const a = macWithLivekit({
      id: '66666666-6666-4666-8666-666666666666',
      nodeId: 'mac-a-001',
    });
    const b = macWithLivekit({
      id: '77777777-7777-4777-8777-777777777777',
      nodeId: 'mac-b-002',
    });
    const candidateRepo = {
      findAnyWithLivekit: () => Promise.resolve(a),
      findNearestWithLivekit: () => Promise.resolve(a),
      listWithLivekitNearest: () => Promise.resolve([a, b]),
    } as unknown as DrizzleFleetNodesRepo;
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_all_offline',
      fleetControlRegistry: registry,
      fleetNodesRepo: candidateRepo,
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountRegion: 'eu',
      agentSessions,
      logger: logger(),
    });
    expect(closed).toEqual([{ id: 'agt_all_offline', reason: 'dispatch_no_live_node' }]);
  });

  it('is a no-op (does not even touch the fleet repo) when the registry is unwired (prod)', async () => {
    const spy = vi.fn();
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_demo3',
      fleetControlRegistry: undefined,
      fleetNodesRepo: repoReturning(macWithLivekit(), spy),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no-ops when no fleet node has livekit creds', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_demo4',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(null),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      logger: logger(),
    });
    expect(sent).toHaveLength(0);
  });

  it('best-effort: a decrypt failure is caught + logged, never thrown', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    const badMac = macWithLivekit();
    badMac.livekit.apiSecretCiphertextBase64 = 'not-valid-ciphertext';
    await expect(
      dispatchSessionAssignOnCreate({
        sessionId: 'agt_demo5',
        fleetControlRegistry: registry,
        fleetNodesRepo: repoReturning(badMac),
        livekitSecretEncryptionKey: KEY,
        sessionDispatch: DISPATCH,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  // #128 — the dispatch is the READ side of the exit-identity bridge: when the gate
  // stashed an exit identity for (accountId, proxyId), the assign carries an
  // exit_identity block so the box can render the new-tab IP panel. quic_ok is
  // derived from the RESOLVED egress, not the cached identity.
  const EXIT: ProbeExitIdentity = {
    ip: '203.0.113.7',
    country: 'US',
    region: 'California',
    city: 'San Jose',
    timezone: 'America/Los_Angeles',
  };
  function proxySvc(resolved: unknown): AccountProxiesService {
    return {
      resolveForDispatch: () => Promise.resolve(resolved),
    } as unknown as AccountProxiesService;
  }

  it('emits exit_identity from the cache; quic_ok=true when the resolved socks5 is UDP-verified', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const cache = new InMemoryExitIdentityCache();
    cache.set('acc_1', 'prx_1', EXIT);

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_exit1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      proxyId: 'prx_1',
      accountProxiesService: proxySvc({
        host: '203.0.113.7',
        port: 1080,
        udp_associate: true,
        require_remote_dns: true,
        udp_capable: true, // #46 pre-detection confirmed UDP through this proxy
      }),
      exitIdentityCache: cache,
      logger: logger(),
    });

    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.exit_identity).toMatchObject({
      ip: '203.0.113.7',
      country: 'US',
      region: 'California',
      city: 'San Jose',
      timezone: 'America/Los_Angeles',
      quic_ok: true,
    });
    // probed_at is a valid ISO string the panel can show.
    expect(Number.isNaN(Date.parse((frame.exit_identity as { probed_at: string }).probed_at))).toBe(
      false,
    );
  });

  it('quic_ok=false when the resolved socks5 proxy was NOT UDP-verified (udp_associate is a wish, not proof)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const cache = new InMemoryExitIdentityCache();
    cache.set('acc_1', 'prx_1', EXIT);

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_exit2',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      proxyId: 'prx_1',
      // udp_associate:true requested, but no udp_capable → not verified → no QUIC.
      accountProxiesService: proxySvc({
        host: '203.0.113.7',
        port: 1080,
        udp_associate: true,
        require_remote_dns: true,
      }),
      exitIdentityCache: cache,
      logger: logger(),
    });

    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect((frame.exit_identity as Record<string, unknown>).quic_ok).toBe(false);
  });

  it('quic_ok=true for a resolved VPN wire (full IP tunnel carries UDP/QUIC)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const cache = new InMemoryExitIdentityCache();
    cache.set('acc_1', 'prx_vpn', EXIT);

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_exit3',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      proxyId: 'prx_vpn',
      accountProxiesService: proxySvc({
        type: 'wireguard',
        private_key: 'k',
        peer_public_key: 'p',
        endpoint: '198.51.100.1:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.0.0.2/32',
      }),
      exitIdentityCache: cache,
      logger: logger(),
    });

    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect((frame.exit_identity as Record<string, unknown>).quic_ok).toBe(true);
  });

  it('omits exit_identity on a cache MISS (probe saw none / cold after restart) — box keeps default behaviour', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const cache = new InMemoryExitIdentityCache(); // empty

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_exit4',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      proxyId: 'prx_1',
      accountProxiesService: proxySvc({
        host: '203.0.113.7',
        port: 1080,
        udp_associate: true,
        require_remote_dns: true,
      }),
      exitIdentityCache: cache,
      logger: logger(),
    });

    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.exit_identity).toBeUndefined();
  });

  it('omits exit_identity for an operator-default egress (no proxyId → nothing keyed → block absent)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const cache = new InMemoryExitIdentityCache();
    // Even a stale cache entry can't leak in: with no proxyId the dispatch never
    // reads the cache (the key requires both accountId AND proxyId).
    cache.set('acc_1', 'prx_1', EXIT);

    await dispatchSessionAssignOnCreate({
      sessionId: 'agt_exit5',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: 'acc_1',
      exitIdentityCache: cache,
      logger: logger(),
    });

    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame.exit_identity).toBeUndefined();
  });
});

describe('dispatchResumeSession (W393)', () => {
  it('sends a resumeSession (with challengeId) to the connected node', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    await dispatchResumeSession({
      sessionId: 'agt_r1',
      challengeId: 'chl_1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      logger: log,
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'resumeSession',
      sessionId: 'agt_r1',
      challengeId: 'chl_1',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('omits challengeId for a manual resume', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchResumeSession({
      sessionId: 'agt_r2',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      logger: logger(),
    });
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'resumeSession', sessionId: 'agt_r2' });
  });

  it('no-op when the fleet control plane is not wired (registry/repo undefined)', async () => {
    const log = logger();
    await expect(
      dispatchResumeSession({
        sessionId: 'agt_r3',
        fleetControlRegistry: undefined,
        fleetNodesRepo: undefined,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('dispatchSessionEndOnClose', () => {
  it('sends a sessionEnd to the connected node (frees the harness slot)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    const log = logger();
    await dispatchSessionEndOnClose({
      sessionId: 'agt_close1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      logger: log,
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'sessionEnd', sessionId: 'agt_close1' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('five close contenders dispatch exactly one sessionEnd from the authoritative winner', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (data) => sent.push(data));
    const agentSessions = new InMemoryAgentSessionsRepo();
    const created = await agentSessions.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100_000,
    });
    await agentSessions.setNodeId(created.id, NODE_ID);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        agentSessions.closeWithReasonOutcome(created.id, `contender-${index}`),
      ),
    );
    await Promise.all(
      outcomes.map((outcome) =>
        outcome.kind === 'closed'
          ? dispatchSessionEndOnClose({
              sessionId: outcome.session.id,
              nodeId: outcome.session.nodeId,
              fleetControlRegistry: registry,
              fleetNodesRepo: repoReturning(macWithLivekit()),
              logger: logger(),
            })
          : Promise.resolve(),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'closed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'already_closed')).toHaveLength(4);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'sessionEnd', sessionId: created.id });
  });

  it('no-op when the fleet control plane is not wired (prod) — registry/repo undefined', async () => {
    const log = logger();
    await expect(
      dispatchSessionEndOnClose({
        sessionId: 'agt_close2',
        fleetControlRegistry: undefined,
        fleetNodesRepo: undefined,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('node not connected — QUEUES the sessionEnd + re-dispatches it on reconnect (founder bug, A3 W2859)', async () => {
    const registry = new FleetControlRegistry(); // node not connected at close time
    const log = logger();
    await dispatchSessionEndOnClose({
      sessionId: 'agt_close3',
      nodeId: 'offline-node',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      logger: log,
    });
    // The teardown is QUEUED (not lost) so the orphaned browser is torn down on reconnect
    // — the robust fix for the -1011 WSS-flap symptom. Logged at info, not warn.
    expect(registry.pendingTeardownCount('offline-node')).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
    // The node reconnects → register() drains the queue + re-dispatches the sessionEnd.
    const sent: string[] = [];
    registry.register('offline-node', (d) => sent.push(d));
    expect(registry.pendingTeardownCount('offline-node')).toBe(0);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'sessionEnd', sessionId: 'agt_close3' });
  });

  it('best-effort: a repo failure is swallowed (close must not fail)', async () => {
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, () => {});
    const log = logger();
    const throwingRepo = {
      findAnyWithLivekit: () => Promise.reject(new Error('db down')),
    } as unknown as DrizzleFleetNodesRepo;
    await expect(
      dispatchSessionEndOnClose({
        sessionId: 'agt_close4',
        fleetControlRegistry: registry,
        fleetNodesRepo: throwingRepo,
        logger: log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('dispatchSessionEndOnClose / dispatchResumeSession — owning-node targeting (audit #1)', () => {
  it('sessionEnd targets the persisted owning node_id directly — no region-blind findAnyWithLivekit fallback', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register('owner-node-B', (d) => sent.push(d));
    let fallbackCalled = false;
    await dispatchSessionEndOnClose({
      sessionId: 'agt_x',
      nodeId: 'owner-node-B',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit(), () => {
        fallbackCalled = true;
      }),
      logger: logger(),
    });
    expect(fallbackCalled).toBe(false); // owning node targeted directly
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'sessionEnd', sessionId: 'agt_x' });
  });

  it('sessionEnd falls back to findAnyWithLivekit when node_id is null (legacy/never-dispatched row)', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d)); // macWithLivekit().nodeId === NODE_ID
    let fallbackCalled = false;
    await dispatchSessionEndOnClose({
      sessionId: 'agt_y',
      nodeId: null,
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit(), () => {
        fallbackCalled = true;
      }),
      logger: logger(),
    });
    expect(fallbackCalled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'sessionEnd', sessionId: 'agt_y' });
  });

  it('resumeSession targets the persisted owning node_id directly', async () => {
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register('owner-node-B', (d) => sent.push(d));
    let fallbackCalled = false;
    await dispatchResumeSession({
      sessionId: 'agt_z',
      nodeId: 'owner-node-B',
      challengeId: 'ch_1',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit(), () => {
        fallbackCalled = true;
      }),
      logger: logger(),
    });
    expect(fallbackCalled).toBe(false);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'resumeSession', sessionId: 'agt_z' });
  });
});
