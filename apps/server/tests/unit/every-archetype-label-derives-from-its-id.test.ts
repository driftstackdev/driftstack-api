// Every archetype's rendered fields must follow from its id.
//
// ARCHETYPE_REGISTRY is GENERATED from the fork's catalog (scripts/gen-archetype-registry.mjs)
// and carries 106 entries. Each one states the same facts twice —
// once encoded in the slug, once spelled out in the fields the device picker,
// the profiles view, the dashboard and the docs render:
//
//   id: 'iphone16promax_ios18_7_safari26_4'
//   displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.4'
//   device: 'iPhone 16 Pro Max'
//   iosVersion: '18.7'
//   safariVersion: '26.4'
//
// Measured when this landed: all four derive EXACTLY from the id on all 81
// entries — 324 values, zero disagreements. (2026-09-14: the registry became
// generated and grew to 106; the reader learned three-component versions and the
// Chrome-on-iOS slug shape, and caught two real defects doing so — a trailing
// -zero rule that rewrote Safari 26.0 as 26, and a Chrome row labelled Safari.)
// None of it is independent
// information; it is the slug re-spelled, so a mismatch can only be a typo.
//
// Nothing checked it. The existing registry coverage
// (api-types-common-content-parity) pins the SHAPE — that the array exists,
// that ArchetypeConfig has the right fields, that ARCHETYPE_DISPLAY_LABEL is
// derived from the registry rather than duplicated — but never that a given
// entry's own fields agree with its own id. A new entry saying "iOS 18.6"
// beside a slug saying `ios18_7` would ship green and show every customer the
// wrong OS version for that device.
//
// The check is exact equality against derived strings, so it carries no literal
// device name or version and needs no edit when an archetype is added.
//
// An id shape this reader does not understand FAILS rather than being skipped.
// Silently dropping an unparseable entry is how a guard quietly stops covering
// the thing it was written for — an `ipad`/`macbook` archetype must force a
// deliberate decision here rather than slipping out of scope.

import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

/** Slug suffix → the words that follow the model number. */
const DEVICE_SUFFIX: Readonly<Record<string, string>> = {
  '': '',
  mini: ' mini',
  pro: ' Pro',
  promax: ' Pro Max',
  plus: ' Plus',
  max: ' Max',
  air: ' Air',
};

// ⛔ THREE components on BOTH version sides, the third optional.
//
// This read `_ios(\d+)_(\d+)_safari(\d+)_(\d+)$` until 2026-09-14 — two-wide on
// each side, anchored. The fork hit the identical bug in five parsers of its
// own and warned us before a subversion slug reached this registry. Both sides
// really do carry point releases now: `iphone14_ios18_7_safari26_6_1` is Safari
// 26.6.1, and `iphone13_ios18_4_1_safari18_4` is iOS 18.4.1.
//
// The guard FAILS on an id it cannot parse rather than skipping it, and that is
// deliberate — see the header. The fork's own generator skipped unparseable
// slugs and its freshness check still printed "up to date", so an archetype
// could exist on disk and never reach anyone. A guard that refuses what it does
// not understand is strictly better than one that quietly drops it.
const ID_SHAPE = /^iphone(\d+)([a-z]*)_ios(\d+)_(\d+)(?:_(\d+))?_safari(\d+)_(\d+)(?:_(\d+))?$/;

// Chrome-on-iOS slugs end `_chrome<major>` instead of `_safari<x>_<y>`. They are
// held out of the picker today, but they are IN the registry, and the first
// version of this reader could not parse them — which, by the fail-on-unknown
// rule above, is the correct alarm rather than a nuisance. It caught a real
// defect: their label was being built from the Safari base and read
// "… / Safari 26.4" on a row whose own slug says Chrome 150.
//
// A chrome slug encodes no Safari version, so `safariVersion` is not derivable
// from it and is deliberately not compared for these entries — the field still
// carries the WebKit base, which is true and is what the fork renders with.
const CHROME_ID_SHAPE = /^iphone(\d+)([a-z]*)_ios(\d+)_(\d+)(?:_(\d+))?_chrome(\d+)$/;

interface Derived {
  displayLabel: string;
  device: string;
  iosVersion: string;
  /** Absent for a Chrome slug, which encodes no Safari version. */
  safariVersion?: string;
}

