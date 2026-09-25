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
import {
  NETWORK_LOG_MAX_QUEUED_ENTRIES,
  makeSessionNetworkLogRelay,
} from '../../src/services/session-network-log-relay.js';
import { SessionPageStateStore } from '../../src/services/session-page-state-store.js';
import { makeSessionPageStateRelay } from '../../src/services/session-page-state-relay.js';
import {
  NETWORK_LOG_ENTRY_MAX_BYTES,
  NETWORK_LOG_FRAME_HARD_MAX_ENTRIES,
  NETWORK_LOG_MAX_ENTRIES_PER_FRAME,
} from '../../src/schemas/harness-control-protocol.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  NetworkRequestEntry,
  NetworkRequestsFrame,
} from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** ⛔ EVERY CHANNEL THE RELAY LOGS ON, not just `warn`. The no-URL property is
 *  claimed file-wide of "any of these lines" and by the relay header of "a log
 *  line" — but the relay also writes `logger.error` (the onError path, which the
 *  primitive hands the WHOLE frame), so a check scoped to `warn` is narrower
 *  than the property it is cited for and would not red if a future edit put
 *  frame detail on the error line. Build the haystack from all three. */
function loggedLines(): string {
  return JSON.stringify([
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
    vi.mocked(logger.info).mock.calls,
  ]);
}

function clearLoggedLines(): void {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();
}

/** ⛔ NO URL (or any request content) on ANY channel this path logged — the
 *  pane's whole safety case is that the log register never carries one. */
function expectNoUrlLogged(): void {
  const logged = loggedLines();
  expect(logged).not.toContain('example.com');
  expect(logged).not.toContain('https://');
}

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

// entries is `unknown[]` (matching the schema): the frame no longer validates
// entries at parse — the relay does, per-entry — so tests can hand it malformed rows.
function makeFrame(sessionId: string, entries: unknown[]): NetworkRequestsFrame {
  return { type: 'networkRequests', sessionId, entries };
}

/** A row that FAILS NetworkRequestEntrySchema — an unmapped protocol (WebKit's
 *  `http/1.1`, which a naive producer would emit before mapping to `h1`). */
