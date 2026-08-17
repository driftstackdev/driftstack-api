// Cross-source invariant: the audit-log export ceiling appears in FOUR
// places — the route's EXPORT_MAX_ROWS constant, the docs/api/audit-log.md
// customer-facing copy, the marketing-site /docs/audit-log.astro reference,
// and the privacy policy at legal/privacy.md. Drift on the cap would either
// surprise customers ("I asked for 50k rows; got 10k truncated") or invite
// memory blowup on the server (DoS vector).
//
// ⚠️ This said "3+ places" and enumerated three. The fourth — the PRIVACY
// POLICY, which tells customers their data export is "capped at 10,000 rows
// per export" — was outside it, so the cap could move and leave a legal page
// stating a figure the server no longer applied. Found by sweeping the
// marketing/dashboard surfaces for numeric claims no test that reads the page
// also names. The "+" in "3+" was doing real work; the set is now enumerated.
//
// The figure is also no longer typed into each assertion. It is read from
// EXPORT_MAX_ROWS and formatted, so moving the cap reds every surface with a
// message naming both values instead of requiring five literals to be updated
// by hand. (A regex over a single-line `const X = N;` is safe in a way that
// parsing a multi-line parameter list is not.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');
const MARKETING = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/audit-log.astro');
const PRIVACY = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('audit-log export 10k-row ceiling cross-source invariant', () => {
  const route = read(ROUTE);
  const docs = read(DOCS);
  const marketing = read(MARKETING);
  const privacy = read(PRIVACY);

  /** The ceiling the route actually applies. */
  const enforced = (() => {
    const found = /const EXPORT_MAX_ROWS = (\d[\d_]*);/.exec(route);
    expect(
      found?.[1],
      'EXPORT_MAX_ROWS is no longer a plain literal — teach this reader',
    ).toBeTruthy();
    return Number(found![1]!.replace(/_/g, ''));
  })();
  const grouped = enforced.toLocaleString('en-US');

  it('routes/account-audit pins EXPORT_MAX_ROWS = 10_000 constant + the row-fetch loop guard', () => {
    expect(route).toMatch(/const EXPORT_MAX_ROWS = 10_000;/);
    expect(route).toMatch(/while \(all\.length < EXPORT_MAX_ROWS\) \{/);
  });

  it('routes/account-audit sets truncated flag when row-count hits the cap', () => {
    expect(route).toMatch(/const truncated = all\.length >= EXPORT_MAX_ROWS;/);
  });

  it("docs/api/audit-log.md customer copy claims 'Cap: 10,000 rows per file.' + 'truncated flag is true when the row count hit the 10,000-row' — pinned so the customer-facing claim matches the server-side EXPORT_MAX_ROWS constant", () => {
    expect(docs).toMatch(new RegExp(`Cap: ${grouped} rows per file\\.`));
    expect(docs).toMatch(
      new RegExp('The `truncated` flag is `true` when the row count hit the ' + grouped + '-row'),
    );
  });

  it("docs/api/audit-log.md sample-output references '10,000 audit-log entries' as the upper bound", () => {
    expect(docs).toMatch(
      new RegExp(
        `\\/\\* up to ${grouped} audit-log entries — same shape as the read endpoint \\*\\/`,
      ),
    );
  });

  it('marketing-site /docs/audit-log.astro references the 10,000-row ceiling in the inline endpoint annotation', () => {
    expect(marketing).toMatch(
      new RegExp(
        `<code>GET \\/v1\\/account\\/audit-log\\/export\\?format=csv<\\/code> \\(${grouped}-row`,
      ),
    );
  });

  it('CRITICAL the PRIVACY POLICY states the ceiling the route applies', () => {
    const claimed = /capped at ([\d,]+) rows per export/.exec(privacy);
    expect(claimed?.[1], 'the privacy policy no longer states an export ceiling').toBeTruthy();
    expect(
      claimed![1],
      `the privacy policy tells customers their export is capped at ${claimed?.[1]} rows, but the route applies ${grouped}`,
    ).toBe(grouped);
  });
});
