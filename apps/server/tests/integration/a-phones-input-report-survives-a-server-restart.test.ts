// Owner item 7 (2026-09-24): "IN a active session i randomly got this; Waiting
// on the phone — it has not reported yet whether it can accept taps".
//
// ROOT CAUSE, server side: the phone's capability report — the one message in
// which it says whether it accepts taps — lived only in this process's memory
// (`SessionCapabilityReportStore`, a Map). A restart or deploy emptied it, the
// session read then left `capability_report` out, and the phone re-sends only
// on its next state change or its periodic refresh, minutes later. Every
// Simulator window on every live session went back to "Waiting on the phone".
//
// Now the store writes each report through to Redis with a TTL tied to the
// session (the agent-session lifetime cap), deletes it with the session, and a
// new process reloads what the last one held. Without Redis it is the same
// in-memory store as before.
//
// Proven against a real Redis (REDIS_URL, e.g. redis://localhost:6379/8): a
// report stored by one store instance is returned by a NEW instance on the same
// Redis — the restart, simulated. Keys use a per-run prefix, so this never
// flushes and cannot disturb anything else in that database.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function report(sessionId: string, overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId,
    timestamp: '2026-09-24T12:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: true,
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

/** Let the store's best-effort Redis writes land (they are issued in order on
 *  one connection, so a round-trip behind them is enough). */
async function flushWrites(redis: Redis): Promise<void> {
  await redis.ping();
}

describe('without Redis the store is the in-memory store it always was', () => {
  it('stores, reads and deletes in memory', async () => {
    const store = new SessionCapabilityReportStore();
    await store.hydrate(); // nothing to reload, and it must not throw
    store.set(report('agt_mem'), 'mac-1');
    expect(store.get('agt_mem')?.manual_input_available).toBe(true);
    expect(store.get('agt_mem')?.reporting_node_id).toBe('mac-1');
    store.delete('agt_mem');
    expect(store.get('agt_mem')).toBeNull();
  });

  it('CONTROL — a new in-memory instance knows nothing (what a restart used to do)', () => {
    const before = new SessionCapabilityReportStore();
    before.set(report('agt_mem2'));
    const after = new SessionCapabilityReportStore();
    expect(after.get('agt_mem2')).toBeNull();
  });
});

let redis: Redis | null = null;
let reachable = false;
const prefix = `zz-test-capability-report:${randomUUID()}:`;

beforeAll(async () => {
  if (!process.env.CI && !process.env.REDIS_URL) return;
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.ping();
    redis = client;
    reachable = true;
  } catch {
    await client.quit().catch(() => {});
  }
});

afterAll(async () => {
  if (redis === null) return;
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit().catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.REDIS_URL)(
  "the phone's capability report survives a server restart (real Redis)",
  () => {
    const store = (ttlSeconds = 3_600): SessionCapabilityReportStore => {
      if (redis === null) throw new Error('no redis');
      return new SessionCapabilityReportStore(5_000, { redis, keyPrefix: prefix, ttlSeconds });
    };

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('CRITICAL a report stored before a restart is returned after it', async () => {
      const before = store();
      before.set(report('agt_restart'), 'mac-7');
      await flushWrites(redis as Redis);

      const after = store(); // the new process
      await after.hydrate();
      const got = after.get('agt_restart');
      expect(got).not.toBeNull();
      expect(got?.manual_input_available).toBe(true);
      expect(got?.streaming_state).toBe('live');
      expect(got?.reporting_node_id).toBe('mac-7');
      expect(got).toEqual(before.get('agt_restart'));
    });

    it('a read before the reload finishes fetches it, and the next read has it', async () => {
      const before = store();
      before.set(report('agt_readthrough', { manualInputAvailable: false }));
      await flushWrites(redis as Redis);

      const after = store(); // no hydrate()
      expect(after.get('agt_readthrough')).toBeNull(); // this read starts the fetch
      await expect.poll(() => after.get('agt_readthrough')?.manual_input_available).toBe(false);
    });

    it('a newer report replaces the stored one', async () => {
      const first = store();
      first.set(report('agt_newer', { manualInputAvailable: false }));
      first.set(
        report('agt_newer', { manualInputAvailable: true, timestamp: '2026-09-24T12:05:00.000Z' }),
      );
      await flushWrites(redis as Redis);
      const after = store();
      await after.hydrate();
      expect(after.get('agt_newer')?.manual_input_available).toBe(true);
    });

    it('a session that ended takes its report with it — a restart does not bring it back', async () => {
      const before = store();
      before.set(report('agt_ended'));
      before.delete('agt_ended');
      await flushWrites(redis as Redis);
      const after = store();
      await after.hydrate();
      expect(after.get('agt_ended')).toBeNull();
      await new Promise((r) => setTimeout(r, 50)); // any read-through settles
      expect(after.get('agt_ended')).toBeNull();
    });

    it('the stored copy expires with the session: it carries a TTL no longer than the one given', async () => {
      const s = store(120);
      s.set(report('agt_ttl'));
      await flushWrites(redis as Redis);
      const ttl = await (redis as Redis).ttl(`${prefix}agt_ttl`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it('a corrupt stored entry is skipped, never served', async () => {
      await (redis as Redis).set(`${prefix}agt_corrupt`, '{not json', 'EX', 60);
      const after = store();
      await after.hydrate();
      expect(after.get('agt_corrupt')).toBeNull();
    });
  },
);
