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

describe('W276.A workspace-wide compliance-framing sweep', () => {
  for (const { pattern, reason } of FORBIDDEN_PHRASES) {
    it(`no page uses an overclaim — ${reason}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f).replace(
          /\bnot\b[\s\S]{0,50}?\b(?:SOC ?2|ISO ?27001)(?:\s+or\s+(?:SOC ?2|ISO ?27001))?\s+(?:certified|compliant|audited)\b/gi,
          '',
        );
        if (pattern.test(body)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
