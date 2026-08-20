// V-1166 — the privacy policy told readers to look up a breach commitment in the wrong
// section of the DPA.
//
// §12 of the privacy policy sets out what Driftstack does on a Personal Data breach. Its
// second item — notification to Customer, where Driftstack is Processor, targeting 48 hours
// — cited "the DPA Section 7". DPA Section 7 is `Records of Processing`. The clause it meant
// is `6.1 Notification to Customer`, under `6. Personal Data breaches`.
//
// Checked against history before calling it wrong: 6.1 has carried that heading in every
// revision of the DPA back to 2026-07-13, so this was never a stale number left by a
// renumbering. It was wrong when written, in both published copies, and a reader following
// it during a breach lands on records-keeping obligations.
//
// ── Why derive instead of pinning "6.1" ──────────────────────────────────
//
// V-1165 found that every Terms clause which did NOT drift was either stated once, or
// restated by a sentence naming the clause it implements — and that the two that DID drift
// were restatements naming nothing. Naming a section is only worth something if the name
// stays true, so this reads the number OUT of the privacy policy and checks the DPA heading
// it points at. A future renumbering of the DPA fails here rather than silently re-breaking
// the pointer, which is the failure mode the original citation already demonstrated.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** Both published copies of the policy; a fix to one is not a fix. */
const PRIVACY_COPIES = [
  'apps/marketing-site/src/pages/legal/privacy.md',
  'docs/legal/privacy-policy.md',
] as const;

const DPA = 'apps/marketing-site/src/pages/legal/dpa.md';

describe('V-1166 a cited DPA section contains what cites it', () => {
  it('CRITICAL both published copies of the privacy policy cite the same DPA section for breach notification. They are mirrors; correcting one and not the other leaves a customer reading whichever copy they happened to open.', () => {
    const cited = PRIVACY_COPIES.map((rel) => {
      const m = /per the DPA Section ([0-9]+(?:\.[0-9]+)?)/.exec(read(rel));
      return `${rel.split('/').pop() ?? rel}: ${m?.[1] ?? 'NO CITATION FOUND'}`;
    });
    // Anti-vacuity: a missing citation must fail loudly rather than compare two absences.
    expect(cited.join(' | '), 'the breach-notification citation is gone').not.toMatch(
      /NO CITATION FOUND/,
    );
    expect(
      new Set(cited.map((c) => c.split(': ')[1])).size,
      `copies disagree: ${cited.join(' | ')}`,
    ).toBe(1);
  });

  it('CRITICAL the DPA section the privacy policy cites is the one about notifying the Customer of a breach. The number is read out of the policy rather than pinned here, so a DPA renumbering fails this arm instead of quietly re-pointing the citation at whatever now sits at that number — which is exactly how it came to say Section 7, the Records-of-Processing clause.', () => {
    const policy = read(PRIVACY_COPIES[0]);
    const m = /per the DPA Section ([0-9]+(?:\.[0-9]+)?)/.exec(policy);
    expect(m, 'no DPA section citation found in the privacy policy').not.toBeNull();
    const section = m?.[1] ?? '';

    const dpa = read(DPA);
    // The DPA numbers top-level sections `## 7. Records…` and sub-clauses
    // `### 6.1 Notification…` — a period after one and not the other. Matching only
    // the second shape made a wrong citation fail as "no such heading" when the
    // section plainly exists, which is a true failure reported for a false reason.
    const heading = new RegExp(`^#{2,4}\\s*${section.replace('.', '\\.')}\\.?\\s+(.+)$`, 'm').exec(
      dpa,
    );
    expect(
      heading,
      `the privacy policy cites DPA Section ${section}, which has no heading`,
    ).not.toBeNull();

    expect(
      (heading?.[1] ?? '').toLowerCase(),
      `DPA Section ${section} is "${heading?.[1] ?? ''}" — not the clause that notifies the Customer of a breach`,
    ).toMatch(/notification to customer/);
  });

  it('CRITICAL the DPA still separates breach notification from records-keeping. If those merged, the arm above could pass while pointing a customer at the wrong obligation, so this holds the distinction the mistake depended on.', () => {
    const dpa = read(DPA);
    expect(dpa, 'the Personal Data breaches section is gone').toMatch(
      /^#{2,3}\s*6\.\s+Personal Data breaches/m,
    );
    expect(dpa, 'Records of Processing is no longer its own section').toMatch(
      /^#{2,3}\s*7\.\s+Records of Processing/m,
    );
  });
});
