// (o) O3 + O4 — "absent" must carry its CAUSE, and "measuring" must carry its PROBE.
//
// MEASURED before this: `'host' in resolved` is false for every openvpn/wireguard row
// (an `InlineVpnProxyWire` has no `host` key), so the control plane's `osFields` was `{}`
// unconditionally on a VPN row. The desktop rendered that absence through the ONE
// neutral branch of `osFingerprintVerdict`, whose hint reads "Run Test on a proxy that is
// stored on your account; the control plane fingerprints the proxy's own TCP stack" — an
// instruction that can never produce a value for that row. The owner pressed Test, saw
// the same blank "— OS" chip, and pressed it again.
//
// The server now reports WHY (`os_fingerprint_unavailable`, a closed set of three). These
// arms pin the client half end to end: the wire parse mints the placeholder the cause
// rides on, the cache preserves it across a reload, and the verdict turns each cause into
// a sentence that is TRUE for it — with "Run Test" surviving in exactly one member.
//
// ⛔ PRODUCTION LINES WHOSE REVERSION REDS THESE ARMS:
//   • os-fingerprint-verdict.ts `if (fp?.unavailable !== undefined)` — delete it and every
//     cause falls through to the `os === 'unknown'` branch: glyph '?' and "could not be
//     determined" (we looked and failed) instead of glyph '—' and the cause. Arms 1-3 red.
//   • os-fingerprint-verdict.ts `if (fp?.measuring === true)` — delete it and the
//     in-flight sentinel renders as "could not be determined". Arm 7 reds.
//   • account-proxies.ts `?? (fpUnavailable !== undefined ? unavailableOsFingerprint(…))`
//     — revert to the bare `cleanWireFingerprint(body.os_fingerprint)` and the cause never
//     leaves the parser: the row is `undefined` again and shows the dead-end hint. Arm 4 reds.
//   • proxy-probe-cache.ts `...(unavailable !== undefined ? { unavailable } : {})` in
//     `cleanOsFingerprint` — drop it and the cause dies at the next app start (that
//     allowlist is the only way a field survives a load). Arm 5 reds.
//   • ProxiesView.tsx / ProfilePhoneCard.tsx `testing ? OS_FINGERPRINT_MEASURING :
//     undefined` — replace with a bare `OS_FINGERPRINT_MEASURING` and a row with no probe
//     in flight claims work nobody is doing. The VACUITY CONTROL (arm 8) reds.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import {
  osFingerprintVerdict,
  unavailableOsFingerprint,
  isOsFingerprintUnavailable,
  OS_FINGERPRINT_MEASURING,
  type OsFingerprint,
} from '../../src/lib/os-fingerprint-verdict';
import { ProxyOsChip } from '../../src/components/ProxyCapabilities';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import { testAccountProxy } from '../../src/lib/account-proxies';
import {
  loadProbeCache,
  saveOsFingerprint,
  saveProbeResult,
} from '../../src/lib/proxy-probe-cache';

const REAL: OsFingerprint = { os: 'macos-or-ios', confidence: 'high', reason: 'TTL 64, MSS 1460' };

const OK_PROBE = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

