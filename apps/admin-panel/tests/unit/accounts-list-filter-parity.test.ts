// W346.C — drift guard for admin /accounts list page. The filter
// bar exposes status + tier dropdowns; if either drifts away from
// the canonical schema enum the staff member's filter silently
// returns nothing.
//
// Constraints:
//   • Status dropdown options ⊆ AccountStatusSchema (+ empty
//     "All statuses" pass-through)
//   • Tier dropdown options ⊆ AccountTierSchema (+ empty "All
//     tiers")
//   • STATUS_BADGE keys ↔ AccountStatusSchema exactly (already
//     mirrored in the per-account detail page; pinning the list
//     view too)
//   • Tier dropdown enumerates all 8 tiers — catches accidental
//     truncation when an enterprise variant lands

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStatusSchema, AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W346.C admin /accounts list filter parity', () => {
  const page = read(PAGE);
  const statuses = new Set<string>(
    (AccountStatusSchema._def as { values: readonly string[] }).values,
  );
  const tiers = new Set<string>((AccountTierSchema._def as { values: readonly string[] }).values);

  // Extract the two <select> blocks by their data-field. Each
  // block carries its own <option value="..."> list.
  function optionsOf(field: string): string[] {
    const block = page.match(new RegExp(`<select\\s+data-field="${field}"[\\s\\S]*?</select>`, ''));
    expect(block).not.toBeNull();
    return [...block![0]!.matchAll(/<option value="([a-z_]*)">/g)].map((m) => m[1]!).sort();
  }

  it('status dropdown options = empty + AccountStatusSchema', () => {
    const opts = optionsOf('status');
    expect(opts).toEqual(['', ...statuses].sort());
  });

  it('tier dropdown options = empty + AccountTierSchema (all 8 tiers)', () => {
    const opts = optionsOf('tier');
    expect(opts).toEqual(['', ...tiers].sort());
    expect(tiers.size).toBe(8);
  });

  it('STATUS_BADGE keys match AccountStatusSchema exactly', () => {
    const block = page.match(/const STATUS_BADGE\s*=\s*\{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const keys = [...block![1]!.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();
    expect(keys).toEqual([...statuses].sort());
  });

  it('tier dropdown labels use the canonical Title Case (Trial pack / Personal / etc.)', () => {
    // Pin the label text. A future "Pro" rename of api_scale needs
    // to land here too.
    const block = page.match(/<select\s+data-field="tier"[\s\S]*?<\/select>/);
    expect(block).not.toBeNull();
    for (const label of [
      'Free',
      'Personal',
      'Team',
      'Agency',
      'API Starter',
      'API Builder',
      'API Scale',
      'Enterprise',
    ]) {
      expect(block![0]!).toContain(label);
    }
  });

  it('email-search filter input is wired (data-field="search")', () => {
    expect(page).toMatch(/data-field="search"/);
    expect(page).toMatch(/Search by email substring/);
  });

  it('row drill-down narrative pins the per-account detail surface (tier change / suspend / audit slice)', () => {
    expect(page).toMatch(
      /click a row to drill into\s+per-account detail \(tier change, suspend, audit log slice\)/,
    );
  });

  it('page hits GET /v1/admin/accounts via the inline script', () => {
    expect(page).toMatch(/\/v1\/admin\/accounts/);
  });
});
