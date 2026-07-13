// Security regression guard for provider-scoped account email identity.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalizeEmailForDedup } from '../../src/services/auth-flows.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MIGRATION = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0102_accounts_canonical_email_provider_scope.sql',
);

describe('provider-scoped email canonicalization', () => {
  it('folds Gmail aliases but preserves plus and dot characters for other providers', () => {
    expect(canonicalizeEmailForDedup('f.o.o+tag@gmail.com')).toBe('foo@gmail.com');
    expect(canonicalizeEmailForDedup('f.o.o+tag@googlemail.com')).toBe('foo@googlemail.com');
    expect(canonicalizeEmailForDedup('f.o.o+tag@example.com')).toBe('f.o.o+tag@example.com');
  });

  it('backfills only non-Gmail canonical values to the stored literal email', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/SET "canonical_email" = lower\("email"\)/);
    expect(sql).toMatch(
      /WHERE lower\(split_part\("email", '@', 2\)\) NOT IN \('gmail\.com', 'googlemail\.com'\)/,
    );
    expect(sql).toMatch(/"canonical_email" IS DISTINCT FROM lower\("email"\)/);
  });
});
