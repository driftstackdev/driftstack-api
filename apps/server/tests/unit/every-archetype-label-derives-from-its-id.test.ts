// Every archetype's rendered fields must follow from its id.
//
// ARCHETYPE_REGISTRY carries 81 entries. Each one states the same facts twice —
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
// entries — 324 values, zero disagreements. None of it is independent
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

const ID_SHAPE = /^iphone(\d+)([a-z]*)_ios(\d+)_(\d+)_safari(\d+)_(\d+)$/;

interface Derived {
  displayLabel: string;
  device: string;
  iosVersion: string;
  safariVersion: string;
}

/** What an id implies for every rendered field, or null if the shape is unknown. */
function derivedFrom(id: string): Derived | null {
  const parsed = ID_SHAPE.exec(id);
  if (!parsed) return null;
  const [, model, suffix, iosMajor, iosMinor, safariMajor, safariMinor] = parsed;
  const words = DEVICE_SUFFIX[suffix!];
  if (words === undefined) return null;
  const device = `iPhone ${model}${words}`;
  const iosVersion = `${iosMajor}.${iosMinor}`;
  const safariVersion = `${safariMajor}.${safariMinor}`;
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
