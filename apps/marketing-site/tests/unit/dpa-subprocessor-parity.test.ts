// W283.A — drift guard for DPA Annex 3 sub-processor coverage.
// Every entry in apps/marketing-site/src/data/sub-processors.ts
// must be mentioned by name in apps/marketing-site/src/pages/
// legal/dpa.md so customers can audit our sub-processor disclosure
// from the contract surface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';
import { unnamedIn } from './_sub-processor-matching';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DPA = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W283.A SUB_PROCESSORS ↔ legal/dpa.md parity', () => {
  const dpa = read(DPA);

  it('CRITICAL the roster is non-empty and the matcher still reports a name the DPA omits. The assertion below reports an ABSENCE of missing entries, so an empty or shortened SUB_PROCESSORS makes it true while Annex 3 silently stops naming somebody who processes customer data — the disclosure a customer audits this contract surface for.', () => {
    expect(SUB_PROCESSORS.length, 'sub-processors to check against Annex 3').toBeGreaterThan(10);
    expect(
      unnamedIn(dpa, ['Definitely Not A Real Sub-Processor']),
      'a name the DPA does not contain is reported by the same matcher used below',
    ).toEqual(['Definitely Not A Real Sub-Processor']);
  });

  it('every SUB_PROCESSORS entry is named in the DPA Annex 3 table', () => {
    // `namedIn` accepts the longer legal-entity name via the leading vendor
    // word — "Hetzner Online GmbH" for "Hetzner Cloud" — which is invariant
    // across the short and legal forms.
    expect(
      unnamedIn(
        dpa,
        SUB_PROCESSORS.map((sp) => sp.name),
      ),
    ).toEqual([]);
  });
});
