// Unit tests for lib/pg-error.ts — the drizzle-version-agnostic Postgres
// error-field extraction behind the 23505 → 409 translation family.
//
// The whole point: read `code` / `constraint_name` whether they sit at the
// TOP LEVEL (postgres-js under drizzle 0.38) or under `err.cause` (drizzle
// 0.45 wraps the pg error in a DrizzleQueryError). Both shapes are exercised
// so the helper is proven correct ahead of the 0.45 bump.

import { describe, expect, it } from 'vitest';
import { pgErrorField, isUniqueViolation } from '../../src/lib/pg-error.js';

/** drizzle 0.38 shape: postgres-js error with fields at the top level. */
function pgErr038(code: string, constraint?: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    ...(constraint !== undefined ? { constraint_name: constraint } : {}),
  });
}

/** drizzle 0.45 shape: DrizzleQueryError wrapping the pg error in `cause`. */
function pgErr045(code: string, constraint?: string): Error {
  const wrapper = new Error('Failed query: insert into ...');
  return Object.assign(wrapper, { cause: pgErr038(code, constraint) });
}

describe('pgErrorField', () => {
  it('reads code/constraint_name from the top level (drizzle 0.38 shape)', () => {
    const e = pgErr038('23505', 'accounts_slug_unique');
    expect(pgErrorField(e, 'code')).toBe('23505');
    expect(pgErrorField(e, 'constraint_name')).toBe('accounts_slug_unique');
  });

  it('reads code/constraint_name from err.cause (drizzle 0.45 wrapped shape)', () => {
    const e = pgErr045('23505', 'accounts_slug_unique');
    expect(pgErrorField(e, 'code')).toBe('23505');
    expect(pgErrorField(e, 'constraint_name')).toBe('accounts_slug_unique');
  });

  it('returns undefined when the field is absent / err is not an object', () => {
    expect(pgErrorField(new Error('plain'), 'code')).toBeUndefined();
    expect(pgErrorField(null, 'code')).toBeUndefined();
    expect(pgErrorField('a string', 'code')).toBeUndefined();
    expect(pgErrorField(pgErr038('23505'), 'constraint_name')).toBeUndefined();
  });

  it('does not loop unboundedly on a self-referential cause chain', () => {
    const e = new Error('w') as Error & { cause?: unknown };
    e.cause = e; // cyclic
    expect(pgErrorField(e, 'code')).toBeUndefined();
  });
});

describe('isUniqueViolation', () => {
  for (const [label, mk] of [
    ['0.38 top-level', pgErr038],
    ['0.45 err.cause', pgErr045],
  ] as const) {
    it(`matches 23505 + constraint (${label})`, () => {
      expect(isUniqueViolation(mk('23505', 'profiles_account_name_unique'))).toBe(true);
      expect(
        isUniqueViolation(
          mk('23505', 'profiles_account_name_unique'),
          'profiles_account_name_unique',
        ),
      ).toBe(true);
    });

    it(`rejects a different constraint (${label}) — no mis-translation of an unrelated 23505`, () => {
      expect(isUniqueViolation(mk('23505', 'some_other_unique'), 'accounts_slug_unique')).toBe(
        false,
      );
    });

    it(`rejects a non-23505 code (${label})`, () => {
      expect(isUniqueViolation(mk('23503', 'accounts_slug_unique'), 'accounts_slug_unique')).toBe(
        false,
      );
      expect(isUniqueViolation(mk('23503'))).toBe(false);
    });

    it(`code-only mode matches any 23505 (${label}) — the agent-sessions idempotency case`, () => {
      expect(isUniqueViolation(mk('23505'))).toBe(true);
      expect(isUniqueViolation(mk('23505', 'agent_sessions_idempotency_key_unique'))).toBe(true);
    });
  }

  it('returns false for a plain Error / non-error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(new Error('boom'), 'accounts_slug_unique')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
