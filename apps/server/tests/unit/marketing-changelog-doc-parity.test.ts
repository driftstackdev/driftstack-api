// W248.C — drift-guard for /changelog (the top-level marketing
// changelog, distinct from /docs/api-changelog). The page is
// hand-authored highlights; this guard pins the entry interface +
// known category enum so future edits don't quietly add new
// categories that break sort/filter consumers later, and verifies
// the page consistently cites the live primitives (HMAC-SHA256
// webhooks, scrypt API keys, /v1/account/audit-log, etc.).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'changelog.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W248.C /changelog doc parity', () => {
  const doc = read();

  it('keeps the locked category enum', () => {
    expect(doc).toMatch(
      /category:\s*'launch'\s*\|\s*'sdk'\s*\|\s*'docs'\s*\|\s*'security'\s*\|\s*'pricing'\s*\|\s*'self-hosted'/,
    );
  });

  it('references webhook rotation with the 24-hour grace window', () => {
    expect(doc).toMatch(/24-hour grace/);
    // And the dual-signing header pair.
    expect(doc).toMatch(/x-driftstack-signature.*x-driftstack-signature-prev/);
  });

  it('does not promise customer-controlled egress as a shipped changelog entry', () => {
    expect(doc).not.toMatch(/customer-controlled egress/i);
  });

  it('keeps the entry shape (date / category / title / body)', () => {
    expect(doc).toMatch(/interface ChangelogEntry/);
    expect(doc).toMatch(/date:\s*string;/);
    expect(doc).toMatch(/title:\s*string;/);
    expect(doc).toMatch(/body:\s*string;/);
  });

  it('cites /trust/sub-processors for residency context', () => {
    expect(doc).toMatch(/\/trust\/sub-processors/);
  });
});
