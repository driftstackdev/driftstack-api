// Owner item T-9: "network logs (if its possible and see cant see this
// inspection), just like with devchrome tools, so we can for example also see
// whether requests were made with HTTP/2, HTTP/3."
//
// MECHANISM. The control plane RECEIVES per-request networkRequests frames from
// the fork, RINGS the latest per agent session, and SERVES them at
// GET /v1/agent-sessions/:id/network for the simulator's DevTools-style Network
// pane. This guard pins the three properties that keep that surface honest and
// safe:
//   1. STORE — the per-session ring is BOUNDED (oldest evicted past the ceiling)
//      so one long-lived session cannot grow it unbounded; the read cursor is the
//      server's own monotonic seq.
//   2. RELAY — a frame is appended ONLY for an exact, live, owning node; a
//      foreign node cannot inject rows into another customer's pane. Each frame
//      is re-bounded (per-frame entry cap + per-entry byte cap) before the ring.
//   3. ROUTE — GET returns a discriminated {status, entries, next_after} body,
//      is account-ownership gated, and reports an honest 'unavailable' when the
//      session is not live (so the empty prod state renders as data, not a lie).
//
// This file lives in tests/integration so the route path it drives is visible to
// the every-route-is-driven census.
//
// Mutation-proved (mut-w4b2-server): (a) dropping the relay's owner check makes a
// foreign frame land; (b) dropping the store's ring cap makes it unbounded. Each
// reds exactly one arm below.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import { SessionNetworkLogStore } from '../../src/services/session-network-log-store.js';
import { makeSessionNetworkLogRelay } from '../../src/services/session-network-log-relay.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  NetworkRequestEntry,
  NetworkRequestsFrame,
} from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeEntry(i: number, over: Partial<NetworkRequestEntry> = {}): NetworkRequestEntry {
  return {
    id: `req_${i}`,
    url: `https://example.com/asset/${i}`,
    method: 'GET',
    status: 200,
    protocol: 'h2',
    started_at: 1_700_000_000_000 + i,
    ...over,
  };
}

function makeFrame(sessionId: string, entries: NetworkRequestEntry[]): NetworkRequestsFrame {
  return { type: 'networkRequests', sessionId, entries };
}

// ── 1. STORE — the per-session ring is bounded + cursor-ordered ──────────────
describe('T-9 store: the per-session network-log ring is bounded and cursor-ordered', () => {
  it('appends entries and reports the newest server seq as the poll cursor', () => {
    const store = new SessionNetworkLogStore();
    store.append('agt_1', [makeEntry(0), makeEntry(1), makeEntry(2)]);
    const read = store.get('agt_1');
    expect(read.entries.map((e) => e.id)).toEqual(['req_0', 'req_1', 'req_2']);
  });

  it('returns only rows strictly newer than the supplied cursor', () => {
    const store = new SessionNetworkLogStore();
    store.append('agt_1', [makeEntry(0), makeEntry(1), makeEntry(2)]);
    // The cursor is the SERVER seq (1-based), not the harness entry id: rows 1
    // and 2 are already seen, so only seq 3 (req_2) comes back.
    expect(store.get('agt_1', 2).entries.map((e) => e.id)).toEqual(['req_2']);
  });

  it('exposes the newest seq as next_after (the string a client polls back)', () => {
    const store = new SessionNetworkLogStore();
    store.append('agt_1', [makeEntry(0), makeEntry(1), makeEntry(2)]);
    expect(store.get('agt_1').next_after).toBe('3');
  });

  it('VACUITY CONTROL: below the ceiling the ring keeps every entry (eviction is conditional)', () => {
    // Without this, the eviction assertion below would pass just as happily if
    // the store dropped rows unconditionally rather than only past the cap.
    const store = new SessionNetworkLogStore();
    const entries = Array.from({ length: 100 }, (_, i) => makeEntry(i));
    store.append('agt_1', entries);
    expect(store.get('agt_1').entries).toHaveLength(100);
  });

  it('evicts the OLDEST rows once the ring passes NETWORK_LOG_RING_MAX_ENTRIES (2000)', () => {
    const store = new SessionNetworkLogStore();
    // 2500 rows in one busy session → the ring must hold the newest 2000.
    store.append(
      'agt_1',
      Array.from({ length: 2500 }, (_, i) => makeEntry(i)),
    );
    const read = store.get('agt_1');
    // Non-vacuity: the scan found real entries (2000 of them), not an empty ring.
    expect(read.entries).toHaveLength(2000);
    // The oldest 500 (req_0..req_499) were evicted; the newest 2000 survive.
    expect(read.entries[0]?.id).toBe('req_500');
    expect(read.entries[read.entries.length - 1]?.id).toBe('req_2499');
  });

  it('reads a never-seen session as an empty ring, never an error', () => {
    const store = new SessionNetworkLogStore();
    expect(store.get('agt_missing')).toEqual({ entries: [], next_after: null });
  });
});

