// W188 — drift guard against re-introducing hardcoded customer-facing
// URL literals in bootstrap.ts.
//
// Background: the V-079.B + V-057.E fixes consolidated every
// customer-facing URL in bootstrap.ts onto `config.dashboardOrigin`,
// which is driven by the DASHBOARD_ORIGIN env var and prod-guarded
// against localhost. The original bug (2026-05-12) was a real Postmark
// email going out with a localhost link — that happened because *one*
// spot in the codebase used a hardcoded literal that nobody had
// touched in months.
//
// This test asserts bootstrap.ts contains no hardcoded customer-facing
// origin literals. If a future edit re-adds `https://app.driftstack.io`
// or `localhost:5173`, this test fails and the fix is to thread
// through `config.dashboardOrigin` instead. The grep is intentionally
// blunt — a few false positives (in comments) are caught by the
// allowlist below.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts');

const SOURCE = readFileSync(BOOTSTRAP, 'utf8');

// Lines containing one of these substrings are tolerated even if they
// otherwise match a forbidden literal. Use sparingly — every entry is
// a deliberate exception. Today the only legit references are:
//   - the `docsBaseUrl` literal pointing at the marketing site
//   - the status-page fallback (separate single source: PUBLIC_STATUS_PAGE_URL)
//   - DEFAULT_BASE_URL pattern in test fixtures (none here)
//   - comments explaining the policy
const COMMENT_ALLOWLIST_PATTERNS = [
  /^\s*\/\//, // single-line comment
  /^\s*\*/, // jsdoc continuation
];

const SUBSTRING_ALLOWLIST = [
  'driftstack.io/docs', // docsBaseUrl literal — marketing site, not dashboard
  'status.driftstack.io', // statusPageBaseUrl fallback — separate origin
];

function isAllowedLine(line: string): boolean {
  if (COMMENT_ALLOWLIST_PATTERNS.some((re) => re.test(line))) return true;
  return SUBSTRING_ALLOWLIST.some((s) => line.includes(s));
}

describe('W188 bootstrap.ts URL-literal drift guard', () => {
  it('contains no `https://app.driftstack.io` literals', () => {
    const offenders = SOURCE.split('\n')
      .map((line, idx) => ({ line, lineNumber: idx + 1 }))
      .filter(({ line }) => line.includes('app.driftstack.io'))
      .filter(({ line }) => !isAllowedLine(line));
    expect(
      offenders,
      `bootstrap.ts must not hardcode the dashboard origin — thread through config.dashboardOrigin instead. ` +
        `Offending lines:\n${offenders.map((o) => `  L${o.lineNumber.toString()}: ${o.line.trim()}`).join('\n')}`,
    ).toEqual([]);
  });

  it('contains no `localhost:5173` literals', () => {
    const offenders = SOURCE.split('\n')
      .map((line, idx) => ({ line, lineNumber: idx + 1 }))
      .filter(({ line }) => line.includes('localhost:5173'))
      .filter(({ line }) => !isAllowedLine(line));
    expect(
      offenders,
      `bootstrap.ts must not hardcode the dashboard's dev-mode origin — thread through config.dashboardOrigin instead. ` +
        `Offending lines:\n${offenders.map((o) => `  L${o.lineNumber.toString()}: ${o.line.trim()}`).join('\n')}`,
    ).toEqual([]);
  });

  it('reads `config.dashboardOrigin` at least once', () => {
    // Sanity check: if a future refactor renames the field, this fires
    // alongside the source-match guards above and forces the developer
    // to update both layers in lockstep.
    expect(SOURCE).toContain('config.dashboardOrigin');
  });
});
