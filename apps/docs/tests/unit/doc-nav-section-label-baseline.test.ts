// W291.C — drift guard for DOC_NAV section structure. Every
// section must declare a non-empty label and at least one item.
// Catches drift where a section is added but the items array is
// left empty (which would render an unlabelled separator in the
// sidebar).

import { describe, expect, it } from 'vitest';
import { DOC_NAV } from '../../src/data/nav';

describe('W291.C DOC_NAV section integrity', () => {
  it('every section has a non-empty label and at least one item', () => {
    const offenders: { label: string; reason: string }[] = [];
    for (const section of DOC_NAV) {
      if (!section.label || section.label.trim().length === 0) {
        offenders.push({ label: section.label ?? '', reason: 'empty label' });
      }
      if (!section.items || section.items.length === 0) {
        offenders.push({ label: section.label ?? '', reason: 'empty items array' });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no two sections share the same label', () => {
    const labels = DOC_NAV.map((s) => s.label);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const l of labels) {
      if (seen.has(l)) dupes.push(l);
      else seen.add(l);
    }
    expect(dupes).toEqual([]);
  });

  it('every item href is unique across the whole nav', () => {
    const hrefs: string[] = [];
    for (const s of DOC_NAV) for (const i of s.items) hrefs.push(i.href);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const h of hrefs) {
      if (seen.has(h)) dupes.push(h);
      else seen.add(h);
    }
    expect(dupes).toEqual([]);
  });
});
