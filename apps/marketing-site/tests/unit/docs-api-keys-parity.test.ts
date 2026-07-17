// W265.A — drift-guard for marketing /docs/api-keys. Pins SCOPES +
// GRANULAR arrays to the live ApiKeyScopeSchema enum.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema, TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W265.A /docs/api-keys ↔ ApiKeyScopeSchema parity', () => {
  const page = read(PAGE);
  const liveScopes = new Set(ApiKeyScopeSchema.options);

  it('every SCOPES + GRANULAR entry in the page is a real ApiKeyScopeSchema value', () => {
    const all = [...page.matchAll(/\{\s*name:\s*'([a-z][\w:-]*)'/g)].map((m) => m[1]!);
    expect(all.length).toBeGreaterThan(10);
    const offenders = all.filter((s) => !liveScopes.has(s as never));
    expect(offenders).toEqual([]);
  });

  it('every live granular scope is documented in the GRANULAR table', () => {
    const granular = [...liveScopes].filter((s) => s.includes(':'));
    for (const g of granular) {
      expect(page).toMatch(new RegExp(`name:\\s*'${g}'`));
    }
  });

  it('documents the paid customer-key and Free desktop-device boundary', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(page).toContain('Customer-key format: <code>ds_live_&lt;random&gt;</code>');
    expect(page).toContain('restricted <code>ds_test_…</code> device credential');
    expect(page).toContain('not a customer API key, a general SDK key, or a sandbox credential');
    expect(page).toContain('A Free dashboard web session can list and revoke keys');
    expect(page).toContain('create and rotate return an RFC 9457');
  });

  it('documents live rotation and audit metadata fields', () => {
    expect(page).toContain('<code>last_used_at</code>');
    expect(page).toContain('<code>actor_key_id</code>');
    expect(page).toContain('<code>actor_key_id: null</code>');
    expect(page).toContain('the public field is not named');
  });

  it('does not surface staff-only driftstack_internal_admin in customer copy', () => {
    // The page may mention this in an internal author-comment, but it
    // must not appear in customer-visible markup (no <code> tag, no
    // SCOPES/GRANULAR entry).
    expect(page).not.toMatch(/<code>driftstack_internal_admin<\/code>/);
    expect(page).not.toMatch(/name:\s*'driftstack_internal_admin'/);
  });

  it('does not surface the GUI-only gui_control scope in customer copy', () => {
    expect(page).not.toMatch(/<code>gui_control<\/code>/);
    expect(page).not.toMatch(/name:\s*'gui_control'/);
  });

  it('broad-satisfies-granular rule (V-481) is documented', () => {
    expect(page).toMatch(/A key with <code>read<\/code>/);
    expect(page).toMatch(/read:sessions/);
  });
});
