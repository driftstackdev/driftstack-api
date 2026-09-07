// T-27 (drop 2) — the LIVE in-session QUIC signal reaches the proxy cache.
//
// The server exposes `h3_connection_observed` on a session's capability_report
// on purpose, and the desktop dropped it at both consumers: the session-control
// parser kept three fields and nothing else, and the profile hub's list poll —
// the one consumer whose store the cards actually read — never looked. This
// guards the parse, the attribution of a session to the proxy it launched
// through, the ledger that keeps a LATCHED boolean from re-stamping on every
// poll, and the write itself.
//
// One property per assertion; a session with no signal is the vacuity control.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock('../../src/lib/settings', () => ({
  loadSettings: vi.fn().mockResolvedValue({ apiKey: 'ds_test', baseUrl: 'https://api.test' }),
  loadBaseUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

import {
  attributeSessionProxy,
  makeH3ObservationLedger,
  parseH3Observation,
} from '../../src/lib/session-h3-observation';
import {
  loadProbeCache,
  recordLiveH3Observations,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { getAgentSession } from '../../src/lib/agent-session-control';

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const TS = '2026-09-07T09:01:58.747Z';
const TS_MS = Date.parse(TS);
const NOW = TS_MS + 15_000;

const mockFetch = vi.fn();
global.fetch = mockFetch;
function ok(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  stores.clear();
  mockFetch.mockReset();
});

describe('parseH3Observation — what a report says about HTTP/3', () => {
  it('CRITICAL `h3_connection_observed: true` is an observation, stamped with the report time', () => {
    expect(parseH3Observation({ h3_connection_observed: true, timestamp: TS })).toEqual({
      at: TS_MS,
    });
  });

  it('a positive count is an observation even without the flag, and the count rides along', () => {
    expect(parseH3Observation({ h3_connection_count: 2 })).toEqual({ count: 2 });
  });

  it('VACUITY CONTROL — absent, null, false, a zero count, an array or a non-object is NOT an observation', () => {
    expect(parseH3Observation({})).toBeNull();
    expect(parseH3Observation({ h3_connection_observed: null })).toBeNull();
    expect(parseH3Observation({ h3_connection_observed: false })).toBeNull();
    expect(parseH3Observation({ h3_connection_count: 0 })).toBeNull();
    expect(parseH3Observation([])).toBeNull();
    expect(parseH3Observation('yes')).toBeNull();
    expect(parseH3Observation(undefined)).toBeNull();
  });

  it('an unparseable timestamp leaves the stamp out rather than inventing one', () => {
    expect(parseH3Observation({ h3_connection_observed: true, timestamp: 'soon' })).toEqual({});
  });
});

describe('attributeSessionProxy — the same rule the launch used', () => {
  const proxies = [{ id: 'first' }, { id: 'explicit' }];

  it("the binding's explicit default, when it still exists", () => {
    expect(
      attributeSessionProxy(
        'agt_1',
        [{ profileId: 'pr', defaultProxyId: 'explicit', currentSessionId: 'agt_1' }],
        proxies,
      ),
    ).toBe('explicit');
  });

  it('CRITICAL an explicit default that was deleted attributes to NOTHING, never to another exit', () => {
    expect(
      attributeSessionProxy(
        'agt_1',
        [{ profileId: 'pr', defaultProxyId: 'gone', currentSessionId: 'agt_1' }],
        proxies,
      ),
    ).toBeNull();
  });

  it('no explicit default → the first saved proxy (what launch used)', () => {
    expect(
      attributeSessionProxy(
        'agt_1',
        [{ profileId: 'pr', defaultProxyId: null, currentSessionId: 'agt_1' }],
        proxies,
      ),
    ).toBe('first');
  });

  it('VACUITY CONTROL — a session no binding names is not evidence about any proxy', () => {
    expect(
      attributeSessionProxy(
        'agt_other',
        [{ profileId: 'pr', defaultProxyId: 'explicit', currentSessionId: 'agt_1' }],
        proxies,
      ),
    ).toBeNull();
  });
});

describe('the ledger — a latched boolean is stamped once, a rising count re-stamps', () => {
  it('the first observation of a session plans a write at the report time', () => {
    const ledger = makeH3ObservationLedger();
    expect(ledger.plan('agt_1', { at: TS_MS }, NOW)).toBe(TS_MS);
  });

  it('falls back to now when the report carried no time', () => {
    const ledger = makeH3ObservationLedger();
    expect(ledger.plan('agt_1', {}, NOW)).toBe(NOW);
  });

  it('CRITICAL after a commit, the same latched boolean re-emitted plans NOTHING', () => {
    const ledger = makeH3ObservationLedger();
    ledger.plan('agt_1', { at: TS_MS }, NOW);
    ledger.commit('agt_1', { at: TS_MS });
    expect(ledger.plan('agt_1', { at: TS_MS + 300_000 }, NOW + 300_000)).toBeNull();
  });

  it('a rising count plans a fresh stamp; an unchanged count does not', () => {
    const ledger = makeH3ObservationLedger();
    ledger.plan('agt_1', { count: 1, at: TS_MS }, NOW);
    ledger.commit('agt_1', { count: 1 });
    expect(ledger.plan('agt_1', { count: 1, at: TS_MS + 250_000 }, NOW)).toBeNull();
    expect(ledger.plan('agt_1', { count: 2, at: TS_MS + 250_000 }, NOW)).toBe(TS_MS + 250_000);
  });

  it('VACUITY CONTROL — a plan that was never committed is planned again (the write found nothing to attach to)', () => {
    const ledger = makeH3ObservationLedger();
    ledger.plan('agt_1', { at: TS_MS }, NOW);
    expect(ledger.plan('agt_1', { at: TS_MS }, NOW)).toBe(TS_MS);
  });
});

