// "if its mismatched, it should be red, and if MAC/IOS then green (match)."
// (owner item N-2.)
//
// The chip has THREE tones, and the third is the load-bearing one: a proxy
// whose stack was never measured, or measured and undetermined, must render in
// neither colour. An operator who cannot tell a blank from a pass reads every
// blank as a pass — the same rule the QUIC chip already follows ("inferred" is
// not "verified").
//
// ⛔⛔ (V-219) THE FILE'S RULE NOW COVERS A FOURTH KIND OF NON-PASS, and it is
// the nastiest one: a reading that LOOKS like a pass — a real stack, high
// confidence, an exit address — taken from a vantage that cannot support one.
// The owner measured it with a third-party instrument: browserleaks.com/ip,
// loaded THROUGH their residential proxy, reads the arriving stack on 443 (a
// website's port) and reports Mac/iOS; our observer reads the SAME proxy on
// 7791 and reports Linux at high confidence. The provider routes web traffic
// through the residential device and odd ports through its own infrastructure,
// so a reading taken at our vantage can describe a path no website ever
// touches. `singleHostVantage` is the one signal that rules that out: dialled
// host, SYN emitter and destination-visible address are ONE machine, so there
// is no fabric in between to route a site's port differently.
//
// Every fixture in this file therefore had to declare which of the two it is.
// That is not bookkeeping — it IS this file's subject. The old fixtures carried
// no vantage, so under the new rule they are all the withheld case, and the
// arms that used to prove "green only for a match" now prove something strictly
// stronger: green only for a match THAT A WEBSITE WOULD ALSO SEE.
//
// ⛔ Absence fails closed, and the arms below pin that directly. A legacy cached
// record, an older server and a tampered response all read `undefined` here and
// are indistinguishable from one another; none may promote itself into a
// confident claim by omission. Only an explicit `true` unlocks a colour.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProxyOsChip } from '../../src/components/ProxyCapabilities';
import {
  FINGERPRINTED_OS,
  osFingerprintVerdict,
  type OsFingerprint,
} from '../../src/lib/os-fingerprint-verdict';

/**
 * A reading with NO stated vantage — the shape a legacy cached record, an older
 * server, or a response with the field stripped all arrive in.
 *
 * ⛔ Under V-219 this is the WITHHELD case, not the asserting one. It is kept
 * named `fp` on purpose: every arm in this file used to be built from it, and
 * keeping the name makes the diff read as what it is — the same inputs, a
 * deliberately different verdict.
 */
const fp = (os: OsFingerprint['os']): OsFingerprint => ({ os, confidence: 'high', reason: 'r' });

/**
 * The same reading from the ONE vantage that can carry a verdict: the host we
 * dialled, the host that emitted the SYN and the address the destination sees
 * are one machine, so nothing in between can route a website's port differently
 * from our observer's. The ordinary datacentre SOCKS5 case, where the reading
 * really is about the path a site gets.
 *
 * ⚠️ `observedVia` is 'exit_ip' and cannot be anything else here: single-host
 * means the dialled address IS the exit, so that is how the server labels it.
 * `proxy_host` + `singleHostVantage: true` is a state the producer never emits,
 * and a fixture pairing them would pin a fiction rather than the product.
 */
const singleHost = (os: OsFingerprint['os']): OsFingerprint => ({
  ...fp(os),
  observedVia: 'exit_ip',
  singleHostVantage: true,
});

describe('the colour rule', () => {
  it('Darwin is the one match — every Driftstack device is an Apple device, and the reading has to be about the path a website gets', () => {
    expect(osFingerprintVerdict(singleHost('macos-or-ios')).tone).toBe('match');
  });

  it('Windows, Linux and BSD stacks are mismatches (same vantage requirement — the stack alone is only half of it)', () => {
    expect(osFingerprintVerdict(singleHost('windows')).tone).toBe('mismatch');
    expect(osFingerprintVerdict(singleHost('linux')).tone).toBe('mismatch');
    expect(osFingerprintVerdict(singleHost('bsd')).tone).toBe('mismatch');
  });

  it('undetermined and never-measured are neutral — neither a match nor a mismatch', () => {
    // Untouched by V-219: both of these resolve above the vantage gate, because
    // "we could not tell" and "nobody looked" are statements about the reading
    // itself and are true from any vantage.
    expect(osFingerprintVerdict(fp('unknown')).tone).toBe('unknown');
    expect(osFingerprintVerdict(undefined).tone).toBe('unknown');
    // They are still told apart in the glyph, so "we looked and could not
    // tell" does not read as "nobody looked".
    expect(osFingerprintVerdict(fp('unknown')).glyph).toBe('?');
    expect(osFingerprintVerdict(undefined).glyph).toBe('—');
  });
});

