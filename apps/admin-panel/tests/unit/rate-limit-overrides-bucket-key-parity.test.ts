// W342.C — drift guard for the admin /rate-limit-overrides page
// bucket_key taxonomy. Both BUCKET_LABEL maps (frontmatter +
// inline script) and the MockOverride.bucketKey type union must
// match the canonical bucket_key enum on the server-side
// QuotaOverrideAdmin schema: ['global', 'sessions:create'].
//
// Prior drift caught + fixed by this wave: the page used the
// (fictional) 'session_create' + 'capture' bucket keys. Both
// would 400 on the live POST /v1/admin/accounts/:id/quota-override
// because the server's Zod schema enforces the colonated form.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');
const ADMIN_SCHEMA = resolve(REPO_ROOT, 'packages/api-types/src/admin.ts');
const ACCOUNTS_SCHEMA = resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W342.C admin /rate-limit-overrides bucket_key parity', () => {
  const page = read(PAGE);
  const adminSchema = read(ADMIN_SCHEMA);
  const accountsSchema = read(ACCOUNTS_SCHEMA);

  // Canonical bucket-key enum. Three Zod declarations use it
  // (admin override create / clear + per-account quota POST); pin
  // that they all agree.
  const canonical = "z.enum(['global', 'sessions:create'])";

  it('admin.ts declares the canonical bucket_key enum', () => {
    expect(adminSchema).toContain(canonical);
  });

  it('accounts.ts declares the matching bucket_key enum for quota-override POST', () => {
    expect(accountsSchema).toContain(canonical);
  });

  it("MockOverride.bucketKey type union matches ['global', 'sessions:create']", () => {
    expect(page).toMatch(/bucketKey:\s*'global'\s*\|\s*'sessions:create';/);
  });

  it('no doc-drift bucket-key names (session_create / capture) remain', () => {
    // Catches the prior drift if it ever reappears.
    expect(page).not.toMatch(/'session_create'/);
    expect(page).not.toMatch(/'capture':/);
  });

  it("frontmatter BUCKET_LABEL keys are exactly {'global', 'sessions:create'}", () => {
    const block = page.match(/BUCKET_LABEL:[^={]*=?\s*\{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s*(?:'([^']+)'|([a-z_]+)):\s*'[^']+',/gm)]
      .map((m) => m[1] ?? m[2]!)
      .sort();
    expect(keys).toEqual(['global', 'sessions:create']);
  });

  it("inline-script BUCKET_LABEL keys are exactly {'global', 'sessions:create'}", () => {
    // Frontmatter declares `const BUCKET_LABEL: Record<…> = { … }`
    // (typed); the inline-script copy is plain JS `const
    // BUCKET_LABEL = { … }`. Grab the second form specifically.
    const inline = page.match(/const BUCKET_LABEL\s*=\s*\{([\s\S]*?)\};/);
    expect(inline).not.toBeNull();
    const keys = [...inline![1]!.matchAll(/^\s*(?:'([^']+)'|([a-z_]+)):\s*'[^']+',/gm)]
      .map((m) => m[1] ?? m[2]!)
      .sort();
    expect(keys).toEqual(['global', 'sessions:create']);
  });

  it('DELETE call still posts bucket_key as the query param name', () => {
    // The DELETE URL builder passes the raw bucketKey through; if
    // the param name ever drifts to bucketKey/key the server's
    // schema would reject.
    expect(page).toMatch(/\/quota-override\?bucket_key=/);
  });
});
