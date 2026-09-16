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
//   • Sub-processor list rendered from SUB_PROCESSORS in
//     src/data/sub-processors.ts (2026-09-16). It was a hand-written
//     5-name shortlist — Stripe / NowPayments / Cloudflare / Postmark
//     / Sentry — that omitted Neon, Hetzner, MacStadium and LiveKit
//     while this same page named them in its data-handling and
//     network sections. Entry-level coverage is proved in
//     docs-security-overview-sub-processor-register-binding.test.ts;
//     this arm pins that the page reads the register at all and that
//     the transcribed shortlist cannot come back — the negatives are
//     scoped to the sub-processor SECTION, because page-wide they
//     would forbid true statements the page makes elsewhere.
//   • Card-numbers-never-reach-us + errors-scrubbed-before-Sentry:
//     the two commitments the old shortlist carried in its Stripe and
//     Sentry lines. The generated list quotes the register, which does
//     not make them, so they moved to the data-handling section rather
//     than leaving the page.
//   • One complete list, named once: /trust/sub-processors is the
//     register and /legal/sub-processors is the same list under the
//     DPA — the egress bullet no longer makes a rival completeness
//     claim of its own.
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

const SECTION_HEADING = '<h2>Sub-processors</h2>';

/**
 * The page's sub-processor section: its own `<h2>` up to the next one.
 *
 * The shortlist negatives below are scoped to this slice, not to the
 * whole page. They exist to stop a hand-maintained list returning HERE;
 * page-wide they would ban true statements the page is entitled to make
 * elsewhere — "no payment data touches our infra" and "PII-scrubbed"
 * were commitments this page carried before the list was generated.
 */
function subProcessorSection(page: string): string {
  const start = page.indexOf(SECTION_HEADING);
  expect(start, 'the page still has a <h2>Sub-processors</h2> section').toBeGreaterThan(-1);
  const rest = page.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('<h2>');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('W354.A /docs/security-overview parity', () => {
  const body = read(PAGE);
  const subProcessors = subProcessorSection(body);

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

  it('the sub-processor list is generated from the register, not transcribed (the 5-name shortlist this replaces omitted Neon, Hetzner, MacStadium and LiveKit)', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bSUB_PROCESSORS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/sub-processors/,
    );
    expect(body).toMatch(/SUB_PROCESSORS\.map\(/);
    expect(body).toContain('href="/trust/sub-processors/"');
    // The old shortlist's own wording, pinned negative IN THE SECTION
    // so a hand-maintained list cannot quietly return. Scoped, not
    // page-wide: the page is free to state the same facts in prose.
    expect(subProcessors).not.toMatch(/card billing only/);
    expect(subProcessors).not.toMatch(/crypto checkout/);
    expect(subProcessors).not.toMatch(/CDN, WAF, R2 object storage/);
    expect(subProcessors).not.toMatch(/PII-scrubbed at SDK level/);
  });

  it('the payment-data and error-report commitments the old shortlist carried are still made on this page, in the data-handling section', () => {
    expect(body).toMatch(/Card numbers never reach\s*Driftstack systems\./);
    expect(body).toMatch(/with personal data\s*scrubbed out first\./);
  });

  it('the page names one complete list, not two competing ones: the register is /trust/sub-processors and /legal/sub-processors is named as the same list, the one the DPA refers to', () => {
    expect(subProcessors).toMatch(/This is the complete list/);
    // Every other mention of /legal/sub-processors in the body prose
    // (the Related cluster aside) must say it is the same list.
    expect(body).toMatch(
      /That one list is published in full at\s*<a href="\/trust\/sub-processors\/">\/trust\/sub-processors<\/a>, and\s*it is the same list the Data Processing Addendum refers to at\s*<a href="\/legal\/sub-processors\/">\/legal\/sub-processors<\/a>\./,
    );
    // The section makes the completeness claim; the egress bullet no
    // longer makes a second one of its own.
    expect(body).not.toMatch(/subprocessors enumerated below and on the/);
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
