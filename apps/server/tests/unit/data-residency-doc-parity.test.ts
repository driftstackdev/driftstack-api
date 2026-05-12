// W244.A — drift-guard for /docs/data-residency. Pins the doc's
// claims about the `region` account preference enum + the PATCH
// route that updates it. Prevents the doc from quietly drifting
// (e.g. listing a region code that isn't in the Postgres enum).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'data-residency.astro',
);
const SCHEMA = join(REPO, 'apps', 'server', 'src', 'db', 'schema.ts');
const ACCOUNT_ME = join(REPO, 'apps', 'server', 'src', 'routes', 'account-me.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W244.A data-residency doc parity', () => {
  const doc = read(DOC_PATH);
  const schema = read(SCHEMA);
  const accountMe = read(ACCOUNT_ME);

  it('region enum in doc matches the account_region pgEnum', () => {
    // Live values come from the pgEnum.
    expect(schema).toMatch(
      /pgEnum\(\s*['"]account_region['"],\s*\[['"]us['"],\s*['"]eu['"],\s*['"]apac['"]\s*\]\)/,
    );
    // Doc lists exactly those three plus null.
    expect(doc).toMatch(/<code>us<\/code>/);
    expect(doc).toMatch(/<code>eu<\/code>/);
    expect(doc).toMatch(/<code>apac<\/code>/);
    expect(doc).toMatch(/<code>null<\/code>/);
    // No fictional region codes.
    expect(doc).not.toMatch(/<code>(emea|amer|latam|africa)<\/code>/i);
  });

  it('points at the live PATCH endpoint for the region field', () => {
    expect(accountMe).toMatch(/app\.patch\(\s*['"]\/v1\/account\/me['"]/);
    expect(doc).toMatch(/PATCH \/v1\/account\/me/);
  });

  it('asserts EU-primary posture consistent with W229 security-overview', () => {
    expect(doc).toMatch(/primarily in the EU/i);
    expect(doc).toMatch(/never leaves the EU/i);
  });

  it('does not promise customer-configurable retention on captures', () => {
    // W238/W217 — capture retention is operator-tuned, not a customer knob.
    expect(doc).not.toMatch(/customer-configurable\s+(capture|retention)/i);
    expect(doc).not.toMatch(/Default\s+30\s+days\s+for\s+screenshots/);
  });

  it('cross-links to /legal/sub-processors for the canonical list', () => {
    expect(doc).toMatch(/\/legal\/sub-processors/);
  });
});
