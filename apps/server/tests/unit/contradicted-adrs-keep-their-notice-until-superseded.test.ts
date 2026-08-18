// Two ADRs are contradicted by the shipped system, and the record has to say so
// until someone writes the ADR that replaces them.
//
// ADR-002 records "Stripe-only payment processing at launch"; the crypto rail
// shipped months ago. ADR-003 records "$2.99 trial pack replaces the free tier";
// `free` is a live tier and the trial pack was retired 2026-05-27. Both carry a
// dated reality note saying so, and both are still `Accepted` because
// docs/adr/README.md requires a superseded ADR to get
// `Status: Superseded by ADR-MMM` — and neither superseding ADR has been
// written.
//
// This does NOT write them. Both notes say why, and they are right: an ADR's
// value is the RATIONALE, and nobody who did not make the call can supply it
// without fabricating a decision record. I reconsidered that and reached the
// same conclusion.
//
// What was missing is that nothing held the debt in place. The notes are prose
// in a file with no test (ADR-003 has no content-parity suite at all, unlike
// 001/002/004/005/006), so a tidy-up that restored a clean `Status: Accepted`
// would make the contradiction invisible again — to a diligence or counsel
// review most of all, which is exactly who reads an ADR set cold.
//
// It is a DEBT TRACKER, not a freeze. Two ways to make it pass: write the
// superseding ADR and set `Status: Superseded by ADR-NNN` (the notice
// requirement lifts, and the new file must exist), or leave the debt and keep
// the notice. What it will not allow is dropping the notice while the
// contradiction stands.
//
// It also re-checks the FACTS the notes assert, because a notice that outlives
// its own truth is the failure this repo just had elsewhere: a parity pin froze
// "the verification log has reached V-750" and thereby made a stale number
// mandatory.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ADR_DIR = resolve(REPO_ROOT, 'docs', 'adr');

const CONTRADICTED = [
  {
    file: 'ADR-002-stripe-only-payment-processing.md',
    what: 'Stripe-only payment processing, contradicted by the shipped crypto rail',
  },
  {
    file: 'ADR-003-paid-trial-pack-replaces-free-tier.md',
    what: 'trial pack replaces the free tier, reversed — `free` is live and the pack was retired',
  },
] as const;

const read = (f: string): string => readFileSync(resolve(ADR_DIR, f), 'utf8');

/** `Status: Superseded by ADR-NNN`, if the debt has been paid. */
function supersededBy(body: string): string | null {
  return /Superseded by (ADR-\d+)/.exec(body)?.[1] ?? null;
}

describe('a contradicted ADR keeps its notice until a superseding ADR exists', () => {
  it('CRITICAL the ADR set was found and both contradicted files are in it', () => {
    // Positive control: everything below reads these two files, so a rename or a
    // moved directory must fail loudly rather than silently assert nothing.
    const adrs = readdirSync(ADR_DIR).filter((f) => /^ADR-\d+/.test(f));
    expect(adrs.length, 'no ADRs found — the directory moved').toBeGreaterThanOrEqual(6);
    for (const { file } of CONTRADICTED) {
      expect(adrs, `${file} is missing from docs/adr`).toContain(file);
    }
  });

  it.each(CONTRADICTED)(
    '$file states its contradiction, or names the ADR that superseded it',
    ({ file, what }) => {
      const body = read(file);
      const superseded = supersededBy(body);
      if (superseded !== null) {
        // Debt paid. The replacement must actually exist — a status line naming a
        // file nobody wrote is worse than the notice it replaced.
        const exists = readdirSync(ADR_DIR).some((f) => f.startsWith(superseded));
        expect(
          exists,
          `${file} claims it is superseded by ${superseded}, but no such ADR file exists`,
        ).toBe(true);
        return;
      }
      expect(
        body,
        `${file} is contradicted by the shipped system (${what}) and no superseding ADR exists, so ` +
          'the header must keep saying so. Without it the set reads as current to anyone — ' +
          'diligence or counsel especially — who opens it cold',
      ).toMatch(/CONTRADICTED BY THE SHIPPED SYSTEM|REVERSED BY THE SHIPPED SYSTEM/);
      expect(body, `${file} lost its dated reality note`).toMatch(/reality check/i);
      expect(body, `${file} no longer records that the superseding ADR is owed`).toMatch(
        /superseding ADR/i,
      );
    },
  );

  it('CRITICAL the facts behind the ADR-002 notice still hold', () => {
    // A notice that outlives its truth is the same defect as no notice. If the
    // crypto rail were ever removed, ADR-002 would be accurate again and this
    // should fail so the note gets withdrawn rather than left contradicting
    // reality in the other direction.
    const routes = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'));
    expect(
      routes.filter((f) => f.startsWith('billing-crypto')),
      'no crypto billing routes — ADR-002 may no longer be contradicted; re-read its notice',
    ).not.toEqual([]);
  });

  it('CRITICAL the facts behind the ADR-003 notice still hold', () => {
    expect(
      AccountTierSchema.options,
      '`free` is no longer a tier — ADR-003 may no longer be reversed; re-read its notice',
    ).toContain('free');
    const configHasRetirementNote = /trial[ _-]?pack/i.test(
      readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'), 'utf8'),
    );
    expect(
      configHasRetirementNote,
      'the trial-pack retirement note is gone from lib/config.ts — the ADR-003 notice cites it',
    ).toBe(true);
  });

  it('CRITICAL every ADR status is one the README defines. The README IS the definition of the vocabulary — it is where someone opening the set cold learns what a status means — and it listed three values while two ADRs had been carrying a fourth since May. A parity pin required the three-value line verbatim, so the omission was not merely unnoticed, it was enforced. Derived from the README now, so adding a status means defining it.', () => {
    const readme = readFileSync(resolve(ADR_DIR, 'README.md'), 'utf8');
    const spec = /\*\*Status:\*\*(.*)/.exec(readme)?.[1] ?? '';
    const vocabulary = spec
      .split('|')
      .map((s) => s.trim())
      // `Superseded by ADR-MMM` is a template; match on its stem.
      .map((s) => s.replace(/\s+by ADR-MMM$/, ''))
      .filter((s) => s.length > 0);
    expect(vocabulary.length, 'no status vocabulary parsed out of the README').toBeGreaterThan(2);

    const offenders: string[] = [];
    for (const file of readdirSync(ADR_DIR).filter((f) => /^ADR-\d+/.test(f))) {
      const status = (/\*\*Status:\*\*(.*)/.exec(read(file))?.[1] ?? '').trim();
      // The leading word is the status; everything after it is commentary —
      // `(pending review)`, or the dated reality note the arms above require.
      const head = status.split(/[\s(—]/)[0] ?? '';
      if (!vocabulary.some((v) => head === v.split(' ')[0])) offenders.push(`${file}: ${status}`);
    }
    expect(
      offenders.sort(),
      'ADR status(es) the README does not define. Either use one of its values, or add the new ' +
        'one to the README Status section with what it means — an undefined status is a word ' +
        'whose meaning lives only in the head of whoever typed it:',
    ).toEqual([]);
  });

  it('CRITICAL neither ADR silently claims to still be the current decision', () => {
    for (const { file } of CONTRADICTED) {
      const body = read(file);
      if (supersededBy(body) !== null) continue;
      const status = /\*\*Status:\*\*(.*)/.exec(body)?.[1] ?? '';
      expect(
        status.trim(),
        `${file} has a bare Accepted status while the shipped system contradicts it`,
      ).not.toMatch(/^Accepted\s*$/);
    }
  });
});
