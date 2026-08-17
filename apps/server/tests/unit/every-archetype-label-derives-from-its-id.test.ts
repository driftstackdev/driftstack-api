// Every archetype's display label must follow from its id.
//
// ARCHETYPE_REGISTRY carries 81 entries, each a slug plus the human label the
// device picker, the profiles view, the dashboard and the docs all render:
//
//   id: 'iphone16promax_ios18_7_safari26_4'
//   displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.4'
//
// Measured when this landed: all 81 labels derive EXACTLY from their ids — the
// device token, the iOS version and the Safari version, in that order. So the
// label is not independent information, it is a rendering of the slug, and a
// mismatch can only be a typo.
//
// Nothing checked it. The existing registry coverage
// (api-types-common-content-parity) pins the SHAPE — that the array exists,
// that ArchetypeConfig has the right fields, that ARCHETYPE_DISPLAY_LABEL is
// derived from the registry rather than duplicated — but never that any given
// entry's label agrees with its own id. A new entry whose label said
// "iOS 18.6" while its slug said `ios18_7` would ship green and show every
// customer the wrong OS version for that device.
//
// The check is exact equality against a derived string, so it carries no
// literal label and needs no edit when an archetype is added.
//
// An id shape this reader does not understand FAILS rather than being skipped.
// Silently dropping an unparseable entry is how a guard quietly stops covering
// the thing it was written for — an `ipad`/`macbook` archetype must force a
// deliberate decision here rather than slipping out of scope.

import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

/** Slug suffix → the words that follow the model number in a label. */
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

/** The label an id implies, or null when the id shape is unrecognised. */
function labelFor(id: string): string | null {
  const parsed = ID_SHAPE.exec(id);
  if (!parsed) return null;
  const [, model, suffix, iosMajor, iosMinor, safariMajor, safariMinor] = parsed;
  const words = DEVICE_SUFFIX[suffix!];
  if (words === undefined) return null;
  return `iPhone ${model}${words} / iOS ${iosMajor}.${iosMinor} / Safari ${safariMajor}.${safariMinor}`;
}

describe('every archetype label derives from its id', () => {
  it('CRITICAL the registry is real and the reader is not vacuously agreeable', () => {
    expect(
      ARCHETYPE_REGISTRY.length,
      'the archetype registry is empty or unimported — every check below would be vacuous',
    ).toBeGreaterThanOrEqual(80);
    expect(labelFor('iphone16promax_ios18_7_safari26_4')).toBe(
      'iPhone 16 Pro Max / iOS 18.7 / Safari 26.4',
    );
    expect(labelFor('iphone13mini_ios18_6_safari18_6')).toBe(
      'iPhone 13 mini / iOS 18.6 / Safari 18.6',
    );
    // It must also say NO — to a wrong label and to an id it cannot read.
    expect(labelFor('iphone13_ios18_6_safari18_6')).not.toBe('iPhone 13 / iOS 18.7 / Safari 18.6');
    expect(labelFor('pixel8_android15_chrome130')).toBeNull();
  });

  it('CRITICAL no id shape falls outside the reader, so coverage cannot quietly shrink', () => {
    const unreadable = ARCHETYPE_REGISTRY.filter((a) => labelFor(a.id) === null).map((a) => a.id);
    expect(
      unreadable.sort(),
      'this reader only understands iphone<model><suffix>_ios<x>_<y>_safari<a>_<b>. A new device ' +
        'family needs its rule added here — leaving it unparsed would drop it out of the check ' +
        'below without anyone noticing',
    ).toEqual([]);
  });

  it('CRITICAL every label is exactly the label its id implies', () => {
    const wrong = ARCHETYPE_REGISTRY.filter((a) => a.displayLabel !== labelFor(a.id)).map(
      (a) => `${a.id}: labelled "${a.displayLabel}", its id implies "${String(labelFor(a.id))}"`,
    );
    expect(
      wrong.sort(),
      'a device picker entry names a device, OS or browser version its own slug contradicts',
    ).toEqual([]);
  });
});
