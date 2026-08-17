// The only signal that a fleet node was pointed at a hosted SFU.
//
// A node registered against `*.livekit.cloud` relays media box → remote DC →
// client: two WAN hops instead of the co-located box-local SFU. The route's own
// comment names the cost — "the exact 'middleman' latency the founder hit for 18
// days before it was caught" — and explains the design: Cloud stays a VALID
// fallback, kept as rollback, so a misprovisioned node WARNS loudly rather than
// being rejected.
//
// That makes the warning the entire control. There is no 4xx, no audit field, no
// metric — if it stops firing, a node provisioned against Cloud registers
// silently and customer media takes the slow path through a third party until
// somebody notices the latency. Which is precisely the 18-day failure the guard
// was added to prevent from recurring.
//
// It was completely unpinned: `livekit.cloud` appears exactly once in the whole
// repository, in that source comment. Nothing asserted the warn fires, and
// nothing asserted a self-hosted node stays quiet — a guard that cried wolf on
// every registration would be discarded just as fast as one that never fires.
//
// Uses its own harness because the sibling LK.2 tests build Fastify with
// `logger: false`, and the log line IS the assertion here.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeRepo(): { repo: DrizzleFleetNodesRepo; nodeId: string } {
  const nodeId = randomUUID();
  const repo = {
    setLivekitCredentials: (args: {
      nodeId: string;
      apiKey: string;
      apiSecretCiphertextBase64: string;
      wsUrl: string;
      registeredAt: Date;
    }) => {
      if (args.nodeId !== nodeId) return Promise.resolve(null);
      return Promise.resolve({
        id: args.nodeId,
        publicKeyBase64Url: 'pk_test',
        displayName: 'Mac mini test',
        region: 'eu-central',
        hardwareClass: 'mac_mini_m4',
        registeredAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: null,
        revokedAt: null,
        revocationReason: null,
        livekit: {
          apiKey: args.apiKey,
          apiSecretCiphertextBase64: args.apiSecretCiphertextBase64,
          wsUrl: args.wsUrl,
          registeredAt: args.registeredAt,
        },
      });
    },
  } as unknown as DrizzleFleetNodesRepo;
  return { repo, nodeId };
}

interface Warn {
  readonly obj: Record<string, unknown>;
  readonly msg: string;
}

/** Registers the route against a Fastify whose logger records warn calls. */
async function harness(): Promise<{
  app: FastifyInstance;
  nodeId: string;
  warns: Warn[];
}> {
  const warns: Warn[] = [];
  const noop = (): void => {};
  const logger = {
    level: 'warn',
    warn: (obj: unknown, msg?: unknown) => {
      warns.push({
        obj: (typeof obj === 'object' && obj !== null ? obj : {}) as Record<string, unknown>,
        msg: typeof msg === 'string' ? msg : typeof obj === 'string' ? obj : '',
      });
    },
    info: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  // Not annotated as FastifyInstance: `loggerInstance` narrows the instance's
  // logger type, which does not match the default-typed alias. Cast at return.
  const app = Fastify({ loggerInstance: logger as never }) as unknown as FastifyInstance;
  registerErrorHandler(app);
  app.decorate('requireAuth', (request: { account?: unknown }) => {
    request.account = { account: { id: 'acc_test' }, apiKey: { id: 'apk_test' }, teams: [] };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  const { repo, nodeId } = fakeRepo();
  registerMacNodesRoutes(app, {
    repo,
    encryptionKey: ENCRYPTION_KEY,
    now: () => new Date('2026-05-18T12:00:00Z'),
  });
  await app.ready();
  return { app, nodeId, warns };
}

async function register(wsUrl: string): Promise<{ statusCode: number; cloudWarnings: Warn[] }> {
  const { app, nodeId, warns } = await harness();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: 'Bearer ds_live_test', 'content-type': 'application/json' },
      payload: {
        mac_node_id: nodeId,
        livekit: { api_key: 'APItest123', api_secret: 'secrettest456', ws_url: wsUrl },
      },
    });
    return {
      statusCode: res.statusCode,
      cloudWarnings: warns.filter((w) => w.obj.component === 'mac-node-livekit-register'),
    };
  } finally {
    await app.close();
  }
}

describe('hosted LiveKit Cloud SFU registration warning', () => {
  it('CRITICAL a node pointed at LiveKit Cloud registers, but WARNS', async () => {
    const { statusCode, cloudWarnings } = await register('wss://myproject.livekit.cloud');
    // Accepted on purpose — Cloud is a valid rollback target, so rejecting here
    // would remove the fallback the design deliberately keeps.
    expect(statusCode, 'the guard rejected a valid rollback configuration').toBe(200);
    expect(
      cloudWarnings,
      'a node was provisioned against a hosted SFU with NO signal. There is no 4xx, no audit field ' +
        'and no metric for this — the warning is the whole control, and without it customer media ' +
        'silently takes two WAN hops through a third party',
    ).toHaveLength(1);
    expect(cloudWarnings[0]?.obj.wsHost).toBe('myproject.livekit.cloud');
  });

  it('CRITICAL an operator-typed upper-case URL is still caught', async () => {
    // Pins the OUTCOME, not the mechanism — mutation corrected the first draft.
    // Dropping the regex's /i flag reds nothing, because WHATWG `new URL(...)
    // .hostname` has already lower-cased the host by the time the pattern sees
    // it. The /i is belt-and-braces; the normalisation is what does the work.
    // Worth an arm anyway: this URL shape is what an operator actually types,
    // and a future rewrite that matches on the raw string instead of the parsed
    // hostname would lose the normalisation and this catches that.
    const { cloudWarnings } = await register('WSS://MyProject.LiveKit.Cloud');
    expect(cloudWarnings, 'an upper-case hosted SFU host slipped past the guard').toHaveLength(1);
  });

  it('CRITICAL a self-hosted box-local SFU does NOT warn', async () => {
    const { statusCode, cloudWarnings } = await register('wss://mac-001.driftstack.dev:8443');
    expect(statusCode).toBe(200);
    expect(
      cloudWarnings,
      'the fast path warned as if it were the slow one. A guard that fires on every registration ' +
        'gets tuned out, and then it is not a guard',
    ).toHaveLength(0);
  });

  it('CRITICAL a lookalike host is not mistaken for the hosted SFU', async () => {
    // The pattern anchors on a literal dot and the end of the hostname, so
    // neither a suffix-glued name nor a deeper domain should trip it.
    for (const host of ['wss://notlivekit.cloud', 'wss://livekit.cloud.internal.test']) {
      const { cloudWarnings } = await register(host);
      expect(cloudWarnings, `${host} was misread as a hosted LiveKit Cloud SFU`).toHaveLength(0);
    }
  });
});
