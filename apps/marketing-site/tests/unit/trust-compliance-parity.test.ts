// W263.B — drift-guard for /trust/compliance page. Pins:
// 1. SOC 2 Type I / Type II are framed "In progress" / "Planned", NOT live.
// 2. GDPR Article 28 DPA cross-link resolves to /legal/dpa.
// 3. Pen-test claim status is honest (Scheduled, first engagement).
// 4. No misrepresented certifications (HIPAA / ISO 27001 / FedRAMP).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W263.B /trust/compliance ↔ honest certification posture', () => {
  const page = read(PAGE);

  it('SOC 2 Type I is framed "In progress", not active', () => {
    expect(page).toMatch(/SOC 2 Type I/);
    // Must be in the In-progress amber row, not the In-place emerald row.
    expect(page).toMatch(/SOC 2 Type I[\s\S]{0,500}In progress/);
  });

  it('SOC 2 Type II is "Planned", not yet started', () => {
    expect(page).toMatch(/SOC 2 Type II/);
    expect(page).toMatch(/SOC 2 Type II[\s\S]{0,500}Planned/);
  });

  it('Pen-test is "Scheduled" (first engagement future-dated)', () => {
    expect(page).toMatch(/Independent pen-test[\s\S]{0,800}Scheduled/);
    expect(page).toMatch(/First engagement/);
  });

  it('GDPR Article 28 DPA is In place + cross-links to /legal/dpa', () => {
    expect(page).toMatch(/GDPR Article 28[\s\S]{0,800}In place/);
    expect(page).toContain('/legal/dpa');
    expect(
      ['dpa.astro', 'dpa.md', 'dpa/index.astro', 'dpa/index.md'].some((suffix) =>
        existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal', suffix)),
      ),
    ).toBe(true);
  });

  it('does not advertise certifications we have no plans for', () => {
    // Positive-list-only rule: silence is not "not applicable".
    // Negative checks: these CANNOT appear as live certifications.
    for (const cert of ['HIPAA compliant', 'FedRAMP', 'ISO 27001 certified', 'PCI DSS Level 1']) {
      expect(page).not.toMatch(new RegExp(cert, 'i'));
    }
  });

  it('does not claim a SOC 2 Type II audit is complete', () => {
    expect(page).not.toMatch(/SOC 2 Type II[\s\S]{0,200}certified/i);
    expect(page).not.toMatch(/SOC 2 Type II[\s\S]{0,200}complete/i);
  });
});