// (V-219) The fourth non-pass: a reading with nothing wrong with it except the
// vantage it was taken from. These arms are DELIBERATE INVERSIONS of what this
// file pinned before — the same fixtures, the opposite verdict — and the reason
// is in each name, so a future reader can tell them from a regression.
describe('a trustworthy-LOOKING reading from an untrustworthy vantage', () => {
  it('INVERTED (V-219) a Darwin stack read through a multi-machine proxy is NOT green — this is the exact failure the file is named for', () => {
    const v = osFingerprintVerdict(fp('macos-or-ios'));
    expect(v.tone, 'a reading of a path no website touches cannot pass one').toBe('unknown');
    expect(v.glyph).toBe('?');
    // The measurement is still shown: the chip names what was read, so the
    // operator sees the fact and only the CLAIM about it is withheld.
    expect(v.label).toBe('iOS/macOS');
    expect(v.hint).toMatch(/forwards through more than one machine/i);
    expect(v.hint).toContain('a website may reach a different one');
    // ⛔ and the reassurance must not leak back in through the prose.
    expect(v.hint).not.toContain('matches the iOS device');
  });

  it('INVERTED (V-219) a Linux stack read the same way is NOT red either — the gate is symmetric, which is the point', () => {
    const v = osFingerprintVerdict(fp('linux'));
    expect(v.tone).toBe('unknown');
    expect(v.glyph).toBe('?');
    expect(v.label).toBe('Linux');
    expect(v.hint).toContain('Linux');
    expect(v.hint).not.toContain('detectable mismatch');
  });

  it('CRITICAL withholds the green exactly as hard as the red, and the vantage is the ONLY difference between withheld and stated', () => {
    // Both tones are minted from the identical SYN over the identical path, so a
    // vantage that cannot support "detectable mismatch" cannot support "matches
    // the iOS device it fronts" either. Silencing only the red — the arm that
    // produced the complaint — would have been a complaint-to-evidence fix: it
    // leaves the product able to falsely reassure and unable to falsely alarm,
    // with no instrument left that could contradict a wrong green. Of the two
    // errors the false green is far worse; a false red is an irritant somebody
    // reports, a false green costs a customer their account and nobody ever
    // files a bug about a reassuring badge.
    expect(osFingerprintVerdict(fp('macos-or-ios')).tone).toBe('unknown');
    expect(osFingerprintVerdict(fp('linux')).tone).toBe('unknown');
    // Positive control in the same breath — the feature is WITHHELD, not
    // deleted, and without these two lines the arm above would also pass on a
    // verdict that had simply stopped colouring anything.
    expect(osFingerprintVerdict(singleHost('macos-or-ios')).tone).toBe('match');
    expect(osFingerprintVerdict(singleHost('linux')).tone).toBe('mismatch');
  });

  it('CRITICAL absence fails closed — every shape of "the server did not say so" is NOT single-host', () => {
    // A legacy cached record (the field never existed), an older server or a
    // stripped/tampered response (`undefined`), and the honest multi-machine
    // answer (`false`) are indistinguishable here, and must be: the gate tests
    // for an explicit `true` rather than for truthiness, so a reassuring-looking
    // value that is not exactly `true` cannot mint a colour either.
    const notSingleHost: Partial<OsFingerprint>[] = [
      {},
      { singleHostVantage: undefined },
      { singleHostVantage: false },
      // A wire value that survived a sloppy parse: truthy, but not the boolean
      // the server computes. Cast because the type forbids it — which is the
      // reason to pin it here, where the type cannot.
      { singleHostVantage: 'true' as unknown as boolean },
    ];
    for (const vantage of notSingleHost) {
      const reading = { ...fp('macos-or-ios'), observedVia: 'exit_ip' as const, ...vantage };
      expect(osFingerprintVerdict(reading).tone, JSON.stringify(vantage)).toBe('unknown');
    }
  });

  it('the front door is not a way in either — a proxy_host reading of a Darwin stack is still colourless', () => {
    // `proxy_host` says the SYN came from the address we DIALLED, not the exit;
    // it resolves one branch ABOVE the vantage gate, with its own wording. It is
    // pinned here because this file's subject is every path to a green, and that
    // is one of them.
    // ⚠️ It never carries `singleHostVantage: true`: single-host means the
    // dialled address IS the exit, so the server labels such a reading
    // 'exit_ip'. The pair cannot co-occur and is not fixtured.
    const frontDoor: OsFingerprint = { ...fp('macos-or-ios'), observedVia: 'proxy_host' };
    expect(osFingerprintVerdict(frontDoor).tone).toBe('unknown');
    expect(osFingerprintVerdict(frontDoor).glyph).toBe('?');
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
      verdict: el.getAttribute('data-os-tone'),
      green: el.className.includes('status-ready'),
      red: el.className.includes('status-error'),
    };
  };

  it('is green ONLY for a match — and a match now needs the vantage as well as the stack', () => {
    expect(tones(singleHost('macos-or-ios'))).toEqual({
      verdict: 'match',
      green: true,
      red: false,
    });
    // INVERTED (V-219): the IDENTICAL Darwin stack, read through a proxy that
    // answers from more than one machine, no longer paints green. Pinned beside
    // the pass so the two cannot drift apart.
    expect(tones(fp('macos-or-ios'))).toEqual({ verdict: 'unknown', green: false, red: false });
  });

  it('is red for a mismatch — and withholds that red from the very same untrusted vantage', () => {
    expect(tones(singleHost('windows'))).toEqual({ verdict: 'mismatch', green: false, red: true });
    // INVERTED (V-219): symmetric with the green above. A vantage that cannot
    // support one arm does not support the other.
    expect(tones(fp('windows'))).toEqual({ verdict: 'unknown', green: false, red: false });
  });

  it('carries neither colour when undetermined or never measured', () => {
    expect(tones(fp('unknown'))).toEqual({ verdict: 'unknown', green: false, red: false });
    expect(tones(undefined)).toEqual({ verdict: 'unknown', green: false, red: false });
  });

  it('CRITICAL renders green for NOTHING that lacks an explicit single-host vantage — the file name as one assertion', () => {
    // Swept from the exported list rather than a hand-written one, so an OS
    // added to FINGERPRINTED_OS lands here automatically instead of quietly
    // sitting outside a denominator this arm would still report as complete.
    for (const os of FINGERPRINTED_OS) {
      expect(tones(fp(os)).green, os).toBe(false);
    }
    expect(tones(undefined).green).toBe(false);
    // Vacuity control: the sweep above must be failing for the RIGHT reason, not
    // because the helper stopped finding the green class at all.
    expect(tones(singleHost('macos-or-ios')).green).toBe(true);
  });
});
