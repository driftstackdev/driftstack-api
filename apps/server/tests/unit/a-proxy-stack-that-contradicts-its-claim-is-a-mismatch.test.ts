// Passive OS fingerprinting of a proxy's own TCP/IP stack (owner item N-2).
//
// A SOCKS5 proxy opens its OWN connection to the destination, so the SYN we
// observe was built by the PROXY HOST's kernel. A proxy sold as a residential
// iPhone whose stack says Linux is not what it claims, and that is the whole
// point of the column: RED on mismatch, GREEN when a Darwin stack backs a
// macOS/iOS claim.
//
// The signatures below are the real p0f-family discriminators, not invented
// ones. The load-bearing one is OPTION ORDER: Darwin emits window-scale before
// SACK-permitted, Linux emits SACK-permitted before window-scale, and that
// holds even when the numeric values are tuned.
//
// ⛔ THE ARM THAT MATTERS MOST is the last group: "unknown" must never collapse
// into "match". A cell an operator reads as green when we could not actually
// tell is the absent-data-as-fact bug wearing a UI.

import { describe, it, expect } from 'vitest';
import {
  fingerprintOs,
  initialTtl,
  compareOsToClaim,
  type TcpSynSignature,
} from '../../src/lib/tcp-os-fingerprint.js';

/** MSS, SACK-permitted, timestamps, NOP, window-scale — the Linux layout. */
const LINUX: TcpSynSignature = {
  ttl: 64,
  windowSize: 64240,
  mss: 1460,
  windowScale: 7,
  optionOrder: [2, 4, 8, 1, 3],
  df: true,
};

/** MSS, NOP, window-scale, NOP, NOP, timestamps, SACK-permitted, EOL — Darwin. */
const DARWIN: TcpSynSignature = {
  ttl: 64,
  windowSize: 65535,
  mss: 1460,
  windowScale: 6,
  optionOrder: [2, 1, 3, 1, 1, 8, 4, 0],
  df: true,
};

/** MSS, NOP, window-scale, NOP, NOP, SACK-permitted — no timestamps. */
const WINDOWS: TcpSynSignature = {
  ttl: 128,
  windowSize: 64240,
  mss: 1460,
  windowScale: 8,
  optionOrder: [2, 1, 3, 1, 1, 4],
  df: true,
};

describe('TTL is rounded up to the value the sender started from', () => {
  it('accounts for hops', () => {
    // A proxy is never 0 hops away, so the observed TTL is always below the
    // initial one. 54 came from 64, not from "some stack that starts at 54".
    expect(initialTtl(64)).toBe(64);
    expect(initialTtl(54)).toBe(64);
    expect(initialTtl(128)).toBe(128);
    expect(initialTtl(115)).toBe(128);
    expect(initialTtl(243)).toBe(255);
  });

  it('rejects a TTL implying an absurd hop count', () => {
    // 3 would need 61 hops from 64 — possible in theory, but by then the value
    // carries no information and a guess would be worse than a blank.
    expect(initialTtl(3)).toBeNull();
    expect(initialTtl(0)).toBeNull();
  });
});

describe('the three families separate on real signatures', () => {
  it('identifies Darwin, and that is the GREEN case', () => {
    const r = fingerprintOs(DARWIN);
    expect(r.os).toBe('macos-or-ios');
    expect(r.confidence).toBe('high');
  });

  it('identifies Linux', () => {
    const r = fingerprintOs(LINUX);
    expect(r.os).toBe('linux');
    expect(r.confidence).toBe('high');
  });

  it('identifies Windows from TTL 128 with no timestamps', () => {
    const r = fingerprintOs(WINDOWS);
    expect(r.os).toBe('windows');
    expect(r.confidence).toBe('high');
  });

  it('separates Darwin from Linux on OPTION ORDER even when the numbers are tuned', () => {
    // The discriminator has to survive a tuned stack. Same TTL, same window,
    // same wscale — only the option layout differs, and that is enough.
    const tunedLinux = { ...LINUX, windowSize: 65535, windowScale: 6 };
    const tunedDarwin = { ...DARWIN, windowSize: 64240, windowScale: 7 };
    expect(fingerprintOs(tunedLinux).os).toBe('linux');
    expect(fingerprintOs(tunedDarwin).os).toBe('macos-or-ios');
  });
});