describe('recordLiveH3Observations — the hub poll writes the verdict', () => {
  const bindings = [{ profileId: 'pr', defaultProxyId: 'p1', currentSessionId: 'agt_live' }];
  const proxies = [{ id: 'p1' }];

  it("CRITICAL a live session that observed h3 stamps 'h3' on its proxy at the report time", async () => {
    await saveProbeResult('p1', OK, 1);
    const written = await recordLiveH3Observations(
      [{ id: 'agt_live', capability_report: { h3_connection_observed: true, timestamp: TS } }],
      bindings,
      proxies,
      NOW,
    );
    expect(written).toEqual(['p1']);
    const cache = await loadProbeCache();
    expect(cache['p1']?.quicMeasured).toBe('h3');
    expect(cache['p1']?.quicMeasuredAt).toBe(TS_MS);
  });

  it('the latched flag re-polled 300s later does NOT move the stamp', async () => {
    await saveProbeResult('p1', OK, 1);
    const first = [
      {
        id: 'agt_latched',
        capability_report: { h3_connection_observed: true, timestamp: TS },
      },
    ];
    await recordLiveH3Observations(
      first,
      [{ ...bindings[0]!, currentSessionId: 'agt_latched' }],
      proxies,
      NOW,
    );
    const again = await recordLiveH3Observations(
      [
        {
          id: 'agt_latched',
          capability_report: {
            h3_connection_observed: true,
            timestamp: new Date(TS_MS + 300_000).toISOString(),
          },
        },
      ],
      [{ ...bindings[0]!, currentSessionId: 'agt_latched' }],
      proxies,
      NOW + 300_000,
    );
    expect(again).toEqual([]);
    expect((await loadProbeCache())['p1']?.quicMeasuredAt).toBe(TS_MS);
  });

  it('a rising count re-stamps (the rate is the liveness the flag cannot carry)', async () => {
    await saveProbeResult('p1', OK, 1);
    const b = [{ ...bindings[0]!, currentSessionId: 'agt_count' }];
    await recordLiveH3Observations(
      [{ id: 'agt_count', capability_report: { h3_connection_count: 1, timestamp: TS } }],
      b,
      proxies,
      NOW,
    );
    const later = new Date(TS_MS + 250_000).toISOString();
    const written = await recordLiveH3Observations(
      [{ id: 'agt_count', capability_report: { h3_connection_count: 2, timestamp: later } }],
      b,
      proxies,
      NOW + 250_000,
    );
    expect(written).toEqual(['p1']);
    expect((await loadProbeCache())['p1']?.quicMeasuredAt).toBe(TS_MS + 250_000);
  });

  it('a proxy with no cache entry gets nothing invented, and is retried once it has one', async () => {
    const b = [{ ...bindings[0]!, currentSessionId: 'agt_retry' }];
    const sessions = [
      { id: 'agt_retry', capability_report: { h3_connection_observed: true, timestamp: TS } },
    ];
    expect(await recordLiveH3Observations(sessions, b, proxies, NOW)).toEqual([]);
    expect((await loadProbeCache())['p1']).toBeUndefined();
    await saveProbeResult('p1', OK, 1);
    expect(await recordLiveH3Observations(sessions, b, proxies, NOW)).toEqual(['p1']);
  });

  it('VACUITY CONTROL — a session with no h3 signal writes nothing', async () => {
    await saveProbeResult('p1', OK, 1);
    const written = await recordLiveH3Observations(
      [{ id: 'agt_quiet', capability_report: { streaming_state: 'live' } }],
      [{ ...bindings[0]!, currentSessionId: 'agt_quiet' }],
      proxies,
      NOW,
    );
    expect(written).toEqual([]);
    expect((await loadProbeCache())['p1']?.quicMeasured).toBeUndefined();
  });
});

describe('getAgentSession — the session-control parser keeps the signal', () => {
  it('CRITICAL surfaces an observed h3 with its report time', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: true,
          streaming_state: 'live',
          egress_state: 'live',
          h3_connection_observed: true,
          timestamp: TS,
        },
      }),
    );
    expect((await getAgentSession('agt_1')).capabilityReport).toEqual({
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
      h3_connection_observed: true,
      reported_at: TS_MS,
    });
  });

  it('VACUITY CONTROL — a report without the signal is byte-identical to before (no keys added)', async () => {
    mockFetch.mockResolvedValue(
      ok({
        mode: 'manual',
        status: 'active',
        capability_report: {
          manual_input_available: true,
          streaming_state: 'live',
          egress_state: 'live',
          h3_connection_observed: null,
          timestamp: TS,
        },
      }),
    );
    const report = (await getAgentSession('agt_1')).capabilityReport;
    expect(report).toEqual({
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
    });
    expect(report !== undefined && 'h3_connection_observed' in report).toBe(false);
  });
});
