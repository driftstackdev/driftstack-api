// (p) 2026-09-16 — the OS reading a DIFFERENT machine took.
//
// The control plane is the only thing that can fingerprint a proxy's own stack:
// it reads the SYN the proxy's kernel sent to our observer, and no Mac can read
// that for itself. It has stored the reading on the row since N-2 — and this
// client fed its chip from the local probe cache alone, so the reading existed
// only on the Mac that ran the test. A second machine, or the same machine after
// a reinstall, showed "OS not measured yet. Run Test on this proxy." about a
// proxy Driftstack had already fingerprinted. That is the owner's "we are not
// saving the OS fingerprint of already checked proxies".
//
// The arms below are the four the item asks for, plus the three that keep the
// seeded entry from lying about anything else:
//   1. a list row with a stored reading populates the chip with NO local cache;
//   2. a stored reading older than the TTL does not — ONE freshness rule, the
//      same function that ages a local reading, applied to the server's stamp;
//   3. a fresh observation overrides a stored one, and a stored one carried on a
//      /test reply is dated by the MEASUREMENT, never by the reply;
//   4. the invented entry is not a verdict: no test result, no "Tested" stamp,
//      no sweep, and the mark that makes all three true survives a reload.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

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

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: () => Promise.resolve(nextResponse()),
}));

import { ProxyOsChip } from '../../src/components/ProxyCapabilities';
import { listProxies, testAccountProxy } from '../../src/lib/account-proxies';
import { OS_FINGERPRINT_TTL_MS, osFingerprintVerdict } from '../../src/lib/os-fingerprint-verdict';
import {
  deriveProbeViewState,
  loadProbeCache,
  saveOsFingerprint,
  saveProbeResult,
  verdictMatchesScheme,
  type ProbeCacheMap,
} from '../../src/lib/proxy-probe-cache';
import { planSweep } from '../../src/lib/proxy-probe-sweeper';
import {
  adoptListOsFingerprint,
  chipOsFingerprint,
  persistServerProbe,
  serverProbeOutcome,
  type ListOsRow,
} from '../../src/lib/proxy-server-test';
import type { ProxyConfig } from '../../src/lib/proxies';
import { proxyHealthPercent } from '../../src/views/ProfilesView';

const NOW = 1_800_000_000_000;
const MEASURED_AT = new Date(NOW - 10 * 60_000).toISOString(); // ten minutes ago
const MEASURED_AT_MS = Date.parse(MEASURED_AT);

/** The wire shape the LIST and the /test reply both carry (one schema server-side). */
const WIRE_READING = {
  os: 'macos-or-ios',
  confidence: 'high',
  reason: 'Based on how this proxy responds to a network connection.',
  observed_ip: '198.51.100.7',
  observed_via: 'exit_ip',
  single_host_vantage: true,
  web_port_vantage: true,
};

const LIST_META = {
  label: 'eu-socks',
  scheme: 'socks5' as const,
  host: 'proxy.example.com',
  port: 1080,
  username: null,
  has_password: true,
  quic_measured: null,
  quic_measured_at: null,
  created_at: '2026-06-16T00:00:00.000Z',
  updated_at: '2026-06-16T00:00:00.000Z',
};

const SOCKS: ProxyConfig = {
  id: 'socks1',
  label: 'eu-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
  serverId: 'aprx_socks',
};

const listRow = (over: Partial<ListOsRow> = {}): ListOsRow => ({
  id: 'aprx_socks',
  os_fingerprint: {
    os: 'macos-or-ios',
    confidence: 'high',
    reason: WIRE_READING.reason,
    observedVia: 'exit_ip',
    singleHostVantage: true,
    webPortVantage: true,
  },
  os_fingerprint_at: MEASURED_AT,
  ...over,
});

const OK_RESULT = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  stores.clear();
  nextResponse = () => new Response('{}', { status: 500 });
});

