// W354.A — drift guard for /docs/security-overview. The page is
// the entry point for a customer security review. Most claims here
// are pinned by sibling tests (TLS/HSTS, scrypt, data-residency,
// sub-processors). This test pins the cross-claim consistency: when
// a claim on the overview page cites a specific number or scope
// (scrypt logN, HSTS max-age, scope list, sub-processor shortlist,
// disclosure window), the corresponding source-of-truth is present.
//
// Pinned:
//   • scrypt logN=15 ↔ api-keys.ts kdf params (the page advertises
//     this exact tuning)
//   • HSTS max-age=63072000 (2-year preload-eligible) cited
//   • API key scopes list (read / write / account_owner) cites the
//     three customer-facing scopes
//   • driftstack_internal_admin gated separately
//   • 5-item sub-processor shortlist (Stripe / NowPayments /
//     Cloudflare / Postmark / Sentry) — the legal sub-processors
//     page is the authoritative list; the page name-checks all 5
//   • 30-day sub-processor change notice
//   • Customer-disclosure window: 72h
//   • Cross-links: /docs/api-security-headers, /docs/data-residency,
//     /docs/audit-log, /docs/admin-api, /docs/incident-policy,
//     /docs/rate-limits, /docs/recordings, /legal/sub-processors,
//     /legal/vulnerability-disclosure — all resolve.
//   • security@driftstack.dev contact

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/security-overview.astro');
const API_KEYS_LIB = resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W354.A /docs/security-overview parity', () => {
  const body = read(PAGE);

  it('scrypt logN=15 claim matches the api-keys.ts kdf parameters', () => {
    const lib = read(API_KEYS_LIB);
    expect(body).toMatch(/<code>scrypt<\/code>\s*\(logN=15\)/);
    expect(lib).toMatch(/logN:\s*15/);
  });

  it('HSTS max-age=63072000 cited (matches app.ts helmet config)', () => {
    expect(body).toContain('max-age=63072000');
    expect(read(APP)).toMatch(/maxAge:\s*63_072_000/);
  });

  it('API key scope claim names the three customer-facing scopes', () => {
    expect(body).toMatch(
      /<code>read<\/code>\s*\/\s*<code>write<\/code>\s*\/\s*<code>account_owner<\/code>/,
    );
  });

  it('driftstack_internal_admin scope gated separately (no customer key can hold it)', () => {
    expect(body).toMatch(/<code>driftstack_internal_admin<\/code>/);
    expect(body).toMatch(/no customer\s*key can hold/);
  });

  it('MFA TOTP + 15-minute step-up reauth window claim pinned', () => {
    expect(body).toMatch(/MFA \(TOTP\)/);
    expect(body).toMatch(/15\s*minutes of step-up inactivity/);
  });

  it('5-item sub-processor shortlist names Stripe, NowPayments, Cloudflare, Postmark, Sentry', () => {
    for (const name of ['Stripe', 'NowPayments', 'Cloudflare', 'Postmark', 'Sentry']) {
      expect(body).toContain(name);
    }
  });

  it('30-day sub-processor change notice pinned', () => {
    expect(body).toMatch(/30-day notice/);
  });

  it('72-hour security-disclosure window pinned', () => {
    expect(body).toMatch(/within 72h\s*of confirmation/);
  });

  it('concurrency-limit problem-type cited as the 429 dispatch slug', () => {
    expect(body).toMatch(/<code>concurrency-limit<\/code>/);
    expect(body).toMatch(/<code>429<\/code>/);
  });

  it('every cross-link cited resolves to a real page', () => {
    const sibs = [
      [
        'apps/marketing-site/src/pages/docs/api-security-headers.astro',
        '/docs/api-security-headers',
      ],
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // data-residency mirror is deleted; the page cross-links its
      // docs successor.
      [
        'apps/docs/src/pages/reference/data-residency.md',
        'https://docs.driftstack.io/reference/data-residency/',
      ],
      ['apps/marketing-site/src/pages/docs/audit-log.astro', '/docs/audit-log'],
      ['apps/marketing-site/src/pages/docs/admin-api.astro', '/docs/admin-api'],
      ['apps/marketing-site/src/pages/docs/incident-policy.astro', '/docs/incident-policy'],
      ['apps/marketing-site/src/pages/docs/rate-limits.astro', '/docs/rate-limits'],
      ['apps/marketing-site/src/pages/docs/recordings.astro', '/docs/recordings'],
      ['apps/marketing-site/src/pages/legal/sub-processors.md', '/legal/sub-processors'],
      [
        'apps/marketing-site/src/pages/legal/vulnerability-disclosure.md',
        '/legal/vulnerability-disclosure',
      ],
    ] as const;
    for (const [path, href] of sibs) {
      expect(body, `missing href on page: ${href}`).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing file at: ${path}`).toBe(true);
    }
  });

  it('vulnerability disclosure contact + 1-business-day response window pinned', () => {
    expect(body).toContain('security@driftstack.dev');
    expect(body).toMatch(/within 1 business day/);
  });
});