// ── 2. RELAY — ownership-gated, re-bounded ───────────────────────────────────
describe('T-9 relay: networkRequests is appended only for an exact live owning node', () => {
  const liveOwner = { get: vi.fn().mockResolvedValue({ nodeId: 'node-1', status: 'active' }) };

  it('appends the frame rows when the reporting node OWNS the live session', async () => {
    const store = new SessionNetworkLogStore();
    makeSessionNetworkLogRelay(
      liveOwner,
      store,
      logger,
    )(makeFrame('agt_1', [makeEntry(0), makeEntry(1)]), 'node-1');
    await flush();
    expect(store.get('agt_1').entries.map((e) => e.id)).toEqual(['req_0', 'req_1']);
  });

  it('DROPS a frame from a NON-owning node (owner-spoof guard)', async () => {
    const store = new SessionNetworkLogStore();
    makeSessionNetworkLogRelay(
      liveOwner,
      store,
      logger,
    )(makeFrame('agt_1', [makeEntry(0)]), 'node-evil');
    await flush();
    expect(store.size).toBe(0);
  });

  it('DROPS a frame for a session whose owning node is NULL', async () => {
    const store = new SessionNetworkLogStore();
    const nullNode = { get: vi.fn().mockResolvedValue({ nodeId: null, status: 'active' }) };
    makeSessionNetworkLogRelay(
      nullNode,
      store,
      logger,
    )(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    expect(store.size).toBe(0);
  });

  it('DROPS a frame for an unknown session', async () => {
    const store = new SessionNetworkLogStore();
    const unknown = { get: vi.fn().mockResolvedValue(null) };
    makeSessionNetworkLogRelay(
      unknown,
      store,
      logger,
    )(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    expect(store.size).toBe(0);
  });

  it('DROPS a frame for a CLOSED session (no live producer)', async () => {
    const store = new SessionNetworkLogStore();
    const closed = { get: vi.fn().mockResolvedValue({ nodeId: 'node-1', status: 'closed' }) };
    makeSessionNetworkLogRelay(closed, store, logger)(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    expect(store.size).toBe(0);
  });

  it('truncates an over-cap frame to NETWORK_LOG_MAX_ENTRIES_PER_FRAME (200)', async () => {
    const store = new SessionNetworkLogStore();
    const entries = Array.from({ length: 250 }, (_, i) => makeEntry(i));
    makeSessionNetworkLogRelay(liveOwner, store, logger)(makeFrame('agt_1', entries), 'node-1');
    await flush();
    // 250 in, 200 kept — the first 200 rows survive the slice.
    const read = store.get('agt_1');
    expect(read.entries).toHaveLength(200);
    expect(read.entries[0]?.id).toBe('req_0');
    expect(read.entries[199]?.id).toBe('req_199');
  });

  it('drops an over-size entry (> NETWORK_LOG_ENTRY_MAX_BYTES) but keeps its normal sibling', async () => {
    const store = new SessionNetworkLogStore();
    // A 6 KB URL is valid at the schema (url max 8192) but serializes past the
    // 5 KB per-entry ceiling — the relay drops it and keeps the normal row.
    const oversize = makeEntry(0, { url: `https://e.com/${'a'.repeat(6000)}` });
    makeSessionNetworkLogRelay(
      liveOwner,
      store,
      logger,
    )(makeFrame('agt_1', [oversize, makeEntry(1)]), 'node-1');
    await flush();
    expect(store.get('agt_1').entries.map((e) => e.id)).toEqual(['req_1']);
  });
});

// ── 3. ROUTE — discriminated, ownership-gated, honest-empty ──────────────────
const ACC = 'acc_net';

function makeRecord(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'agt_net',
    accountId: ACC,
    driftstackSessionId: null,
    proxyId: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: 'node-1',
    profileId: null,
    idempotencyKey: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-09-03T00:00:00Z'),
    updatedAt: new Date('2026-09-03T00:00:00Z'),
    ...over,
  };
}

async function buildApp(opts: {
  store?: SessionNetworkLogStore;
  record?: AgentSessionRecord;
  callerAccountId?: string;
}) {
  const rec = opts.record ?? makeRecord();
  const sessions = {
    get: (id: string) => Promise.resolve(id === rec.id ? rec : null),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: opts.callerAccountId ?? ACC, tier: 'starter' },
      apiKey: { id: 'key_net', scopes: ['read', 'read:sessions'] },
      teams: [],
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    ...(opts.store !== undefined ? { sessionNetworkLogStore: opts.store } : {}),
  });
  await app.ready();
  return app;
}

interface NetworkBody {
  status: string;
  entries: NetworkRequestEntry[];
  next_after: string | null;
  reason?: string;
}

describe('T-9 route: GET /v1/agent-sessions/:id/network serves a discriminated, gated body', () => {
  it("returns status 'ok' with the ring entries and a poll cursor for a live session", async () => {
    const store = new SessionNetworkLogStore();
    store.append('agt_net', [makeEntry(0, { protocol: 'h3' }), makeEntry(1, { protocol: 'h2' })]);
    const app = await buildApp({ store });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_net/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json<NetworkBody>();
    expect(body.status).toBe('ok');
    expect(body.entries.map((e) => e.protocol)).toEqual(['h3', 'h2']);
    expect(body.next_after).toBe('2');
    await app.close();
  });

  it("returns status 'unavailable' with an empty list when the store is not wired (honest prod-empty state)", async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_net/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json<NetworkBody>();
    expect(body.status).toBe('unavailable');
    expect(body.entries).toEqual([]);
    await app.close();
  });

  it("returns status 'unavailable' when the session is not running, even with a wired store", async () => {
    const store = new SessionNetworkLogStore();
    store.append('agt_net', [makeEntry(0)]);
    const app = await buildApp({ store, record: makeRecord({ status: 'closed' }) });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_net/network' });
    const body = res.json<NetworkBody>();
    expect(body.status).toBe('unavailable');
    await app.close();
  });

  it('refuses a caller from another account with 404 (ownership gate)', async () => {
    const store = new SessionNetworkLogStore();
    const app = await buildApp({ store, callerAccountId: 'acc_intruder' });
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_net/network' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
