// W332.C — drift guard for /welcome onboarding page. Pins the
// post-signup framing:
//   • Trial pack CTA → /select-tier?focus=trial
//   • Pick-a-tier CTA → /select-tier
//   • What-happens-next sequence (Stripe → first session → API key mint)
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

  it('trial-pack CTA links to /select-tier?focus=trial', () => {
    expect(body).toContain('href="/select-tier?focus=trial"');
  });

  it('pick-a-tier CTA links to /select-tier', () => {
    expect(body).toContain('href="/select-tier"');
  });

  it('positions trial pack at $2.99 / 16 hours / 14-day window', () => {
    expect(body).toMatch(/\$2\.99/);
    expect(body).toMatch(/16 hours/);
    expect(body).toMatch(/14-day window/);
  });

  it('what-happens-next sequence covers Stripe → first session → API key mint', () => {
    expect(body).toMatch(/[Ss]tripe to confirm payment/);
    expect(body).toMatch(/first session/i);
    expect(body).toMatch(/first API key/i);
  });

  it('defensive redirect to /signup when ds_web_session_token absent', () => {
    expect(body).toContain('ds_web_session_token');
    expect(body).toMatch(/window\.location\.replace\(['"]\/signup['"]\)/);
  });
});
