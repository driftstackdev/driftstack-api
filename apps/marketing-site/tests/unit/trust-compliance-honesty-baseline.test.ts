// W314.B — drift guard for /trust/compliance page. The compliance
// page is the most legally sensitive narrative on the marketing
// site. Asserts:
//   • only legitimate certifications are claimed (no SOC 2 Type II
//     stated as live until the actual audit lands)
//   • GDPR Article 28 framing is present
//   • Penetration-test framing references "first engagement Q3 2026"
//   • Sub-processor change SLA is named

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W314.B /trust/compliance honesty baseline', () => {
  const body = read(PAGE);

  it('cites GDPR Article 28 (controller / processor relationship)', () => {
    expect(body).toContain('GDPR Article 28');
  });

  it('mentions SOC 2 Type I (Q3 2026 audit window)', () => {
    expect(body).toMatch(/SOC 2 Type I/);
    expect(body).toMatch(/Q3\s*2026/);
  });

  it('mentions SOC 2 Type II (Q1 2027)', () => {
    expect(body).toMatch(/SOC 2 Type II/);
    expect(body).toMatch(/Q1\s*2027/);
  });

  it('frames penetration test as "First engagement Q3 2026"', () => {
    expect(body).toMatch(/[Ff]irst engagement Q3 2026/);
  });

  it('does NOT claim SOC 2 Type II is already in place', () => {
    expect(body).not.toMatch(/SOC 2 Type II[^.]{0,80}(?:certified|live|in place|complete[d]?)/i);
  });

  it('does NOT claim ISO 27001 (we have no plans for it)', () => {
    expect(body).not.toMatch(/ISO\s*27001/);
  });

  it('does NOT claim HIPAA (out of scope for v1)', () => {
    expect(body).not.toMatch(/HIPAA/);
  });

  it('explains the silence convention (silence = not on roadmap)', () => {
    expect(body).toMatch(/silence on a certification/i);
  });
});
