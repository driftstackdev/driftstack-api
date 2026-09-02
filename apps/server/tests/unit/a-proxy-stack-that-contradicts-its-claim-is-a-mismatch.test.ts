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