describe('the list carries the reading, and the parser keeps one shape for both routes', () => {
  it('parses `os_fingerprint` with the SAME allowlist the /test reply uses — the vantage flags survive, and a value outside the closed set becomes null rather than a renderable OS', async () => {
    nextResponse = () =>
      json({
        data: [
          {
            ...LIST_META,
            id: 'aprx_socks',
            os_fingerprint: WIRE_READING,
            os_fingerprint_at: MEASURED_AT,
          },
          {
            ...LIST_META,
            id: 'aprx_bad',
            os_fingerprint: { ...WIRE_READING, os: 'plan9' },
            os_fingerprint_at: MEASURED_AT,
          },
          { ...LIST_META, id: 'aprx_old' },
        ],
      });
    const rows = await listProxies('https://api.example', 'k');
    expect(rows[0]?.os_fingerprint).toEqual({
      os: 'macos-or-ios',
      confidence: 'high',
      reason: WIRE_READING.reason,
      observedVia: 'exit_ip',
      singleHostVantage: true,
      webPortVantage: true,
    });
    expect(rows[0]?.os_fingerprint_at).toBe(MEASURED_AT);
    // A reading this build cannot render is this row's "never measured".
    expect(rows[1]?.os_fingerprint).toBeNull();
    // An older server sends neither key; absent stays absent, which is a
    // different fact from "the server says there is none".
    expect('os_fingerprint' in (rows[2] ?? {})).toBe(false);
  });
});

describe('a reading measured on another Mac reaches this one', () => {
  it('CRITICAL populates the chip with NO local cache entry at all — the second-Mac and post-reinstall case, which is the whole item. MUTATION: in seedServerOsFingerprint (proxy-probe-cache.ts) replace `prior ?? {…serverSeeded: true}` with `prior` and return early when it is undefined, or drop the `|| c.serverSeeded === true` disjunct in deriveProbeViewState — either reds this arm', async () => {
    expect(await loadProbeCache()).toEqual({});

    expect(await adoptListOsFingerprint([listRow()], [SOCKS], NOW)).toEqual(['socks1']);

    const view = deriveProbeViewState(await loadProbeCache(), NOW);
    const reading = view.osFingerprints.socks1;
    expect(reading?.os).toBe('macos-or-ios');
    // ⛔ Dated by the SERVER's stamp, not by the adoption — that is what lets the
    // one TTL age it honestly on this machine.
    expect(reading?.at).toBe(MEASURED_AT_MS);

    const { container } = render(<ProxyOsChip fingerprint={reading} nowMs={NOW} />);
    const chip = container.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(chip?.getAttribute('data-os-tone')).toBe('match');
    expect(chip?.textContent).toContain('iOS/macOS');
    // (d) — the chip says WHERE the number came from and HOW OLD it is, in plain
    // words: no vantage names, no mention of a list, a cache or another machine.
    expect(chip?.getAttribute('title')).toContain('Measured by Driftstack, 10 minutes ago.');
  });

  it('CRITICAL does NOT populate it from a reading older than the TTL — one freshness rule, the server’s stamp judged by the same function that ages a local reading, so a stale stored reading is hidden exactly as a stale local one is', async () => {
    const stale = new Date(NOW - OS_FINGERPRINT_TTL_MS - 60_000).toISOString();

    expect(
      await adoptListOsFingerprint([listRow({ os_fingerprint_at: stale })], [SOCKS], NOW),
    ).toEqual([]);
    // Nothing was invented either: a stale reading leaves no trace to re-render.
    expect(await loadProbeCache()).toEqual({});

    const view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(view.osFingerprints.socks1).toBeUndefined();
    const { container } = render(<ProxyOsChip fingerprint={undefined} nowMs={NOW} />);
    expect(
      container.querySelector('[data-component="proxy-os-fingerprint"]')?.getAttribute('title'),
    ).toBe('OS not measured yet. Run Test on this proxy.');
  });

  it('refuses a reading the server cannot DATE — an undatable reading cannot be aged, and the one thing it must never do is render as current', async () => {
    expect(
      await adoptListOsFingerprint([listRow({ os_fingerprint_at: null })], [SOCKS], NOW),
    ).toEqual([]);
    expect(
      await adoptListOsFingerprint([listRow({ os_fingerprint_at: 'not a date' })], [SOCKS], NOW),
    ).toEqual([]);
    expect(await loadProbeCache()).toEqual({});
  });

  it('never REWINDS: a reading measured on THIS Mac more recently outranks the list’s older copy, and re-adopting the same one writes nothing (a poll must not rewrite the store every tick)', async () => {
    await saveProbeResult('socks1', OK_RESULT, NOW - 60_000);
    await saveOsFingerprint(
      'socks1',
      { os: 'windows', confidence: 'high', reason: 'local', singleHostVantage: true },
      NOW - 60_000,
    );

    // The list's copy is ten minutes old; the local one is one minute old.
    expect(await adoptListOsFingerprint([listRow()], [SOCKS], NOW)).toEqual([]);
    expect((await loadProbeCache()).socks1?.osFingerprint?.os).toBe('windows');

    // A NEWER server reading is adopted, and adopting it twice is a no-op.
    const newer = new Date(NOW - 30_000).toISOString();
    expect(
      await adoptListOsFingerprint([listRow({ os_fingerprint_at: newer })], [SOCKS], NOW),
    ).toEqual(['socks1']);
    expect((await loadProbeCache()).socks1?.osFingerprint?.os).toBe('macos-or-ios');
    expect(
      await adoptListOsFingerprint([listRow({ os_fingerprint_at: newer })], [SOCKS], NOW),
    ).toEqual([]);
  });

  it('CONTROL — adopts nothing for a proxy that is not synced to the server, and nothing for a row the server holds no reading for', async () => {
    const { serverId: _dropped, ...unsynced } = SOCKS;
    expect(await adoptListOsFingerprint([listRow()], [unsynced], NOW)).toEqual([]);
    expect(await adoptListOsFingerprint([listRow({ os_fingerprint: null })], [SOCKS], NOW)).toEqual(
      [],
    );
    expect(await loadProbeCache()).toEqual({});
  });
});