function makeBadProtocolEntry(i: number): unknown {
  return { ...makeEntry(i), protocol: 'http/1.1' };
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

  // T-16 (2026-09-08) — PER-ENTRY leniency: one bad row must NOT drop the
  // whole frame (which would blank the pane and read as "the fork emits nothing").
  // ARM 1 is the POSITIVE CONTROL for the vacuity arm below: it proves a drop
  // DOES fire a warn. ⛔ Do NOT split these into separate files or delete this arm
  // — the "no log on a legitimately-empty frame" arm goes vacuous without it (a
  // silently-broken logger also never logs), and the whole point of the fix is
  // that a schema-drop is DISTINGUISHABLE from an honest-empty ring.
  it('ARM1 keeps the valid rows and DROPS + LOGS an invalid-protocol row (never the whole frame)', async () => {
    const store = new SessionNetworkLogStore();
    vi.mocked(logger.warn).mockClear();
    makeSessionNetworkLogRelay(
      liveOwner,
      store,
      logger,
    )(makeFrame('agt_1', [makeEntry(0), makeBadProtocolEntry(1), makeEntry(2)]), 'node-1');
    await flush();
    // The two valid rows survive; the bad-protocol row is dropped, not the frame.
    expect(store.get('agt_1').entries.map((e) => e.id)).toEqual(['req_0', 'req_2']);
    // And the drop is LOUD: a warn naming the count + the offending field.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedCount: 1,
        schemaDropped: 1,
        firstReject: expect.stringContaining('protocol'),
      }),
      expect.stringContaining('dropped malformed'),
    );
  });

  it('ARM2 an all-invalid frame yields an empty ring but STILL logs the drop (not a silent empty)', async () => {
    const store = new SessionNetworkLogStore();
    vi.mocked(logger.warn).mockClear();
    makeSessionNetworkLogRelay(
      liveOwner,
      store,
      logger,
    )(makeFrame('agt_1', [makeBadProtocolEntry(0), makeBadProtocolEntry(1)]), 'node-1');
    await flush();
    expect(store.get('agt_1').entries).toHaveLength(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ droppedCount: 2 }),
      expect.stringContaining('dropped malformed'),
    );
  });

  it('ARM3 VACUITY: a legitimately-EMPTY frame appends nothing and logs NO drop (distinguishable from a schema-drop; relies on ARM1 as its positive control)', async () => {
    const store = new SessionNetworkLogStore();
    vi.mocked(logger.warn).mockClear();
    makeSessionNetworkLogRelay(liveOwner, store, logger)(makeFrame('agt_1', []), 'node-1');
    await flush();
    expect(store.get('agt_1').entries).toHaveLength(0);
    // No drop-log fired — an honest-empty ring, NOT data loss. ARM1 proves this
    // assertion is non-vacuous (the logger does fire when there IS a drop).
    expect(
      vi.mocked(logger.warn).mock.calls.some((c) => String(c[1]).includes('dropped malformed')),
    ).toBe(false);
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
    stopOnExitIpChange: false,
    firstExitIp: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    provisioningDetail: null,
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

// ── 4. QUEUE — a burst is COALESCED, not collapsed ──────────────────────────
//
// The relay rides the shared bounded-node-latest work queue, whose DEFAULT is
// latest-state: a frame arriving while another is queued REPLACES it. That is
// right for a state feed and wrong for this one — network entries are an APPEND
// feed, so the replaced frame's rows existed nowhere else and a 3-frame burst
// silently shortened the pane, with no counter and no log line (`onOverflow`
// covers only distinct-session overflow). These arms pin the fix: the entries
// survive the burst, the bound that still discards some COUNTS and LOGS it
// without a URL, the fold stays SILENT before the ownership gate, a burst of
// oversized entries cannot grow the queue, a fold that THROWS still counts what
// it destroyed, and a real STATE-feed consumer of the same primitive is
// unaffected.
//
// ⛔ MUTATION PROVENANCE — each line below was RUN against the real source under
// a restore trap, and names the arm that actually went red. A note here that
// misnames the arm is worse than none: it is the record the next agent reads to
// decide which arm binds which property, and a reader trusting a wrong one will
// weaken the guard that was really holding the line.
//   (a) drop `coalesce` from the relay wiring   → 5 red: BURST1 BURST2 BURST3
//                                                  BURST5 BYTES
//   (b) `folded.slice(0, cap)` → `folded`        → 1 red: BURST2
//   (c) `frame.coalesceDropped ?? 0` → `0` in
//       `process` (the queue count never lands)  → 2 red: BURST2 BYTES
//   (d) count a drop on EVERY merge, not only
//       past the bound (`+ 1` on rowsDropped)    → 3 red: BURST2 BURST3 BYTES
//   (e) re-add a `logger.warn` inside `coalesce` → 2 red: BURST3 BURST4
//   (f) remove the fold's per-entry byte filter  → 1 red: BYTES
//   (g) drop `discardedQueued` from the
//       primitive's coalesce-failure `onError`   → 2 red: BURST5 + the unit arm
//                                                  "reports WHAT THE FAILED FOLD
//                                                  DESTROYED"
//   (h) the primitive keeping the OLDER queued
//       frame instead of the successor           → 10 red, incl. STATEFEED
//   (i) put the frame (URLs included) on the
//       relay's `logger.error` payload           → 1 red: NOURL
//
// ⛔ (j) THE BLINDNESS CONTROL, and the reason `loggedLines()` spans channels:
// (i) applied together with the guard's PREVIOUS warn-only scope
// (`JSON.stringify(vi.mocked(logger.warn).mock.calls)`) runs 39/39 GREEN. The
// no-URL property is claimed of every line the relay writes; a check scoped to
// one channel could not see a URL land on another, so it certified a property it
// was not measuring. Widen the haystack, never the claim.

/** Holds the FIRST ownership lookup open so frames 2..n queue behind it — the
 *  exact window in which the old latest-state replace destroyed rows. */
// ⛔ The `get` is typed by its CALL SIGNATURE, not as `ReturnType<typeof vi.fn>`.
// That alias erases the signature to `Mock<Procedure | Constructable>`, which the
// relay's `NetworkLogRelaySessions` parameter rejects — and vitest never notices,
// because it transpiles tests without typechecking. The suite was green while
// `npm run typecheck` (a CI gate, and the push gate) failed at seven call sites.
function gatedOwner(): {
  sessions: { get: (id: string) => Promise<{ nodeId: string | null; status: string } | null> };
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const sessions = {
    get: vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { nodeId: 'node-1', status: 'active' };
    }),
  };
  return { sessions, release };
}

