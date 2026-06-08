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
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-dev-001';

const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'default',
  initialUrl: 'https://example.com',
  proxy: { host: '127.0.0.1', port: 1080, udp_associate: true, require_remote_dns: false },
};

function macWithLivekit() {
  return {
    id: NODE_ID,
    publicKeyBase64Url: 'pk',
    registeredAt: new Date(),
    revokedAt: null,
    livekit: {
      apiKey: 'devkey',
      apiSecretCiphertextBase64: encryptLivekitSecret('secret', KEY),
      wsUrl: 'ws://localhost:7880',
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

  it('skips when the node is not connected (nothing to tear down server-side)', async () => {
    const registry = new FleetControlRegistry(); // node never registered
    const log = logger();
    await dispatchSessionEndOnClose({
      sessionId: 'agt_close3',
      fleetControlRegistry: registry,
      fleetNodesRepo: repoReturning(macWithLivekit()),
      logger: log,
    });
    expect(log.warn).not.toHaveBeenCalled();
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