describe('a fresh observation beats a stored one, and a stored one is dated by its measurement', () => {
  it('CRITICAL a /test that measured a reading overrides the stored one this Mac adopted, dated by the reply', async () => {
    await adoptListOsFingerprint([listRow()], [SOCKS], NOW);
    nextResponse = () =>
      json({ ok: true, latency_ms: 12, os_fingerprint: { ...WIRE_READING, os: 'linux' } });

    const outcome = serverProbeOutcome(
      await testAccountProxy('https://api.example', 'k', 'aprx_socks'),
      NOW,
    );
    expect(outcome.kind).toBe('ok');
    await persistServerProbe('socks1', outcome);

    const entry = (await loadProbeCache()).socks1;
    expect(entry?.osFingerprint?.os).toBe('linux');
    expect(entry?.osFingerprint?.at).toBe(NOW);
  });

  it('CRITICAL a /test that observed NOTHING carries the row’s stored reading WITH its date and the cause beside it — and the cache is stamped with the MEASUREMENT, so the reading ages from when it was taken rather than looking measured just now. MUTATION: in persistServerProbe (proxy-server-test.ts) pass `outcome.at` instead of `outcome.osFingerprintAt ?? outcome.at` and this reds', async () => {
    nextResponse = () =>
      json({
        ok: true,
        latency_ms: 12,
        os_fingerprint: WIRE_READING,
        os_fingerprint_at: MEASURED_AT,
        os_fingerprint_unavailable: 'not_observed',
      });

    const reply = await testAccountProxy('https://api.example', 'k', 'aprx_socks');
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error('unreachable');
    // The reading and the cause arrive together; the reading wins the chip and
    // the cause explains the test.
    expect(reply.os_fingerprint?.os).toBe('macos-or-ios');
    expect(reply.os_fingerprint_at).toBe(MEASURED_AT);
    expect(reply.os_fingerprint_unavailable).toBe('not_observed');

    await saveProbeResult('socks1', OK_RESULT, NOW);
    await persistServerProbe('socks1', serverProbeOutcome(reply, NOW));
    expect((await loadProbeCache()).socks1?.osFingerprint?.at).toBe(MEASURED_AT_MS);

    // …and the chip therefore states the real age, not "just now".
    const view = deriveProbeViewState(await loadProbeCache(), NOW);
    expect(osFingerprintVerdict(view.osFingerprints.socks1, NOW).hint).toContain(
      'Measured by Driftstack, 10 minutes ago.',
    );
  });
});

