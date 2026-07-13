// W332.C — drift guard for /welcome onboarding page. Pins the
// post-signup framing:
//   • Start-free CTA → dashboard home (2026-07-02 account-portal IA;
//     the old /first-session target was deleted — sessions run in the app)
//   • Pick-a-tier CTA → /select-tier
//   • What-happens-next sequence (Stripe → get the app → API key mint)
//   • Defensive redirect to /signup when no ds_web_session_token

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W332.C /welcome onboarding baseline', () => {
  const body = read(PAGE);

  it('start-free CTA links to the dashboard home', () => {
    expect(body).toContain('<a href="/" class="btn-primary');
  });

  it('pick-a-tier CTA links to /select-tier', () => {
    expect(body).toContain('href="/select-tier/"');
  });

  it('positions the free plan at $0 / no card / no expiry (trial pack removed)', () => {
    expect(body).toMatch(/\$0 · no card/);
    expect(body).toMatch(/Start free/);
    expect(body).not.toMatch(/\$2\.99/);
  });

  it('what-happens-next sequence covers Stripe → get the desktop app → API key', () => {
    expect(body).toMatch(/[Ss]tripe to confirm payment/);
    expect(body).toMatch(/desktop app/i);
    expect(body).toMatch(/API key/i);
  });

  it('defensive redirect to /signup when ds_web_session_token absent', () => {
    expect(body).toContain('ds_web_session_token');
    expect(body).toMatch(/window\.location\.replace\(['"]\/signup['"]\)/);
  });
});
