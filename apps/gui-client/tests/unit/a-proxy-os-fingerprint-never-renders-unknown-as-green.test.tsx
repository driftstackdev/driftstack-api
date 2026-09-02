// "if its mismatched, it should be red, and if MAC/IOS then green (match)."
// (owner item N-2.)
//
// The chip has THREE tones, and the third is the load-bearing one: a proxy
// whose stack was never measured, or measured and undetermined, must render in
// neither colour. An operator who cannot tell a blank from a pass reads every
// blank as a pass — the same rule the QUIC chip already follows ("inferred" is
// not "verified").

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProxyOsChip } from '../../src/components/ProxyCapabilities';
import { osFingerprintVerdict, type OsFingerprint } from '../../src/lib/os-fingerprint-verdict';

const fp = (os: OsFingerprint['os']): OsFingerprint => ({ os, confidence: 'high', reason: 'r' });

describe('the colour rule', () => {
  it('Darwin is the one match — every Driftstack device is an Apple device', () => {
    expect(osFingerprintVerdict(fp('macos-or-ios')).tone).toBe('match');
  });

  it('Windows, Linux and BSD stacks are mismatches', () => {
    expect(osFingerprintVerdict(fp('windows')).tone).toBe('mismatch');
    expect(osFingerprintVerdict(fp('linux')).tone).toBe('mismatch');
    expect(osFingerprintVerdict(fp('bsd')).tone).toBe('mismatch');
  });

  it('undetermined and never-measured are neutral — neither a match nor a mismatch', () => {
    expect(osFingerprintVerdict(fp('unknown')).tone).toBe('unknown');
    expect(osFingerprintVerdict(undefined).tone).toBe('unknown');
    // They are still told apart in the glyph, so "we looked and could not
    // tell" does not read as "nobody looked".
    expect(osFingerprintVerdict(fp('unknown')).glyph).toBe('?');
    expect(osFingerprintVerdict(undefined).glyph).toBe('—');
  });
});

describe('the chip', () => {
  const tones = (
    fingerprint: OsFingerprint | undefined,
  ): { verdict: string | null; green: boolean; red: boolean } => {
    const { container } = render(<ProxyOsChip fingerprint={fingerprint} />);
    const el = container.querySelector('[data-component="proxy-os-fingerprint"]');
    if (el === null) throw new Error('chip did not render');
    return {
      verdict: el.getAttribute('data-verdict'),
      green: el.className.includes('status-ready'),
      red: el.className.includes('status-error'),
    };
  };

  it('is green ONLY for a match', () => {
    expect(tones(fp('macos-or-ios'))).toEqual({ verdict: 'match', green: true, red: false });
  });

  it('is red for a mismatch', () => {
    expect(tones(fp('windows'))).toEqual({ verdict: 'mismatch', green: false, red: true });
  });

  it('carries neither colour when undetermined or never measured', () => {
    expect(tones(fp('unknown'))).toEqual({ verdict: 'unknown', green: false, red: false });
    expect(tones(undefined)).toEqual({ verdict: 'unknown', green: false, red: false });
  });
});