// ⛔⛔ (V-219) THE PATH REWRITES TTL; IT DOES NOT REORDER TCP OPTIONS.
//
// These signatures are REAL — captured on production 2026-09-15 by the deployed
// control-plane dialer, same destination IP, only the port differing. They carry
// no addresses. Each T-Mobile proxy presented a Linux layout on port 7791 and a
// Darwin layout on port 443, and BOTH arrived at TTL 114–117 (initial 128). Two
// different kernels cannot both originate TTL 128: the carrier's network set it.
// The old classifier read TTL first and called both of them Windows — the
// "TmobileTX shows Win" the owner reported from the profiles grid.
//
// The Verizon pair is the CONTROL: the same two layouts, but at TTL 53 (initial
// 64), which the old classifier already read correctly. If a change here moved
// those two, it would be fitting the new case by breaking the old one.
describe('the option layout outranks a TTL the path rewrote', () => {
  const TMOBILE_7791: TcpSynSignature = {
    ttl: 115,
    windowSize: 65535,
    mss: 1460,
    windowScale: 7,
    optionOrder: [2, 4, 8, 1, 3],
    df: true,
  };
  const TMOBILE_443: TcpSynSignature = {
    ttl: 115,
    windowSize: 65535,
    mss: 1460,
    windowScale: 6,
    optionOrder: [2, 1, 3, 1, 1, 8, 4, 0],
    df: true,
  };
  const VERIZON_7791: TcpSynSignature = { ...TMOBILE_7791, ttl: 53 };
  const VERIZON_443: TcpSynSignature = { ...TMOBILE_443, ttl: 53 };

  it('CRITICAL a Darwin layout at TTL 128 is Darwin, not Windows — the T-Mobile web-port reading — and its COMPLETE eight-option layout earns high: nothing but a rewritable TTL argues against a signature no other stack emits', () => {
    const r = fingerprintOs(TMOBILE_443);
    expect(r.os).toBe('macos-or-ios');
    expect(r.confidence).toBe('high');
    expect(r.reason).toMatch(/TTL rewritten in the path/);
  });

  it('CONTROL — a Darwin layout at TTL 128 that is corroborated but NOT the complete order stays medium — both a shorter layout and an eight-option one in a different order, so the check is on the ORDER and not the length', () => {
    const shorter = { ...TMOBILE_443, optionOrder: [2, 1, 3, 8, 4] };
    const reordered = { ...TMOBILE_443, optionOrder: [2, 1, 3, 1, 8, 1, 4, 0] };
    expect(fingerprintOs(shorter)).toMatchObject({ os: 'macos-or-ios', confidence: 'medium' });
    expect(fingerprintOs(reordered)).toMatchObject({ os: 'macos-or-ios', confidence: 'medium' });
  });

  it('CRITICAL a Linux layout at TTL 128 is Linux, not Windows — the T-Mobile observer-port reading', () => {
    const r = fingerprintOs(TMOBILE_7791);
    expect(r.os).toBe('linux');
    expect(r.confidence).toBe('medium');
  });

  it('CRITICAL CONTROL — the Verizon pair, same layouts at TTL 64, reads exactly as it always did', () => {
    expect(fingerprintOs(VERIZON_443)).toMatchObject({ os: 'macos-or-ios', confidence: 'high' });
    expect(fingerprintOs(VERIZON_7791)).toMatchObject({ os: 'linux', confidence: 'high' });
  });

  it('CRITICAL CONTROL — a real Windows stack is still Windows at high confidence. The override needs a layout Windows does not ship.', () => {
    expect(fingerprintOs(WINDOWS)).toMatchObject({ os: 'windows', confidence: 'high' });
  });

  it('a bare layout that TTL contradicts is NOT enough — without its own numeric values it overrides nothing and reads unknown', () => {
    const bare = { ...TMOBILE_443, windowScale: 8, windowSize: 64240 };
    expect(fingerprintOs(bare)).toMatchObject({ os: 'unknown', confidence: 'none' });
  });
});

// ⛔ Three defects an adversarial review found in the layout-over-TTL change
// before it shipped. Each one produced a CONFIDENT wrong answer, and two of them
// became green or red chips once a web-port reading was allowed to assert.
describe('the layout rule does not over-reach', () => {
  it('CRITICAL FreeBSD is not Darwin. MSS,NOP,WS,SACK,TS with window 65535 / wscale 6 is p0f\'s FreeBSD 9+, and treating "timestamps present" as Darwin put a green "matches the iOS device" on a FreeBSD relay — Darwin puts the timestamp BEFORE SACK', () => {
    const freebsd: TcpSynSignature = {
      ttl: 64,
      windowSize: 65535,
      mss: 1460,
      windowScale: 6,
      optionOrder: [2, 1, 3, 4, 8],
      df: true,
    };
    expect(fingerprintOs(freebsd).os).not.toBe('macos-or-ios');
    expect(fingerprintOs(freebsd)).toMatchObject({ os: 'unknown', confidence: 'none' });
  });

  it('CRITICAL a real Windows host with timestamps ENABLED is still Windows at TTL 128 — the change must not trade one misread for another', () => {
    const windowsTs: TcpSynSignature = {
      ttl: 124,
      windowSize: 8192,
      mss: 1460,
      windowScale: 8,
      optionOrder: [2, 1, 3, 4, 8],
      df: true,
    };
    expect(fingerprintOs(windowsTs)).toMatchObject({ os: 'windows', confidence: 'medium' });
  });

  it('CRITICAL an uncorroborated layout at TTL 255 is unknown, not BSD — the rule TTL 128 already applies. BSD against an iOS claim is a red mismatch', () => {
    const tunedDarwin255: TcpSynSignature = {
      ttl: 250,
      windowSize: 131072,
      mss: 1460,
      windowScale: 5,
      optionOrder: [2, 1, 3, 1, 1, 8, 4, 0],
      df: true,
    };
    expect(fingerprintOs(tunedDarwin255)).toMatchObject({ os: 'unknown', confidence: 'none' });
  });

  it('CONTROL — TTL 255 with no usable layout is still the BSD/network-gear reading it always was', () => {
    const gear: TcpSynSignature = {
      ttl: 250,
      windowSize: 4128,
      mss: 536,
      windowScale: null,
      optionOrder: [2],
      df: false,
    };
    expect(fingerprintOs(gear)).toMatchObject({ os: 'bsd', confidence: 'low' });
  });
});

