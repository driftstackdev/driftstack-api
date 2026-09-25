// T-27 (drops 1 and 5) — the control plane's fleet test is ONE shared step for
// the Proxies grid and the profile card (lib/proxy-server-test), so the card can
// no longer be missing it; and the measured-QUIC stamp it stores is the
// SERVER's `quic_measured_at`, not this Mac's clock at reply time.
//
// One property per assertion; the `unavailable` / `failed` outcomes are the
// vacuity controls for the persistence — they must write nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';

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

const { testAccountProxy, createProxy, deleteProxy, setProxyServerId } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxiesModule.AccountProxyTestResult>
    >(),
  // (V4 follow-up) — the create/delete pair and the LOCAL id write, which is
  // where the two orphan modes live (see the describe at the foot of this file).
  createProxy: vi.fn<(b: string, k: string, input: unknown) => Promise<{ id: string }>>(),
  deleteProxy: vi.fn<(b: string, k: string, id: string) => Promise<void>>(),
  setProxyServerId:
    vi.fn<(id: string, serverId: string) => Promise<ProxiesModule.ProxyConfig | null>>(),
}));

// Partial mock: every real export stays (the cache imports cleanMeasuredQuic
// from here); only the network call is replaced.
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
  createProxy: (b: string, k: string, input: unknown) => createProxy(b, k, input),
  deleteProxy: (b: string, k: string, id: string) => deleteProxy(b, k, id),
}));

// Partial mock: every predicate and the endpoint resolve stay REAL; only the
// LOCAL id write is a spy, because its two failure modes are the subject.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  setProxyServerId: (id: string, serverId: string) => setProxyServerId(id, serverId),
}));

import {
  ensureAccountProxyRow,
  persistAutomaticServerProbe,
  persistServerProbe,
  quicVerdictStamp,
  serverProbeOutcome,
  testProxyOnServer,
} from '../../src/lib/proxy-server-test';
import {
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveProbeResult,
  saveServerProbeResult,
  serverCapabilityReadingsToAdopt,
} from '../../src/lib/proxy-probe-cache';

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};
const NOW = 1_800_000_000_000;
const SERVER_TS = '2026-09-07T08:00:00.000Z';
const SERVER_MS = Date.parse(SERVER_TS);

beforeEach(() => {
  stores.clear();
  testAccountProxy.mockReset();
});

describe('quicVerdictStamp — the server clock wins', () => {
  it('CRITICAL a parseable `quic_measured_at` is the stamp, not the reply time', () => {
    expect(quicVerdictStamp(SERVER_TS, NOW)).toBe(SERVER_MS);
    expect(quicVerdictStamp(SERVER_TS, NOW)).not.toBe(NOW);
  });

  it('VACUITY CONTROL — null, absent or garbage falls back to the reply time', () => {
    expect(quicVerdictStamp(null, NOW)).toBe(NOW);
    expect(quicVerdictStamp(undefined, NOW)).toBe(NOW);
    expect(quicVerdictStamp('not a date', NOW)).toBe(NOW);
  });
});

describe('serverProbeOutcome — the wire result, translated once', () => {
  it('no answer at all is `unavailable`', () => {
    expect(serverProbeOutcome(null, NOW)).toEqual({ kind: 'unavailable' });
  });

  it('a server that says NOT usable is `failed`, with its reason and vantage', () => {
    expect(
      serverProbeOutcome({ ok: false, reason: 'did not answer', measured_from: 'fleet' }, NOW),
    ).toEqual({
      kind: 'failed',
      at: NOW,
      reason: 'did not answer',
      vantage: { measuredFrom: 'fleet' },
    });
  });

  it("CRITICAL a measured 'h3' carries the SERVER's stamp", () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: 31, quic_measured: 'h3', quic_measured_at: SERVER_TS },
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'ok', quicMeasured: 'h3', quicMeasuredAt: SERVER_MS });
  });

  it('a measured verdict with no server stamp is stamped at reply time', () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: 31, quic_measured: 'h2-only', quic_measured_at: null },
      NOW,
    );
    expect(outcome).toMatchObject({ kind: 'ok', quicMeasured: 'h2-only', quicMeasuredAt: NOW });
  });

  it('VACUITY CONTROL — no QUIC field means no verdict and no stamp', () => {
    const outcome = serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW);
    expect(outcome).toEqual({ kind: 'ok', at: NOW, latencyMs: 31 });
  });

  it('T-1 — a fleet result with null latency is a real answer: latencyMs is null, not dropped', () => {
    const outcome = serverProbeOutcome(
      { ok: true, latency_ms: null, measured_from: 'fleet', node_id: 'mac-07', quic_probe: true },
      NOW,
    );
    expect(outcome).toEqual({
      kind: 'ok',
      at: NOW,
      latencyMs: null,
      vantage: { measuredFrom: 'fleet', nodeId: 'mac-07' },
      quicProbe: true,
    });
  });

  it('the node id survives only beside a fleet vantage, and the fingerprint rides through', () => {
    const outcome = serverProbeOutcome(
      {
        ok: true,
        latency_ms: 9,
        measured_from: 'control_plane',
        os_fingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
      },
      NOW,
    );
    expect(outcome).toMatchObject({
      vantage: { measuredFrom: 'control_plane' },
      osFingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
    });
    expect((outcome as { vantage?: { nodeId?: string } }).vantage?.nodeId).toBeUndefined();
  });
});