describe('the invented entry asserts nothing it did not measure', () => {
  it('CRITICAL is not a verdict: no test result, no "Tested" stamp, no auto-probe skip and no unasked sweep — an entry we wrote ourselves must never read as a red pill on a proxy nobody here has tested. MUTATION: delete `serverSeeded: true` from the entry seedServerOsFingerprint invents and every arm here reds', async () => {
    await adoptListOsFingerprint([listRow()], [SOCKS], NOW);
    const cache: ProbeCacheMap = await loadProbeCache();
    const entry = cache.socks1;
    expect(entry?.serverSeeded).toBe(true);

    const view = deriveProbeViewState(cache, NOW);
    expect(view.testResults.socks1, 'no verdict this Mac did not measure').toBeUndefined();
    expect(view.testedAt.socks1, 'no "Tested …" stamp for a check that never ran').toBeUndefined();
    // The auto-probe must still run: nothing here has checked this proxy.
    expect(verdictMatchesScheme(true, entry!)).toBe(false);
    // And the background sweep must not spend a real handshake on it unasked.
    expect(planSweep(cache, [SOCKS], NOW + 7 * 60 * 60_000)).toEqual([]);
  });

  it('CRITICAL the mark survives a reload — dropped by the load-path allowlist, the placeholder comes back as an ordinary SOCKS5 verdict and the row goes red on the next app start. MUTATION: remove `serverSeeded` from cleanEntry (proxy-probe-cache.ts) and this reds', async () => {
    await adoptListOsFingerprint([listRow()], [SOCKS], NOW);
    // A second load is a full round-trip through the store's cleaner.
    const reloaded = await loadProbeCache();
    expect(reloaded.socks1?.serverSeeded).toBe(true);
    expect(deriveProbeViewState(reloaded, NOW).testResults.socks1).toBeUndefined();
    expect(deriveProbeViewState(reloaded, NOW).osFingerprints.socks1?.os).toBe('macos-or-ios');
  });

  it('a real local verdict REPLACES the seeded entry — the row is tested from then on, and the reading it carried survives the promotion', async () => {
    await adoptListOsFingerprint([listRow()], [SOCKS], NOW);
    await saveProbeResult('socks1', OK_RESULT, NOW);

    const cache = await loadProbeCache();
    expect(cache.socks1?.serverSeeded).toBeUndefined();
    const view = deriveProbeViewState(cache, NOW);
    expect(view.testResults.socks1?.reachable).toBe(true);
    expect(view.testedAt.socks1).toBe(NOW);
    expect(view.osFingerprints.socks1?.os).toBe('macos-or-ios');
  });
});