describe('a Darwin claim is checked against the observed stack', () => {
  it('GREEN when a Darwin stack backs an iOS claim', () => {
    expect(compareOsToClaim(fingerprintOs(DARWIN).os, 'ios')).toBe('match');
    expect(compareOsToClaim(fingerprintOs(DARWIN).os, 'macos')).toBe('match');
  });

  it('RED when the profile claims iOS and the proxy is Linux or Windows', () => {
    // The customer-facing point of the column.
    expect(compareOsToClaim(fingerprintOs(LINUX).os, 'ios')).toBe('mismatch');
    expect(compareOsToClaim(fingerprintOs(WINDOWS).os, 'ios')).toBe('mismatch');
  });
});

describe('UNKNOWN never becomes a pass', () => {
  it('reports unknown when the option layout cannot separate the unix families', () => {
    const noOpts = { ...LINUX, optionOrder: [2], windowScale: null };
    const r = fingerprintOs(noOpts);
    expect(r.os).toBe('unknown');
    expect(r.confidence).toBe('none');
  });

  it('an unknown stack is NOT a match, even against a Darwin claim', () => {
    // ⛔ The arm this file exists for. A blank cell must be visually distinct
    // from a green one, or every failure to measure reads as a pass.
    expect(compareOsToClaim('unknown', 'ios')).toBe('unknown');
    expect(compareOsToClaim('unknown', 'macos')).toBe('unknown');
    expect(compareOsToClaim('unknown', 'ios')).not.toBe('match');
  });

  it('does not judge a claim the fingerprint cannot speak to', () => {
    // Claimed 'other' (e.g. an Android archetype): a Darwin stack neither
    // confirms nor contradicts it, so the honest answer is unknown, not a red.
    expect(compareOsToClaim('macos-or-ios', 'other')).toBe('unknown');
    expect(compareOsToClaim('linux', 'other')).toBe('unknown');
  });
});

describe('a SYN in which nothing was observed cannot name an OS', () => {
  /**
   * ⛔ THIS RETURNED `windows` AT `high` — the highest confidence the system
   * offers — from a SYN carrying neither of the options the classifier keys on.
   *
   * `layoutOf` answers 'none' when window-scale or SACK-permitted is missing,
   * which is what a stripped, minimal or simply unobserved SYN looks like. With
   * the layout unusable, `hasTs` is false for the SAME reason, and the old reason
   * string said it aloud — "no TCP timestamps" — reading NOT OBSERVED as NOT
   * PRESENT. All that actually remained was a TTL, and this file's own note
   * records that TTL is rewritten in transit, which is why corroboration exists.
   *
   * ⚠️ A real Windows stack SENDS window-scale and SACK-permitted. Their joint
   * absence is evidence against having measured a Windows stack, not for it.
   *
   * It is customer-visible: `os_fingerprint` is on the customer allowlist and
   * renders as "OS: windows · high". Someone running an iPhone profile through an
   * exit that strips options was told at maximum confidence that their exit looks
   * like Windows — the exact mismatch this product exists to prevent shipping.
   */
  const NOTHING_OBSERVED: TcpSynSignature = {
    ttl: 128,
    windowSize: 64240,
    mss: 1460,
    windowScale: null,
    optionOrder: [2],
    df: true,
  };

  it('CRITICAL a stripped SYN at TTL 128 is unknown, not Windows at high confidence', () => {
    const v = fingerprintOs(NOTHING_OBSERVED);
    expect(v.os, 'no option layout means no family').toBe('unknown');
    expect(v.confidence).toBe('none');
    // ⛔ And the REASON must not repeat the original error by asserting the
    // options were absent. It has to say they were not observed.
    expect(v.reason).toMatch(/observed/i);
    expect(v.reason).not.toMatch(/Windows default stack/);
  });

  it('CONTROL — a SYN that really does show the Windows layout still reads Windows at high', () => {
    // Without this, the arm above would pass against a classifier that had simply
    // stopped identifying Windows at all, which would be a worse defect than the
    // one being fixed: the evidence is the LAYOUT, and when it is present the
    // verdict is sound.
    const v = fingerprintOs(WINDOWS);
    expect(v.os).toBe('windows');
    expect(v.confidence).toBe('high');
  });
});
