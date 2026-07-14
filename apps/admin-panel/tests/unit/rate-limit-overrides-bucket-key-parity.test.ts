// W342.C — drift guard for the admin /rate-limit-overrides page
// bucket_key taxonomy. The canonical server-side enum is
// ['global', 'sessions:create', 'agent_sessions:message']. Both
// live BUCKET_LABEL map must cover the full enum so every bucket
// renders a friendly label (agent_sessions:message previously fell
// through to the raw key). The page intentionally has no fabricated
// SSR override rows or duplicate frontmatter map.
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
  const canonical = "z.enum(['global', 'sessions:create', 'agent_sessions:message'])";

  it('admin.ts declares the canonical bucket_key enum', () => {
    expect(adminSchema).toContain(canonical);
  });

  it('accounts.ts read-surface enum is the 4-key superset (3 override-able + read-only input_event)', () => {
    // The GET /v1/account/rate-limits READ surface returns ALL enforced buckets,
    // including agent_sessions:input_event — which has NO admin-override path, so the
    // 3-key override enum stays in admin.ts (asserted above). accounts.ts is therefore
    // a SUPERSET of the override set, not an exact match; pin every key is present.
    for (const k of [
      'global',
      'sessions:create',
      'agent_sessions:message',
      'agent_sessions:input_event',
    ]) {
      expect(accountsSchema).toContain(`'${k}'`);
    }
  });

  it('does not restore a fabricated preview-only override type', () => {
    expect(page).not.toContain('MockOverride');
    expect(page).not.toMatch(/const\s+MOCK_OVERRIDES\b/);
  });

  it('no doc-drift bucket-key names (session_create / capture) remain', () => {
    // Catches the prior drift if it ever reappears.
    expect(page).not.toMatch(/'session_create'/);
    expect(page).not.toMatch(/'capture':/);
  });

  it("live BUCKET_LABEL keys cover the full canonical enum {'global', 'sessions:create', 'agent_sessions:message'}", () => {
    const inline = page.match(/const BUCKET_LABEL\s*=\s*\{([\s\S]*?)\};/);
    expect(inline).not.toBeNull();
    const keys = [...inline![1]!.matchAll(/^\s*(?:'([^']+)'|([a-z_]+)):\s*'[^']+',/gm)]
      .map((m) => m[1] ?? m[2]!)
      .sort();
    expect(keys).toEqual(['agent_sessions:message', 'global', 'sessions:create']);
    expect(page).toMatch(/BUCKET_LABEL\[o\.bucket_key\]\s*\|\|\s*o\.bucket_key/);
  });

  it('DELETE call still posts bucket_key as the query param name', () => {
    // The DELETE URL builder passes the raw bucketKey through; if
    // the param name ever drifts to bucketKey/key the server's
    // schema would reject.
    expect(page).toMatch(/\/quota-override\?bucket_key=/);
  });
});
