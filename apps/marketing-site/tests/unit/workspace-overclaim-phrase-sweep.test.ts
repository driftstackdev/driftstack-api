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

// ⛔ This sweep is named workspace-wide and walked TWO of the five page-bearing app
// directories. The property it enforces — that the product's security claims are
// honest — has nothing to do with which app renders the page, so a scope narrower
// than the name is a guard that reads as complete and is not.
//
// `status-site` is added because it is CUSTOMER-FACING: an overclaim there reaches
// the same reader as one on the marketing site. `admin-panel` is deliberately NOT
// added — it is staff-internal, so the honesty property this enforces does not apply
// to it in the same way, and adding a directory the rule does not govern would make
// the scope arbitrary in the other direction.
//
// ⚠️ Extending found NOTHING: the added directory is clean today. That is the honest
// result — this closes a latent gap rather than fixing a live defect, and the guard
// simply now covers the surface its name has always claimed.
const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
  resolve(REPO_ROOT, 'apps/status-site/src/pages'),
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
    // ⛔ PER-ROOT, not just the aggregate. The floor below is satisfied by
    // marketing-site and docs alone, so a third root that silently fails to exist —
    // a rename, a typo in the path, an app that moves — is INVISIBLE to a total
    // count. Measured: breaking the status-site path left this file green until
    // these per-root assertions were added.
    for (const dir of targets) {
      expect(existsSync(dir), `walk root missing — this sweep read none of it: ${dir}`).toBe(true);
    }
    expect(allFiles.length, 'pages across marketing-site, docs and status-site').toBeGreaterThan(
      100,
    );

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