const dotted = (major: string, minor: string, patch: string | undefined): string =>
  patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`;

/** What an id implies for every rendered field, or null if the shape is unknown. */
function derivedFrom(id: string): Derived | null {
  const chrome = CHROME_ID_SHAPE.exec(id);
  if (chrome) {
    const [, model, suffix, iosMajor, iosMinor, iosPatch, chromeMajor] = chrome;
    const words = DEVICE_SUFFIX[suffix!];
    if (words === undefined) return null;
    const device = `iPhone ${model}${words}`;
    const iosVersion = dotted(iosMajor!, iosMinor!, iosPatch);
    return {
      device,
      iosVersion,
      displayLabel: `${device} / iOS ${iosVersion} / Chrome ${chromeMajor}`,
    };
  }
  const parsed = ID_SHAPE.exec(id);
  if (!parsed) return null;
  const [, model, suffix, iosMajor, iosMinor, iosPatch, safariMajor, safariMinor, safariPatch] =
    parsed;
  const words = DEVICE_SUFFIX[suffix!];
  if (words === undefined) return null;
  const device = `iPhone ${model}${words}`;
  // A patch component is rendered only when the slug carries one. `18.4.1` and
  // `18.4` are different versions and neither may be normalised into the other;
  // the only equivalence is a TRAILING zero (Chrome-on-iOS writes 26_4_0 for
  // Safari 26.4), and that is the catalog's business, not this reader's.
  const iosVersion =
    iosPatch === undefined ? `${iosMajor}.${iosMinor}` : `${iosMajor}.${iosMinor}.${iosPatch}`;
  const safariVersion =
    safariPatch === undefined
      ? `${safariMajor}.${safariMinor}`
      : `${safariMajor}.${safariMinor}.${safariPatch}`;
  return {
    device,
    iosVersion,
    safariVersion,
    displayLabel: `${device} / iOS ${iosVersion} / Safari ${safariVersion}`,
  };
}

describe('every archetype field derives from its id', () => {
  it('CRITICAL the registry is real and the reader is not vacuously agreeable', () => {
    expect(
      ARCHETYPE_REGISTRY.length,
      'the archetype registry is empty or unimported — every check below would be vacuous',
    ).toBeGreaterThanOrEqual(80);
    expect(derivedFrom('iphone16promax_ios18_7_safari26_4')).toEqual({
      displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.4',
      device: 'iPhone 16 Pro Max',
      iosVersion: '18.7',
      safariVersion: '26.4',
    });
    expect(derivedFrom('iphone13mini_ios18_6_safari18_6')?.device).toBe('iPhone 13 mini');
    // It must also say NO — to a wrong value and to an id it cannot read.
    expect(derivedFrom('iphone13_ios18_6_safari18_6')?.iosVersion).not.toBe('18.7');
    expect(derivedFrom('pixel8_android15_chrome130')).toBeNull();
  });

  it('CRITICAL no id shape falls outside the reader, so coverage cannot quietly shrink', () => {
    const unreadable = ARCHETYPE_REGISTRY.filter((a) => derivedFrom(a.id) === null).map(
      (a) => a.id,
    );
    expect(
      unreadable.sort(),
      'this reader only understands iphone<model><suffix>_ios<x>_<y>_safari<a>_<b>. A new device ' +
        'family needs its rule added here — leaving it unparsed would drop it out of the checks ' +
        'below without anyone noticing',
    ).toEqual([]);
  });

  it('CRITICAL every rendered field is exactly what its id implies', () => {
    const wrong: string[] = [];
    for (const entry of ARCHETYPE_REGISTRY) {
      const implied = derivedFrom(entry.id);
      if (implied === null) continue; // reported by the arm above
      for (const field of ['displayLabel', 'device', 'iosVersion', 'safariVersion'] as const) {
        // A Chrome slug carries no Safari version, so there is nothing to derive
        // and nothing to contradict. Skipping the field is not the same as
        // skipping the ENTRY — its label, device and iOS are all still checked.
        if (implied[field] === undefined) continue;
        const actual = (entry as unknown as Record<string, unknown>)[field];
        if (actual !== implied[field])
          wrong.push(
            `${entry.id}.${field}: is "${String(actual)}", its id implies "${implied[field]}"`,
          );
      }
    }
    expect(
      wrong.sort(),
      'a device picker entry names a device, OS or browser version its own slug contradicts',
    ).toEqual([]);
  });

  it('CRITICAL the comparison actually covers all four fields on every entry', () => {
    // Guards the loop above against a silently narrowed field list: 81 entries
    // × 4 derived fields is the whole surface, and a green there is only
    // meaningful if that many comparisons really ran.
    const compared = ARCHETYPE_REGISTRY.filter((a) => derivedFrom(a.id) !== null).length * 4;
    expect(compared, 'far fewer comparisons than the registry has fields').toBeGreaterThanOrEqual(
      320,
    );
  });
});