describe('testProxyOnServer — asks for the FLEET vantage and never throws', () => {
  it("CRITICAL sends { vantage: 'fleet' } with the caller's credentials and id", async () => {
    testAccountProxy.mockResolvedValue({ ok: true, latency_ms: 31 });
    await testProxyOnServer('http://localhost:3000', 'ds_test', 'aprx_1', () => NOW);
    expect(testAccountProxy).toHaveBeenCalledTimes(1);
    expect(testAccountProxy.mock.calls[0]).toEqual([
      'http://localhost:3000',
      'ds_test',
      'aprx_1',
      { vantage: 'fleet' },
    ]);
  });

  it('a request that throws is `unavailable`, not an exception the caller has to survive', async () => {
    testAccountProxy.mockRejectedValue(new Error('offline'));
    await expect(testProxyOnServer('http://x', 'k', 'aprx_1', () => NOW)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('persistServerProbe — one cache write for both surfaces', () => {
  it("CRITICAL stores the server latency, the verdict under the SERVER's stamp, the vantage, the relay verdict and the fingerprint", async () => {
    await saveProbeResult('p1', OK, 1);
    const outcome = serverProbeOutcome(
      {
        ok: true,
        latency_ms: 31,
        quic_measured: 'h3',
        quic_measured_at: SERVER_TS,
        measured_from: 'fleet',
        node_id: 'mac-07',
        quic_probe: true,
        os_fingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64' },
      },
      NOW,
    );
    const cache = await persistServerProbe('p1', outcome);
    expect(cache?.['p1']).toMatchObject({
      serverLatencyMs: 31,
      quicMeasured: 'h3',
      quicMeasuredAt: SERVER_MS,
      measuredFrom: 'fleet',
      nodeId: 'mac-07',
      quicProbe: true,
      osFingerprint: { os: 'linux', confidence: 'high', reason: 'ttl 64', at: NOW },
    });
    expect(cache?.['p1']?.quicMeasuredAt).not.toBe(NOW);
  });

  it('T-1 — a null latency CLEARS a stored number', async () => {
    await saveProbeResult('p1', OK, 1);
    await persistServerProbe('p1', serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW));
    const cleared = await persistServerProbe(
      'p1',
      serverProbeOutcome({ ok: true, latency_ms: null, measured_from: 'fleet' }, NOW + 1),
    );
    expect(cleared?.['p1']?.serverLatencyMs).toBeUndefined();
  });

  it('VACUITY CONTROL — `unavailable` writes nothing and returns null; a SOCKS5 `failed` from a fleet Mac is written (G2) as the stamp and the sentence beside this Mac’s own verdict', async () => {
    await saveProbeResult('p1', OK, 1);
    expect(await persistServerProbe('p1', { kind: 'unavailable' })).toBeNull();
    expect((await loadProbeCache())['p1']).toEqual({ result: OK, at: 1 });
    expect(
      await persistServerProbe('p1', {
        kind: 'failed',
        at: NOW,
        reason: 'no',
        vantage: { measuredFrom: 'fleet' },
      }),
    ).not.toBeNull();
    expect((await loadProbeCache())['p1']).toEqual({
      result: OK,
      at: 1,
      exitSupersededAt: NOW,
      fleetFailureReason: 'no',
    });
  });

  // ⛔ (V4 round 3, 2026-09-12) — the arm above is the vacuity control, on an
  // entry with nothing to lose. THIS is the entry a SOCKS5 Test actually leaves
  // behind: the native verdict, the exit this Mac measured THROUGH the proxy,
  // and a fleet number from an earlier test.
  //
  // MEASURED in the running harness (real ProxiesView, real CSS, the real Test
  // button, a stubbed control plane — scratchpad/v4c-candidates.mjs, candidate
  // C): routing this failure through `saveFleetFailure` — the one-line "fix"
  // for the verdict the row currently loses — rebuilds the entry as
  // { result, at, exitSupersededAt, fleetFailureReason } and the row's Exit
  // cell goes from "🇧🇷 203.0.113.20 · Sao Paulo, SP" to "run Test for exit IP",
  // seconds after this Mac measured it. The fleet refusing a proxy says nothing
  // about the exit a NATIVE probe saw through it — ProxiesView's own failure
  // handler keeps it for exactly that reason ("the shared drop keeps a SOCKS5
  // row's natively-measured exit; a tunnel has no other exit to keep") — and
  // `saveFleetFailure`'s blanket drop is a TUNNEL rule: for a VPN row the fleet
  // is the only thing that ever saw an exit.
  //
  // So this arm pins the shape of the write that now lands here (proxy-accuracy
  // audit G2): it saves the failure and must not take the native exit with it.
  // The CONTROL below is what stops this being vacuous: the same call from a VPN
  // caller does supersede the exit, through the same writer.
  it('CRITICAL a SOCKS5 row’s fleet failure never costs the row the exit THIS Mac measured', async () => {
    const refused =
      'The proxy refused the connection from the test Mac (reply 0x02 — not allowed by ruleset).';
    await saveProbeResult('p1', OK, 1);
    await saveExitResult(
      'p1',
      '203.0.113.20',
      'BR',
      { city: 'Sao Paulo', timezone: 'America/Sao_Paulo' },
      2,
    );
    await saveServerProbeResult(
      'p1',
      { latencyMs: 180, measuredFrom: 'fleet', nodeId: 'mac-07' },
      3,
    );

    const failure = serverProbeOutcome({ ok: false, reason: refused, measured_from: 'fleet' }, NOW);
    await persistServerProbe('p1', failure); // the SOCKS5 call sites pass no adoptExit

    const entry = (await loadProbeCache())['p1'];
    expect(entry?.exitIp).toBe('203.0.113.20');
    expect(entry?.exitCity).toBe('Sao Paulo');
    expect(entry?.exitAt).toBe(2);
    // …and the native verdict itself is untouched: the fleet answered about the
    // fleet, and this row still connected from here.
    expect(entry?.result).toEqual(OK);
    expect(entry?.at).toBe(1);
    // G2 — and the failure IS saved now: the stamp, the sentence, and not one
    // Driftstack reading from before it.
    expect(entry?.exitSupersededAt).toBe(NOW);
    expect(entry?.fleetFailureReason).toBe(refused);
    expect(entry?.serverLatencyMs).toBeUndefined();
    expect(entry?.measuredFrom).toBeUndefined();

    // CONTROL — the SAME outcome from a VPN caller DOES supersede the exit and
    // records the sentence, so the assertions above are about the caller, not
    // about a writer that never drops anything.
    await persistServerProbe('p1', failure, { adoptExit: true });
    const tunnel = (await loadProbeCache())['p1'];
    expect(tunnel?.exitIp).toBeUndefined();
    expect(tunnel?.exitSupersededAt).toBe(NOW);
    expect(tunnel?.fleetFailureReason).toBe(refused);
  });

  it('a proxy with no native entry gets nothing invented', async () => {
    const cache = await persistServerProbe(
      'ghost',
      serverProbeOutcome({ ok: true, latency_ms: 31 }, NOW),
    );
    expect(cache?.['ghost']).toBeUndefined();
  });
});

// ─── (V2 2026-09-12) — `vpnStoreRefusal`: the sentence a REFUSED store leaves ──
//
// The VPN check stores the row itself now (the loop it replaced: "launch a
// session through this proxy once to store it", while the launch was the half of
// the owner's report that failed). When the store is refused the row must say
// WHICH refusal it was — the three causes have three different next steps — and
// the notice and the Test-all tally clause must be picked TOGETHER so the row
// and the summary can never name different reasons for the same refusal.
//
// ⛔ Built against the REAL `AccountProxyRequestError`, not a structural double:
// the view suites hand the view an object with `status`/`detail`, and if the
// transport ever carried the status somewhere else that double would keep
// passing while production fell through to the generic sentence.
describe('(V2) vpnStoreRefusal — each refusal names itself', () => {
  const TIER_DETAIL =
    'The "vpnEgress" feature is not available on the "free" tier. Upgrade to a tier that includes this feature.';

  it('CRITICAL the TIER 403 is the plan sentence, and never echoes the server’s flag name', async () => {
    const { AccountProxyRequestError } = await import('../../src/lib/account-proxies');
    const { VPN_PLAN_EXCLUDED_CHECK_NOTICE, VPN_PLAN_EXCLUDED_TALLY_REASON } =
      await import('../../src/lib/proxy-check-copy');
    const { vpnStoreRefusal } = await import('../../src/lib/proxy-server-test');
    const r = vpnStoreRefusal(new AccountProxyRequestError('create', 403, { detail: TIER_DETAIL }));
    expect(r.notice).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE);
    expect(r.tally).toBe(VPN_PLAN_EXCLUDED_TALLY_REASON);
    expect(r.notice).not.toContain('vpnEgress');
  });

  it('CRITICAL the free-desktop ROUTE-POLICY 403 is the CREDENTIAL, not the plan', async () => {
    const { AccountProxyRequestError, DESKTOP_CREDENTIAL_REFUSAL_DETAIL } =
      await import('../../src/lib/account-proxies');
    const { DESKTOP_CREDENTIAL_TALLY_REASON, VPN_PLAN_EXCLUDED_CHECK_NOTICE } =
      await import('../../src/lib/proxy-check-copy');
    const { vpnStoreRefusal } = await import('../../src/lib/proxy-server-test');
    const r = vpnStoreRefusal(
      new AccountProxyRequestError('create', 403, { detail: DESKTOP_CREDENTIAL_REFUSAL_DETAIL }),
    );
    // GUI audit #11 — the Free plan, never "needs an API key".
    expect(r.notice).toContain("isn't included on the Free plan");
    expect(r.notice).not.toContain('API key');
    expect(r.notice).not.toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE);
    expect(r.tally).toBe(DESKTOP_CREDENTIAL_TALLY_REASON);
  });

  it('VACUITY CONTROL — any other refusal carries the server’s own sentence, and a 403 with an unknown detail is NOT the plan', async () => {
    const { AccountProxyRequestError } = await import('../../src/lib/account-proxies');
    const { VPN_PLAN_EXCLUDED_CHECK_NOTICE, VPN_STORE_FAILED_TALLY_REASON } =
      await import('../../src/lib/proxy-check-copy');
    const { vpnStoreRefusal } = await import('../../src/lib/proxy-server-test');
    const four00 = vpnStoreRefusal(
      new AccountProxyRequestError('create', 400, {
        detail: 'Line 46: "script-security 2" — Driftstack does not run scripts from VPN configs.',
      }),
    );
    expect(four00.notice).toContain('Line 46: "script-security 2"');
    expect(four00.tally).toBe(VPN_STORE_FAILED_TALLY_REASON);
    // ⛔ (V4 follow-up 2026-09-12) — THIS LEG'S SECOND ASSERTION IS DELIBERATELY
    // REVERSED. It used to require the unrecognised 403's detail to be ECHOED,
    // which is the same leak the plan sentence three arms above exists to
    // prevent, from the same function: the real strings on this route are
    // `This action requires the "account_owner" scope.` and its suspended-account
    // and denied-device siblings — authorisation internals, not the customer's
    // own configuration. It also made the tier protection one server-side copy
    // edit deep: the tier branch matches a REGEX over prose one module over, so
    // a reworded tier sentence falls through to HERE, and the echo printed
    // `The "vpnEgress" feature is not available on the "free" tier` after all.
    // A 403 now says what the customer can do and quotes nothing.
    // MUTATION (run): restore the echo → this reds.
    const other403 = vpnStoreRefusal(
      new AccountProxyRequestError('create', 403, {
        detail: 'This action requires the "account_owner" scope.',
      }),
    );
    expect(other403.notice).not.toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE);
    expect(other403.notice).not.toContain('account_owner');
    expect(other403.notice).not.toContain('Driftstack said');
    expect(other403.notice).toContain('check your plan and API key in Settings');
    // CONTROL — and the leak cannot come back through the tier branch either: a
    // 403 carrying a REWORDED tier sentence (the regex no longer matches) must
    // still not print the flag name.
    const rewordedTier = vpnStoreRefusal(
      new AccountProxyRequestError('create', 403, {
        detail: 'The "vpnEgress" capability is excluded from the free plan.',
      }),
    );
    expect(rewordedTier.notice).not.toContain('vpnEgress');
    // …and a throw with no problem body at all still says what to do next.
    const bare = vpnStoreRefusal(new Error('network down'));
    expect(bare.notice).toContain('try the check again');
    expect(bare.tally).toBe(VPN_STORE_FAILED_TALLY_REASON);
  });
});

// ⛔ (V4 follow-up 2026-09-12) — WHAT HAPPENS AFTER THE REMOTE ROW EXISTS.
//
// V2 made the VPN checks CREATE the account row, which put two pre-existing
// failure modes of the local bookkeeping on a path that now carries a
// customer's OpenVPN configuration / WireGuard private key:
//
//   * `setProxyServerId` answers `null` — SILENTLY — when the local row is gone
//     (`idx < 0`). A VPN check runs up to 90s, so a delete DURING one lands
//     exactly there: the create succeeds, the id write is a no-op, and
//     `ProxiesView.removeOne` already ran with `serverId === undefined`, so it
//     never asked the server to delete anything. An `account_proxies` row
//     holding the secret then survives a deletion the customer watched succeed.
//   * a THROW from the local store write is reported to the customer as
//     "Couldn't store this VPN on your account" — the opposite of what happened.
//
// MUTATIONS: (a) drop the `deleteAccountProxy` call → arm 1 reds on the delete
// and on the returned id; (b) revert the write to a bare `await
// setProxyServerId(...)` → arm 2 reds (the throw escapes, which is the false
// notice). The VACUITY CONTROL keeps both honest: the happy path must still
// record the id and never delete anything.
describe('(V4) ensureAccountProxyRow — the local id write cannot orphan a VPN secret or lie about it', () => {
  const VPN: ProxiesModule.ProxyConfig = {
    id: 'local-vpn',
    label: 'v',
    host: 'vpn.example.com',
    port: 1194,
    username: null,
    password: null,
    scheme: 'openvpn',
    openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
  } as unknown as ProxiesModule.ProxyConfig;

  beforeEach(() => {
    createProxy.mockReset();
    createProxy.mockResolvedValue({ id: 'aprx_created' });
    deleteProxy.mockReset();
    deleteProxy.mockResolvedValue(undefined);
    setProxyServerId.mockReset();
  });

  it('CRITICAL the local row was DELETED mid-check: our own create is undone, and nothing is returned to test', async () => {
    // `null` is the local store's way of saying "there is no such row any more".
    setProxyServerId.mockResolvedValue(null);
    const ensured = await ensureAccountProxyRow(VPN, 'http://cp', 'k');
    expect(createProxy).toHaveBeenCalledTimes(1);
    // The secret does not outlive the row the customer deleted.
    expect(deleteProxy).toHaveBeenCalledWith('http://cp', 'k', 'aprx_created');
    // …and the caller is told there is nothing to test, not handed an id for a
    // row it is about to delete.
    expect(ensured).toBeUndefined();
  });

  it('CRITICAL the LOCAL write threw: the remote store SUCCEEDED, so the id is returned and no false refusal is raised', async () => {
    setProxyServerId.mockRejectedValue(new Error('tauri store write failed'));
    const ensured = await ensureAccountProxyRow(VPN, 'http://cp', 'k');
    expect(ensured).toEqual({ id: 'aprx_created', created: true, healed: false });
    // It was stored — the row must NOT be deleted, and the caller must not be
    // able to print "Couldn't store this VPN on your account".
    expect(deleteProxy).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL — the happy path records the id and deletes nothing', async () => {
    setProxyServerId.mockResolvedValue({ ...VPN, serverId: 'aprx_created' });
    const ensured = await ensureAccountProxyRow(VPN, 'http://cp', 'k');
    expect(setProxyServerId).toHaveBeenCalledWith('local-vpn', 'aprx_created');
    expect(ensured?.id).toBe('aprx_created');
    expect(deleteProxy).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL — no API key stores nothing at all (the pre-existing gate is untouched)', async () => {
    expect(await ensureAccountProxyRow(VPN, 'http://cp', null)).toBeUndefined();
    expect(createProxy).not.toHaveBeenCalled();
    expect(deleteProxy).not.toHaveBeenCalled();
  });
});

// Proxy-accuracy audit G2 (paths-04 + paths-13) — a SOCKS5 row's Driftstack
// failure disappeared. `persistServerProbe` wrote nothing for a `failed` reply
// unless the caller passed `adoptExit` (only VPN callers do), so the failure
// lived in the grid's memory until the next cache write or the next sixty-second
// tick rebuilt it from the store — "fails from Driftstack" turned back into
// "slow from Driftstack · 180ms", "~QUIC" into "✓QUIC". And once saved, the next
// native Test would have erased it (`saveProbeResult` dropped the stamp and the
// sentence; `saveExitResult` cleared them). §4.3: a fleet failure retires every
// fleet reading dated before it; this Mac's native verdict never retires a fleet
// verdict, and the fleet verdict never retires the native one; only a later
// FLEET answer lifts it.
describe('G2 — a SOCKS5 Driftstack failure is saved, and only a later Driftstack answer lifts it', () => {
  const refused = 'The proxy did not answer. Check the host and port, and that it is online.';
  const failed = (): ReturnType<typeof serverProbeOutcome> =>
    serverProbeOutcome({ ok: false, reason: refused, measured_from: 'fleet' }, NOW);
  async function failedRow(): Promise<void> {
    await saveProbeResult('p1', OK, 1);
    await saveExitResult('p1', '203.0.113.20', 'BR', { timezone: 'America/Sao_Paulo' }, 2);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 180, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true, udpProbe: true },
      3,
    );
    await persistServerProbe('p1', failed());
  }

  it('CRITICAL (a) the failure drops every Driftstack reading from before it — latency, vantage, QUIC, UDP — and keeps this Mac’s verdict and exit', async () => {
    await failedRow();
    const e = (await loadProbeCache())['p1'];
    expect(e).toMatchObject({ result: OK, at: 1, exitIp: '203.0.113.20', exitAt: 2 });
    expect(e?.fleetFailureReason).toBe(refused);
    expect(e?.exitSupersededAt).toBe(NOW);
    for (const k of [
      'serverLatencyMs',
      'measuredFrom',
      'nodeId',
      'quicProbe',
      'udpProbe',
      'serverProbeAt',
    ])
      expect(e, k).not.toHaveProperty(k);
  });

  it('CRITICAL (b) a native re-test from this Mac keeps the failure, its stamp and every retirement stamp', async () => {
    await failedRow();
    await saveProbeResult('p1', { ...OK, latency_ms: 30 }, NOW + 60_000);
    const e = (await loadProbeCache())['p1'];
    expect(e?.at).toBe(NOW + 60_000);
    expect(e?.fleetFailureReason).toBe(refused);
    expect(e?.exitSupersededAt).toBe(NOW);
  });

  it('CRITICAL (c) an exit measured from this Mac afterwards keeps the failure on a SOCKS5 row — while on a VPN row an exit seen after the failure still lifts it (control)', async () => {
    await failedRow();
    await saveExitResult('p1', '203.0.113.21', 'BR', {}, NOW + 60_000);
    const e = (await loadProbeCache())['p1'];
    expect(e?.exitIp).toBe('203.0.113.21');
    expect(e?.fleetFailureReason).toBe(refused);
    expect(e?.exitSupersededAt).toBe(NOW);

    // CONTROL — an endpoint (VPN) row: the exit is the tunnel seen up again.
    await saveEndpointResult('v1', { resolved: true, ip: '198.51.100.1', message: 'ok' }, 1);
    await persistServerProbe('v1', failed(), { adoptExit: true });
    await saveExitResult('v1', '198.51.100.9', 'NL', {}, NOW + 60_000);
    expect((await loadProbeCache())['v1']?.fleetFailureReason).toBeUndefined();
  });

  it('CRITICAL (f) a control-plane answer does not lift the failure; a Driftstack (fleet) answer does', async () => {
    await failedRow();
    await persistServerProbe(
      'p1',
      serverProbeOutcome({ ok: true, latency_ms: 50, measured_from: 'control_plane' }, NOW + 1_000),
    );
    expect((await loadProbeCache())['p1']?.fleetFailureReason).toBe(refused);
    await persistServerProbe(
      'p1',
      serverProbeOutcome(
        { ok: true, latency_ms: 40, measured_from: 'fleet', node_id: 'mac-07' },
        NOW + 2_000,
      ),
    );
    const e = (await loadProbeCache())['p1'];
    expect(e?.fleetFailureReason).toBeUndefined();
    expect(e?.serverLatencyMs).toBe(40);
  });

  // ⛔ Review major 2 — when no fleet Mac can answer, the route falls back to its
  // own SOCKS5 probe and answers `ok:false, measured_from:'control_plane'` with no
  // `not_run`. That is Driftstack's SERVER, a different machine and address from
  // the one that runs the profile (report §4.1 ranks it below the fleet), so it is
  // not Driftstack's verdict about the proxy: saved as "fails from Driftstack" it
  // retired the fleet's readings, and — since only a fleet answer lifts a fleet
  // failure (f) — a later ok from that same server could never clear it.
  // MUTATION: drop the `isServerFallbackFailure` return in persistServerProbe and
  // every arm below reds.
  it('CRITICAL (major 2) a control-plane FAILURE writes nothing — through the Test and the automatic check — and retires no fleet reading; a control-plane ok after it leaves no failure', async () => {
    await saveProbeResult('p1', OK, 1);
    await saveServerProbeResult(
      'p1',
      { latencyMs: 180, measuredFrom: 'fleet', nodeId: 'mac-07', quicProbe: true, udpProbe: true },
      3,
    );
    const before = (await loadProbeCache())['p1'];
    const cpFailed = serverProbeOutcome(
      {
        ok: false,
        reason: 'The proxy was too slow to respond. It may be overloaded — try again shortly.',
        measured_from: 'control_plane',
      },
      NOW,
    );
    expect(cpFailed.kind).toBe('failed');
    expect(await persistServerProbe('p1', cpFailed)).toBeNull();
    expect(await persistAutomaticServerProbe({ id: 'p1', scheme: 'socks5' }, cpFailed)).toBeNull();
    expect((await loadProbeCache())['p1'], 'nothing the fleet measured goes').toEqual(before);
    await persistServerProbe(
      'p1',
      serverProbeOutcome({ ok: true, latency_ms: 44, measured_from: 'control_plane' }, NOW + 1_000),
    );
    const e = (await loadProbeCache())['p1'];
    expect(e).not.toHaveProperty('fleetFailureReason');
    expect(e).not.toHaveProperty('exitSupersededAt');
    expect(e?.serverLatencyMs).toBe(44);
    expect(e?.measuredFrom).toBe('control_plane');
  });

  it('CONTROL (major 2) an UNLABELLED failure (a server from before replies named where they were measured) is not a fleet verdict either; the same failure from a fleet Mac is', async () => {
    await saveProbeResult('p1', OK, 1);
    expect(await persistServerProbe('p1', { kind: 'failed', at: NOW, reason: 'no' })).toBeNull();
    expect((await loadProbeCache())['p1']).toEqual({ result: OK, at: 1 });
    expect(await persistServerProbe('p1', failed())).not.toBeNull();
    expect((await loadProbeCache())['p1']?.fleetFailureReason).toBe(refused);
  });

  it('the automatic check writes a failure only onto a row that already holds a Driftstack answer — a timer never paints one on a row nobody asked Driftstack about', async () => {
    await saveProbeResult('p1', OK, 1);
    expect(await persistAutomaticServerProbe({ id: 'p1', scheme: 'socks5' }, failed())).toBeNull();
    expect((await loadProbeCache())['p1']).not.toHaveProperty('fleetFailureReason');
    await saveServerProbeResult('p1', { latencyMs: 40, measuredFrom: 'fleet' }, 3);
    await persistAutomaticServerProbe({ id: 'p1', scheme: 'socks5' }, failed());
    expect((await loadProbeCache())['p1']?.fleetFailureReason).toBe(refused);
  });

  it('a reading Driftstack stored BEFORE the failure is refused by the next list sync on this Mac (retire-older-readings)', async () => {
    await failedRow();
    const prior = (await loadProbeCache())['p1'];
    expect(
      serverCapabilityReadingsToAdopt(prior, {
        quicProbe: { value: true, at: NOW - 1 },
        udpProbe: { value: true, at: NOW - 1 },
      }),
    ).toEqual({});
    expect(
      serverCapabilityReadingsToAdopt(prior, { quicProbe: { value: true, at: NOW + 1 } }),
    ).toEqual({ quicProbe: { value: true, at: NOW + 1 } });
  });
});