describe('T-9 queue: an append-feed burst coalesces instead of collapsing to the newest frame', () => {
  it('BURST1 delivers EVERY entry of a 3-frame burst, in producer order (the middle frame is not lost)', async () => {
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);

    // Frame 1 starts and parks on its ownership lookup; 2 and 3 queue behind it.
    relay(makeFrame('agt_1', [makeEntry(0), makeEntry(1)]), 'node-1');
    await flush();
    relay(makeFrame('agt_1', [makeEntry(2), makeEntry(3)]), 'node-1');
    relay(makeFrame('agt_1', [makeEntry(4), makeEntry(5)]), 'node-1');
    // Non-vacuity: nothing has landed yet, so the assertion below measures the
    // drain and not some pre-existing state.
    expect(store.get('agt_1').entries).toHaveLength(0);

    release();
    await vi.waitFor(() => expect(store.get('agt_1').entries).toHaveLength(6));
    // All six rows, in the order the producer emitted them — frame 2's rows
    // (req_2/req_3) are the ones a latest-state replace destroyed.
    expect(store.get('agt_1').entries.map((e) => e.id)).toEqual([
      'req_0',
      'req_1',
      'req_2',
      'req_3',
      'req_4',
      'req_5',
    ]);
  });

  it('BURST2 bounds the coalesced queue and COUNTS what the bound discards (session id + count, never a URL)', async () => {
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    relay(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    // Seven full per-frame-cap frames queue behind the parked lookup: 1400
    // entries folded, bounded to NETWORK_LOG_MAX_QUEUED_ENTRIES (1000) → 400 lost.
    const perFrame = NETWORK_LOG_MAX_ENTRIES_PER_FRAME;
    const frames = 7;
    for (let f = 0; f < frames; f += 1) {
      relay(
        makeFrame(
          'agt_1',
          Array.from({ length: perFrame }, (_, i) => makeEntry(1 + f * perFrame + i)),
        ),
        'node-1',
      );
    }
    release();

    const expectedDropped = frames * perFrame - NETWORK_LOG_MAX_QUEUED_ENTRIES;
    // The bound held: frame 1's row plus exactly the queue cap reached the ring.
    await vi.waitFor(() =>
      expect(store.get('agt_1').entries).toHaveLength(1 + NETWORK_LOG_MAX_QUEUED_ENTRIES),
    );
    // And the loss is COUNTED — the CUMULATIVE total the fold accrued across
    // every merge, reported ONCE, from `process`, AFTER the ownership gate. The
    // fold itself is silent by design (BURST4 pins that), so this register is not
    // a re-report of a fold-time line: it is the only line these 400 rows get,
    // and a session id plus a count is the whole of it.
    const dropWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => String(c[1]).includes('dropped malformed'));
    expect(dropWarns).toHaveLength(1);
    expect(dropWarns[0]?.[0]).toEqual(
      expect.objectContaining({
        component: 'session-network-log-relay',
        sessionId: 'agt_1',
        queueDropped: expectedDropped,
        droppedCount: expectedDropped,
        schemaDropped: 0,
        reboundDropped: 0,
        coalescedFrames: frames,
        kept: NETWORK_LOG_MAX_QUEUED_ENTRIES,
      }),
    );
    expectNoUrlLogged();
  });

  it('BURST4 the fold is SILENT before the ownership gate: an unowning node cannot drive one drop line per frame', async () => {
    // ⛔ THE FOLD RUNS PRE-GATE. `process` is where the ownership lookup happens,
    // so a log line written inside `coalesce` is one a node that owns NOTHING can
    // emit per frame, with an attacker-chosen sessionId in the structured field —
    // the exact log amplification that keeps the per-entry safeParse behind the
    // gate. The counts must ride the frame through the gate instead. Here a rogue
    // node bursts a session owned by someone else: the only lines allowed are the
    // gate's own rejections, one per frame that became WORK (two — the parked one
    // and the single folded successor), not one per frame RECEIVED (51).
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner(); // owner is 'node-1'
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    const frames = 51;
    for (let f = 0; f < frames; f += 1) {
      relay(
        makeFrame(
          'agt_victim',
          Array.from({ length: NETWORK_LOG_FRAME_HARD_MAX_ENTRIES }, () => null),
        ),
        'rogue-node',
      );
      if (f === 0) await flush(); // frame 1 parks on the lookup; 2..51 fold behind it
    }
    release();

    await vi.waitFor(() => expect(sessions.get).toHaveBeenCalledTimes(2));
    await flush();
    expect(store.get('agt_victim').entries).toHaveLength(0);
    // Non-vacuity: the gate DID reject, so the count below measures a real path.
    const gateWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => String(c[1]).includes('without an exact live session-owner'));
    expect(gateWarns).toHaveLength(2);
    // …and nothing else. 51 frames in, 2 lines out.
    expect(vi.mocked(logger.warn).mock.calls).toHaveLength(2);
    expectNoUrlLogged();
  });

  it('BYTES a burst of OVERSIZED entries does not grow the queue — the fold bounds cost, not just rows', async () => {
    // ⛔ THE ROW CAP IS NOT A MEMORY BOUND. `entries` is `z.array(z.unknown())`
    // until `process` runs, so 1000 queued rows can each have been drawn from a
    // separate 96 MiB wire frame: bounded COUNT, unbounded COST, which is the
    // "unlimited queued work by repeating one id" axis the primitive exists to
    // deny. The fold must drop over-byte rows BEFORE the slot holds them.
    //
    // Observable consequence: these rows are counted as `queueDropped` (killed at
    // fold time, never queued) and NOT as `reboundDropped` (killed in `process`,
    // having been queued at full size all along). That distinction IS the memory
    // property — same rows discarded either way, different peak.
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    relay(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    const oversize = (i: number): unknown =>
      makeEntry(i, { url: `https://example.com/${'p'.repeat(NETWORK_LOG_ENTRY_MAX_BYTES)}` });
    const frames = 6;
    const perFrame = NETWORK_LOG_MAX_ENTRIES_PER_FRAME;
    for (let f = 0; f < frames; f += 1) {
      relay(
        makeFrame(
          'agt_1',
          Array.from({ length: perFrame }, (_, i) => oversize(1 + f * perFrame + i)),
        ),
        'node-1',
      );
    }
    release();

    const oversized = frames * perFrame;
    await vi.waitFor(() => expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0));
    // Only frame 1's single legitimate row reached the ring.
    await vi.waitFor(() => expect(store.get('agt_1').entries.map((e) => e.id)).toEqual(['req_0']));
    const dropWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => String(c[1]).includes('dropped malformed'));
    expect(dropWarns).toHaveLength(1);
    expect(dropWarns[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: 'agt_1',
        // Every oversized row died at the FOLD. Nothing was queued at full size,
        // so nothing was left for the post-gate re-bound to discard, and the row
        // cap never even engaged (1200 oversized rows, 0 rows queued).
        queueDropped: oversized,
        reboundDropped: 0,
        kept: 0,
      }),
    );
    expectNoUrlLogged();
  });

  it('BURST5 a fold that THROWS still COUNTS the queued rows the primitive then destroys', async () => {
    // ⛔ THE DEGRADED PATH IS STILL A DROP. When `coalesce` throws, the primitive
    // falls back to latest-state and discards the QUEUED frame — up to a whole
    // window of rows that exist nowhere else. Reporting only "something failed"
    // recreates precisely the silent shortening `coalesce` was added to end, so
    // the primitive hands the discarded frame back and the relay counts it in the
    // same register as every other drop.
    //
    // Injecting the fault takes a frame whose `entries` cannot be read the way the
    // fold reads them: the fold no longer logs and guards its serialization, so
    // nothing a NODE can send makes it throw. This stands in for any future fold
    // defect — the arm is about what happens after one, not about this trigger.
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    const hostile = [makeEntry(1), makeEntry(2), makeEntry(3)];
    Object.defineProperty(hostile, 'filter', {
      value: () => {
        throw new Error('fold defect');
      },
    });

    relay(makeFrame('agt_1', [makeEntry(0)]), 'node-1'); // parks on the lookup
    await flush();
    relay(makeFrame('agt_1', hostile), 'node-1'); // becomes the queued frame
    relay(makeFrame('agt_1', [makeEntry(4)]), 'node-1'); // folding it THROWS
    release();

    // The successor survives; the queued frame's 3 rows are gone (that is the
    // documented fallback) — but they are no longer gone in SILENCE.
    await vi.waitFor(() =>
      expect(store.get('agt_1').entries.map((e) => e.id)).toEqual(['req_0', 'req_4']),
    );
    const foldFailWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => String(c[1]).includes('the coalesce fold threw'));
    expect(foldFailWarns).toHaveLength(1);
    expect(foldFailWarns[0]?.[0]).toEqual(
      expect.objectContaining({
        component: 'session-network-log-relay',
        sessionId: 'agt_1',
        droppedCount: hostile.length,
        queueDropped: hostile.length,
      }),
    );
    expectNoUrlLogged();
  });

  it("NOURL the relay's ERROR channel carries no URL either (the callback is handed the whole frame)", async () => {
    // ⛔ SCOPE. The no-URL claim is made of "a log line", not of `logger.warn`.
    // The relay also logs on `logger.error`, from a callback the primitive hands
    // the ENTIRE frame — URLs included. Today only {sessionId, err} is
    // destructured, so the property holds; this arm is what makes it hold
    // TOMORROW, when someone adds frame detail "just for debugging".
    const store = new SessionNetworkLogStore();
    const sessions = { get: vi.fn(async () => Promise.reject(new Error('db unavailable'))) };
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    relay(makeFrame('agt_1', [makeEntry(0), makeEntry(1)]), 'node-1');

    // Non-vacuity: the error line really was emitted, so the check below is not
    // passing merely because nothing logged at all.
    await vi.waitFor(() => expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(logger.error).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ component: 'session-network-log-relay', sessionId: 'agt_1' }),
    );
    expect(store.get('agt_1').entries).toHaveLength(0);
    expectNoUrlLogged();
  });

  it('BURST3 VACUITY: a burst INSIDE the queue bound loses nothing and logs NO drop (relies on BURST2 as its positive control)', async () => {
    const store = new SessionNetworkLogStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionNetworkLogRelay(sessions, store, logger);
    clearLoggedLines();

    relay(makeFrame('agt_1', [makeEntry(0)]), 'node-1');
    await flush();
    relay(makeFrame('agt_1', [makeEntry(1)]), 'node-1');
    relay(makeFrame('agt_1', [makeEntry(2)]), 'node-1');
    release();

    await vi.waitFor(() => expect(store.get('agt_1').entries).toHaveLength(3));
    // Without this arm, BURST2's counter assertion would pass just as happily if
    // the fold counted a drop on EVERY merge rather than only past the bound —
    // and the pane's one loss signal would cry wolf on every healthy burst.
    expect(vi.mocked(logger.warn).mock.calls).toHaveLength(0);
    expect(vi.mocked(logger.error).mock.calls).toHaveLength(0);
  });

  it('STATEFEED a state-feed consumer of the SAME primitive still gets latest-state semantics (pageState)', async () => {
    // The fix is opt-in per consumer. This drives the REAL pageState relay — one
    // of the seven other users of the shared queue — through the identical burst
    // shape and pins that its queued frame is still REPLACED, not concatenated:
    // a state frame carries the whole current state, so folding would be wrong.
    const store = new SessionPageStateStore();
    const { sessions, release } = gatedOwner();
    const relay = makeSessionPageStateRelay(sessions, store, logger);

    relay({ type: 'pageState', sessionId: 'agt_1', state: 'loading' }, 'node-1');
    await flush();
    relay({ type: 'pageState', sessionId: 'agt_1', state: 'stalled' }, 'node-1');
    relay({ type: 'pageState', sessionId: 'agt_1', state: 'loaded' }, 'node-1');
    release();

    await vi.waitFor(() => expect(store.get('agt_1')?.state).toBe('loaded'));
    // Two lookups, not three: the superseded middle frame never became work.
    expect(sessions.get).toHaveBeenCalledTimes(2);
  });
});