function replyOk(over: Record<string, unknown>): void {
  nextResponse = () =>
    new Response(JSON.stringify({ ok: true, latency_ms: 42, ...over }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function chip(): Element {
  const el = document.querySelector('[data-component="proxy-os-fingerprint"]');
  if (el === null) throw new Error('chip did not render');
  return el;
}

beforeEach(() => {
  stores.clear();
});

describe('(o) O3 — the chip says WHY there is no fingerprint', () => {
  it('ARM 1 — a VPN tunnel says a tunnel has no stack to fingerprint, and does NOT tell the customer to run Test', () => {
    const v = osFingerprintVerdict(unavailableOsFingerprint('vpn_tunnel'));
    expect(v.tone).toBe('unknown');
    // '—' (nothing was measured), never '?' (measured and undetermined).
    expect(v.glyph).toBe('—');
    expect(v.hint).toMatch(/VPN tunnel/i);
    expect(v.hint).toMatch(/no SOCKS5 proxy stack/i);
    expect(v.hint).toMatch(/No test can produce one/i);
    // ⛔ the whole point of the item: no dead-end instruction.
    expect(v.hint).not.toMatch(/Run Test/i);
  });

  it('ARM 2 — an observer that is switched off says so, and does NOT tell the customer to run Test', () => {
    const v = osFingerprintVerdict(unavailableOsFingerprint('observer_off'));
    expect(v.glyph).toBe('—');
    expect(v.hint).toMatch(/switched off on this deployment/i);
    expect(v.hint).not.toMatch(/Run Test/i);
  });

  it('ARM 3 — CONTROL on the copy rule: `not_observed` is the ONE cause a retry can clear, so it is the ONE that still says "Run Test"', () => {
    // A blanket "never say Run Test" would satisfy arms 1-2 and be wrong here: this
    // proxy refused the observer connection, and a refusal can be transient.
    const v = osFingerprintVerdict(unavailableOsFingerprint('not_observed'));
    expect(v.glyph).toBe('—');
    expect(v.hint).toMatch(/refused the connection/i);
    expect(v.hint).toMatch(/Run Test again/i);
  });

  it('ARM 4 — the cause travels from the wire to the chip: a VPN row with no os_fingerprint renders the tunnel sentence', async () => {
    replyOk({ os_fingerprint_unavailable: 'vpn_tunnel' });
    const res = await testAccountProxy('http://x', 'k', 'p_vpn');
    if (!res.ok) throw new Error('fixture is an ok reply');
    expect(res.os_fingerprint_unavailable).toBe('vpn_tunnel');
    expect(res.os_fingerprint?.unavailable).toBe('vpn_tunnel');

    render(<ProxyOsChip fingerprint={res.os_fingerprint} size="xs" />);
    expect(chip().getAttribute('title')).toMatch(/VPN tunnel/i);
    // Never green, never red — an unmeasurable row is neutral.
    expect(chip().getAttribute('data-verdict')).toBe('unknown');
  });

  it('ARM 5 — the cause survives a reload through the REAL cache: a stored placeholder still renders its sentence, not a bare "undetermined"', async () => {
    await saveProbeResult('p_off', OK_PROBE, 1_700_000_000_000);
    await saveOsFingerprint('p_off', unavailableOsFingerprint('observer_off'), 1_700_000_000_001);

    // loadProbeCache re-reads the raw store through `cleanEntry`/`cleanOsFingerprint`,
    // which is exactly the hop a fresh app start makes.
    const reloaded = (await loadProbeCache()).p_off?.osFingerprint;
    expect(reloaded?.unavailable).toBe('observer_off');
    expect(osFingerprintVerdict(reloaded).hint).toMatch(/switched off on this deployment/i);
  });

  it('ARM 6 — CONTROL: a cause from a NEWER server is dropped, never rendered as a cause this build cannot state truthfully', async () => {
    expect(isOsFingerprintUnavailable('captive_portal')).toBe(false);
    replyOk({ os_fingerprint_unavailable: 'captive_portal' });
    const res = await testAccountProxy('http://x', 'k', 'p_new');
    if (!res.ok) throw new Error('fixture is an ok reply');
    expect(res.os_fingerprint_unavailable).toBeUndefined();
    expect(res.os_fingerprint).toBeUndefined();
    // Falls back to today's neutral wording, which is still true of it.
    expect(osFingerprintVerdict(undefined).hint).toMatch(/Stack OS not measured/i);
  });

  it('CRITICAL VACUITY CONTROL — a REAL reading is untouched: it keeps the green match and carries no cause sentence', async () => {
    // The failure this item could introduce is the mirror image of the one it fixes:
    // every row wearing an "unavailable" sentence. This arm fails in that direction.
    replyOk({ os_fingerprint: REAL });
    const res = await testAccountProxy('http://x', 'k', 'p_socks');
    if (!res.ok) throw new Error('fixture is an ok reply');
    expect(res.os_fingerprint_unavailable).toBeUndefined();
    expect(res.os_fingerprint?.unavailable).toBeUndefined();

    const v = osFingerprintVerdict(res.os_fingerprint);
    expect(v.tone).toBe('match');
    expect(v.glyph).toBe('✓');
    expect(v.hint).not.toMatch(/not measured/i);
    expect(v.hint).not.toMatch(/VPN tunnel/i);
  });

  it('CONTROL — a server that sends BOTH a reading and a cause is believed about the READING: a cause explains an absence, and there is none', async () => {
    replyOk({ os_fingerprint: REAL, os_fingerprint_unavailable: 'not_observed' });
    const res = await testAccountProxy('http://x', 'k', 'p_both');
    if (!res.ok) throw new Error('fixture is an ok reply');
    expect(res.os_fingerprint?.unavailable).toBeUndefined();
    expect(osFingerprintVerdict(res.os_fingerprint).tone).toBe('match');
  });
});

describe('(o) O4 — "measuring" is rendered from a running probe and from nothing else', () => {
  it('ARM 7 — CONTROL: while a probe THIS client started is in flight, the chip does say it', () => {
    render(<ProxyOsChip fingerprint={OS_FINGERPRINT_MEASURING} size="xs" />);
    expect(chip().getAttribute('title')).toMatch(/Measuring this proxy’s stack/i);
    expect(osFingerprintVerdict(OS_FINGERPRINT_MEASURING).glyph).toBe('…');
  });

  it('ARM 8 — CRITICAL VACUITY CONTROL: with no probe in flight and no fingerprint, the word "measuring" appears NOWHERE', () => {
    // `observeOs` has exactly one call site — the customer-initiated Test. Nothing
    // schedules it, so a proxy that claimed to be "measuring…" forever was asserting
    // work nobody was doing. The hint must say it is NOT measured, and name what would.
    render(<ProxyOsChip fingerprint={undefined} size="xs" />);
    expect(chip().textContent ?? '').not.toMatch(/measuring/i);
    expect(chip().getAttribute('title') ?? '').not.toMatch(/measuring/i);
    expect(chip().getAttribute('title')).toMatch(/not measured/i);
    expect(chip().getAttribute('title')).toMatch(/Run Test/i);
    expect(screen.queryByText(/measuring/i)).toBeNull();
  });

  it('ARM 9 — the in-flight sentinel is a UI state, never a reported cause, and the two can never be confused', () => {
    expect(OS_FINGERPRINT_MEASURING.unavailable).toBeUndefined();
    expect(unavailableOsFingerprint('vpn_tunnel').measuring).toBeUndefined();
  });
});

// The arms above drive the chip directly, so they pin the VERDICT. These drive the
// CARD, which is where the choice of input is made: `p.testing ?
// OS_FINGERPRINT_MEASURING : undefined` in ProfilePhoneCard.tsx. Mutate that to a bare
// `OS_FINGERPRINT_MEASURING` and arm 11 reds; delete the sentinel entirely and arm 10 reds.
describe('(o) O4 — the profile card only claims to be measuring while its own Test runs', () => {
  function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
    return {
      name: 'amsterdam shopper',
      monogram: 'AS',
      hue: 200,
      deviceLabel: 'iPhone 17',
      running: false,
      selected: false,
      lastUsedIso: null,
      folder: '',
      tags: [],
      hasProxy: true,
      proxyExplicit: true,
      flag: '🇳🇱',
      countryCode: 'NL',
      exitIp: '82.14.220.9',
      latencyMs: 42,
      latencyFillPct: 30,
      latencyGood: true,
      probed: true,
      capabilities: { ...OK_PROBE },
      checkedAtIso: null,
      busy: false,
      launching: false,
      anyBusy: false,
      testing: false,
      testDisabled: false,
      launchDisabled: false,
      onToggleSelect: vi.fn(),
      onPrimary: vi.fn(),
      onWatch: vi.fn(),
      onTest: vi.fn(),
      ...over,
    };
  }

  it('ARM 10 — CONTROL: while the card’s own Test is in flight, the OS chip says it is measuring', () => {
    render(<ProfilePhoneCard {...cardProps({ testing: true })} />);
    expect(chip().getAttribute('title')).toMatch(/Measuring this proxy’s stack/i);
  });

  it('ARM 11 — CRITICAL VACUITY CONTROL: with no Test in flight the card says NOT measured, never "measuring"', () => {
    render(<ProfilePhoneCard {...cardProps({ testing: false })} />);
    expect(chip().getAttribute('title') ?? '').not.toMatch(/measuring/i);
    expect(chip().getAttribute('title')).toMatch(/not measured/i);
  });

  it('ARM 12 — CONTROL: a real reading is never clobbered by the sentinel, even mid-test', () => {
    render(<ProfilePhoneCard {...cardProps({ testing: true, osFingerprint: REAL })} />);
    expect(chip().getAttribute('data-verdict')).toBe('match');
    expect(chip().getAttribute('title') ?? '').not.toMatch(/measuring/i);
  });

  // ⛔ 2026-09-11 — arms 10-12 left the VPN population wearing the defect they close.
  // `p.testing` is set for the "Check VPN" button too (ProfilesView passes the same
  // flag for every scheme), and NOTHING fingerprints a tunnel: the control plane has
  // no SOCKS5 endpoint to dial, so its reply says `os_fingerprint_unavailable:
  // 'vpn_tunnel'`. The card therefore claimed a stack measurement was running for the
  // whole 30-45 s fleet wait and then said none can exist — the same false in-progress
  // claim O4 is about, on a whole class of rows.
  //
  // ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARM 13: ProfilePhoneCard's
  //    `p.vpn === true ? VPN_TUNNEL_OS_FINGERPRINT : p.testing ? …`. Restore the bare
  //    `p.testing ? OS_FINGERPRINT_MEASURING : undefined` and arm 13 reds. Widen it to
  //    every row (drop the `p.vpn === true` test) and arm 10 reds — a socks5 card with
  //    a Test genuinely in flight would stop saying so.
  it('ARM 13 — CRITICAL: a VPN card with its own Check in flight says why a tunnel has no fingerprint, never that one is being measured', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true, testing: true })} />);
    const title = chip().getAttribute('title') ?? '';
    expect(title).not.toMatch(/measuring/i);
    expect(title).toMatch(/VPN tunnel/i);
    expect(title).toMatch(/No test can produce one here/i);
    expect(title).not.toMatch(/Run Test/i);
  });

  it('ARM 14 — a VPN card that has never been checked carries the same cause — the chip was blank under the dead-end hint before any reply existed', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true, testing: false })} />);
    expect(chip().getAttribute('title') ?? '').toMatch(/VPN tunnel/i);
    expect(chip().getAttribute('data-verdict')).toBe('unknown');
  });

  it('ARM 15 — CONTROL: the scheme-derived cause is a FALLBACK — a reading the server did send still wins on a VPN card', () => {
    render(<ProfilePhoneCard {...cardProps({ vpn: true, osFingerprint: REAL })} />);
    expect(chip().getAttribute('data-verdict')).toBe('match');
    expect(chip().getAttribute('title') ?? '').not.toMatch(/VPN tunnel/i);
  });
});
