// W276.A — workspace-wide sweep guard. Compliance posture wording
// must not claim certifications we don't hold. Catches drift where a copy
// edit adds "SOC 2 certified" / "ISO 27001 compliant" / "HIPAA
// compliant" wording that misrepresents our position.

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
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

// Phrases that overclaim our compliance posture. Each pattern matches
// the affirmative claim. Explicit current-state denials such as
// "not SOC 2 certified" are truthful and must not be false positives.
const FORBIDDEN_PHRASES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bSOC ?2 certified\b/i, reason: 'SOC 2 is not currently certified' },
  { pattern: /\bSOC ?2 compliant\b/i, reason: 'SOC 2 compliance is not claimed' },
  { pattern: /\bSOC ?2 audited\b/i, reason: 'SOC 2 audit completion is not claimed' },
  { pattern: /\bISO ?27001 certified\b/i, reason: 'ISO 27001 is not certified' },
  { pattern: /\bISO ?27001 compliant\b/i, reason: 'ISO 27001 compliance is not claimed' },
  { pattern: /\bHIPAA compliant\b/i, reason: 'We do not offer HIPAA coverage' },
  { pattern: /\bFedRAMP\b/i, reason: 'FedRAMP is not offered' },
  {
    pattern: /\bPCI[- ]DSS certified\b/i,
    reason: 'Stripe holds PCI-DSS — we inherit, not certify',
  },
];

/**
 * Truthful current-state denials — "we are not SOC 2 certified" — removed
 * before matching, so an honest statement of position is not read as a claim.
 */
const DENIAL =
  /\bnot\b[\s\S]{0,50}?\b(?:SOC ?2|ISO ?27001)(?:\s+or\s+(?:SOC ?2|ISO ?27001))?\s+(?:certified|compliant|audited)\b/gi;

/**
 * Does `text` make this overclaim, once truthful denials are set aside?
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy would prove that copy works, not this one.
 */
const makesOverclaim = (pattern: RegExp, text: string): boolean =>
  pattern.test(text.replace(DENIAL, ''));

describe('W276.A workspace-wide compliance-framing sweep', () => {
  it('CRITICAL the sweep read real pages, every phrase still matches, and the denial exemption has not widened into a blanket. Each assertion below runs INSIDE a loop over the collected pages, so a moved or renamed root leaves all eight vacuously true — reporting every page clean because it read none. This guard exists to stop us publishing a certification we do not hold, which makes a silent pass the expensive outcome.', () => {
    expect(allFiles.length, 'pages across marketing-site, docs and dashboard').toBeGreaterThan(120);

    // Every pattern against a phrase it must catch. A pattern that stopped
    // matching would leave its own test permanently, silently green.
    const samples: [RegExp, string][] = [
      [/\bSOC ?2 certified\b/i, 'We are SOC 2 certified.'],
      [/\bSOC ?2 compliant\b/i, 'Fully SOC 2 compliant today.'],
      [/\bSOC ?2 audited\b/i, 'Independently SOC 2 audited.'],
      [/\bISO ?27001 certified\b/i, 'ISO 27001 certified since 2024.'],
      [/\bISO ?27001 compliant\b/i, 'Our platform is ISO 27001 compliant.'],
      [/\bHIPAA compliant\b/i, 'HIPAA compliant storage.'],
      [/\bFedRAMP\b/i, 'FedRAMP authorised.'],
      [/\bPCI[- ]DSS certified\b/i, 'We are PCI-DSS certified.'],
    ];
    expect(samples.length, 'a sample per forbidden phrase').toBe(FORBIDDEN_PHRASES.length);
    for (const [i, { pattern, reason }] of FORBIDDEN_PHRASES.entries()) {
      const [samplePattern, sample] = samples[i]!;
      expect(samplePattern.source, `sample ${i} pairs with the wrong phrase`).toBe(pattern.source);
      expect(makesOverclaim(pattern, sample), `pattern no longer catches: ${reason}`).toBe(true);
    }

    // And the denial exemption still exempts only denials. A strip that
    // widened would delete the surrounding sentence and silence real
    // overclaims — the failure mode that looks identical to being clean.
    expect(
      makesOverclaim(/\bSOC ?2 certified\b/i, 'Driftstack is not SOC 2 certified.'),
      'a truthful denial is not reported',
    ).toBe(false);
    expect(
      makesOverclaim(
        /\bSOC ?2 certified\b/i,
        'Driftstack is not ISO 27001 certified. Driftstack is SOC 2 certified.',
      ),
      'but a denial does not launder a real claim later in the same page',
    ).toBe(true);
  });

  for (const { pattern, reason } of FORBIDDEN_PHRASES) {
    it(`no page uses an overclaim — ${reason}`, () => {
      const offenders = allFiles
        .filter((f) => makesOverclaim(pattern, read(f)))
        .map((f) => f.slice(REPO_ROOT.length + 1));
      expect(offenders).toEqual([]);
    });
  }
});