describe('the seeded entry does not reach the surfaces that count PROBES', () => {
  // (p) review — the Profiles hero reads the RAW cache map to tally "proxy
  // health": `probed = proxies.filter(cached !== undefined)`, `ok = …reachable`.
  // The seeded entry is an entry, and its placeholder `result` is unreachable, so
  // a Mac that has tested NOTHING went from "proxy health untested" to a green
  // "0.0% proxy health" — a failure rate invented entirely from entries this Mac
  // wrote itself, about proxies nobody here has checked.
  //
  // MUTATION: in `proxyHealthPercent` (views/ProfilesView.tsx) drop the
  // `c.serverSeeded !== true` term and this arm reds with 0.
  it('CRITICAL the hero still says "untested" when every entry is server-seeded — a reading is not a probe, and a tally must never invent a failure rate from one', async () => {
    await adoptListOsFingerprint([listRow()], [SOCKS], NOW);
    const cache = await loadProbeCache();
    expect(cache.socks1?.serverSeeded, 'the state this arm is about').toBe(true);

    expect(proxyHealthPercent([SOCKS], cache)).toBeNull();

    // VACUITY CONTROL — a REAL verdict is still counted, both ways round, so the
    // exclusion cannot be "return null and be done".
    await saveProbeResult('socks1', OK_RESULT, NOW);
    expect(proxyHealthPercent([SOCKS], await loadProbeCache())).toBe(100);
    await saveProbeResult('socks1', { ...OK_RESULT, reachable: false }, NOW);
    expect(proxyHealthPercent([SOCKS], await loadProbeCache())).toBe(0);
  });
});

describe('the grid’s in-memory copy is dated and aged exactly like the cache write', () => {
  const reply = (osFingerprintAt: string) =>
    serverProbeOutcome(
      {
        ok: true,
        latency_ms: 12,
        os_fingerprint: {
          os: 'macos-or-ios',
          confidence: 'high',
          reason: WIRE_READING.reason,
          observedVia: 'exit_ip',
          singleHostVantage: true,
          webPortVantage: true,
        },
        os_fingerprint_at: osFingerprintAt,
        os_fingerprint_unavailable: 'not_observed',
      } as never,
      NOW,
    );

  // (p) review — `applyServerProbeOutcome` stamped the chip's copy with the REPLY
  // time and applied no TTL, while the cache write beside it used the measurement
  // date and the derivation aged it. The server attaches a stored reading with NO
  // age bound (`storedOsForReply` checks only that the row can be dated), so a
  // week-old reading rendered a full green chip saying "Measured by Driftstack,
  // just now" — and blanked a moment later when the cache emit landed. One helper
  // now, so the two cannot disagree.
  //
  // MUTATION: in `chipOsFingerprint` (lib/proxy-server-test.ts) use `outcome.at`
  // in place of `outcome.osFingerprintAt ?? outcome.at` and the first arm reds
  // (the reading is dated "just now"); drop the `isOsFingerprintFresh` gate and
  // the second reds (a stale reading reaches the chip as current).
  it('CRITICAL dates a STORED reading by its measurement, so the chip states the real age instead of "just now"', () => {
    const rec = chipOsFingerprint(reply(MEASURED_AT), NOW);
    expect(rec?.at).toBe(MEASURED_AT_MS);
    expect(osFingerprintVerdict(rec, NOW).hint).toContain(
      'Measured by Driftstack, 10 minutes ago.',
    );
  });

  it('CRITICAL shows NOTHING for a stored reading past the TTL — the same rule the emit a moment later applies, so no false green is ever presented as current', () => {
    const stale = new Date(NOW - OS_FINGERPRINT_TTL_MS - 60_000).toISOString();
    expect(chipOsFingerprint(reply(stale), NOW)).toBeUndefined();
  });

  it('CONTROL — a FRESH observation (no date on the wire) is dated by the reply, and a reply with no reading at all yields nothing to show', () => {
    const fresh = serverProbeOutcome(
      { ok: true, latency_ms: 12, os_fingerprint: WIRE_READING } as never,
      NOW,
    );
    expect(chipOsFingerprint(fresh, NOW)?.at).toBe(NOW);
    expect(
      chipOsFingerprint(serverProbeOutcome({ ok: true, latency_ms: 12 } as never, NOW), NOW),
    ).toBeUndefined();
  });
});
