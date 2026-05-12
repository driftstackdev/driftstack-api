// W243.C — drift-guard for /docs/pagination. The page describes the
// canonical cursor-paged response envelope (`data` / `has_more` /
// `next_cursor`) used across every Driftstack list endpoint. This
// guard fails if the doc drifts from the shared CursorQuerySchema +
// account_me response shape, or quietly reasserts offset-pagination.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'pagination.astro');
const COMMON = join(REPO, 'packages', 'api-types', 'src', 'common.ts');
const OPENAPI = join(REPO, 'apps', 'server', 'src', 'lib', 'openapi.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W243.C pagination doc parity', () => {
  const doc = read(DOC_PATH);
  const common = read(COMMON);
  const openapi = read(OPENAPI);

  it('pins limit clamp to 1-100 with default 50 from CursorQuerySchema', () => {
    // Source of truth in common.ts.
    expect(common).toMatch(
      /limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\)/,
    );
    // Doc reflects same bounds.
    expect(doc).toMatch(/integer 1-100/);
    expect(doc).toMatch(/Defaults to\s*<strong>50<\/strong>/);
    expect(doc).toMatch(/Hard cap at 100/);
  });

  it('uses data + has_more + next_cursor envelope, not offset pagination', () => {
    expect(doc).toMatch(/"data":\s*\[/);
    expect(doc).toMatch(/"has_more":/);
    expect(doc).toMatch(/"next_cursor":/);
    // Forbidden offset-page framing.
    expect(doc).not.toMatch(/page=\d+&size=\d+/);
    expect(doc).not.toMatch(/\?offset=\d+/);
  });

  it('does not promise a total-count field on list responses', () => {
    expect(doc).toMatch(/do\s*<strong>not<\/strong>\s*include a total-count/);
  });

  it('references the real profile_count field on /v1/account/me', () => {
    expect(openapi).toMatch(/profile_count:\s*z\.number/);
    expect(doc).toMatch(/profile_count/);
  });

  it('links to /docs/rate-limits for 429 handling guidance', () => {
    expect(doc).toMatch(/\/docs\/rate-limits/);
  });
});
