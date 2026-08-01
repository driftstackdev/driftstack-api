// W276.B — workspace-wide sweep guard for marketing overclaims.
// Specific phrases that have either historically appeared in drift
// (mTLS pillar — removed in W246.A) or that would misrepresent the
// stack we actually run. Adds belt-and-braces coverage on top of
// the compliance-framing sweep.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

// Phrases that appear as overclaims; each pattern is paired with the
// page subdirs where it would be a hard fail. trust/ and security
// pages may *deny* having these (e.g. "No SOC 2."), so we look for
// the affirmative-pillar form.
const FORBIDDEN_AFFIRMATIVE_FEATURES: { pattern: RegExp; reason: string }[] = [
  { pattern: /mTLS support\b/i, reason: 'mTLS pillar was removed in W246.A; not offered' },
  { pattern: /\bzero[- ]knowledge encryption\b/i, reason: 'Not part of the stack' },
  { pattern: /\bend[- ]to[- ]end encrypted\b/i, reason: 'Misleading — only TLS in transit' },
  { pattern: /\bFIPS 140-2\b/i, reason: 'No FIPS-validated module in the stack' },
];

describe('W276.B workspace-wide marketing-overclaim sweep', () => {
  it('CRITICAL the sweep read real pages and every phrase still matches. Each assertion below runs INSIDE a loop over the collected pages, so a moved or renamed root leaves all four vacuously true — reporting every page clean because it read none. These are claims about the security of the product, so a silent pass is the expensive outcome.', () => {
    expect(allFiles.length, 'pages across marketing-site and docs').toBeGreaterThan(100);

    const samples: [RegExp, string][] = [
      [/mTLS support\b/i, 'Includes mTLS support for every session.'],
      [/\bzero[- ]knowledge encryption\b/i, 'Backed by zero-knowledge encryption.'],
      [/\bend[- ]to[- ]end encrypted\b/i, 'Every session is end-to-end encrypted.'],
      [/\bFIPS 140-2\b/i, 'Uses a FIPS 140-2 validated module.'],
    ];
    expect(samples.length, 'a sample per forbidden phrase').toBe(
      FORBIDDEN_AFFIRMATIVE_FEATURES.length,
    );
    for (const [i, { pattern, reason }] of FORBIDDEN_AFFIRMATIVE_FEATURES.entries()) {
      const [samplePattern, sample] = samples[i]!;
      expect(samplePattern.source, `sample ${i} pairs with the wrong phrase`).toBe(pattern.source);
      expect(pattern.test(sample), `pattern no longer catches: ${reason}`).toBe(true);
    }

    // The hyphen alternations are the fragile part of these patterns — the
    // published copy uses either spelling, and a pattern that only matched one
    // would pass this file while the other spelling shipped.
    expect(/\bend[- ]to[- ]end encrypted\b/i.test('end to end encrypted'), 'spaced form').toBe(
      true,
    );
    expect(/\bend[- ]to[- ]end encrypted\b/i.test('end-to-end encrypted'), 'hyphenated form').toBe(
      true,
    );
  });

  for (const { pattern, reason } of FORBIDDEN_AFFIRMATIVE_FEATURES) {
    it(`no page makes the affirmative claim — ${reason}`, () => {
      const offenders = allFiles
        .filter((f) => pattern.test(read(f)))
        .map((f) => f.slice(REPO_ROOT.length + 1));
      expect(offenders).toEqual([]);
    });
  }
});
