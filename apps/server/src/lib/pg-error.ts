// Postgres error-field extraction that survives drizzle-orm's error wrapping.
//
// Background: the codebase translates Postgres unique-violations (SQLSTATE
// 23505) into clean domain errors (409 ConflictError / SLUG_TAKEN / idempotent
// replay) at several catch sites — auth-repo (slug), profiles (name race),
// auth-flows (signup email), agent-sessions (idempotency). Those sites read
// `err.code` / `err.constraint_name` from the TOP LEVEL of the thrown error,
// which is where postgres-js puts them under drizzle-orm 0.38.
//
// drizzle-orm 0.45 wraps every failed query in a `DrizzleQueryError` whose
// original postgres-js error (carrying `code` / `constraint_name`) moves to
// `err.cause`. A top-level-only read would then MISS the 23505 → the catch
// falls through → an uncaught 500 instead of the intended 409/replay, across
// the whole unique-violation family.
//
// This helper reads the field from `err` AND `err.cause` (top level first, so
// the 0.38 shape is matched identically — no behavior change on the current
// version), making the translation correct on BOTH drizzle versions. It lets
// the cause-aware code ship + be validated on 0.38 ahead of the 0.45 bump,
// rather than coupling the migration to the dep upgrade. One level of cause
// unwrapping is enough for DrizzleQueryError; the loop is bounded regardless.

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Read a Postgres error field (`code` / `constraint_name`) from a thrown error,
 * checking the top level first then `err.cause` (drizzle 0.45 wraps the pg
 * error there). Returns the first string value found, or undefined.
 */
export function pgErrorField(err: unknown, field: 'code' | 'constraint_name'): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True iff `err` is a Postgres unique-violation (SQLSTATE 23505). When
 * `constraintName` is given, also requires the violated constraint to match —
 * so an unrelated 23505 from a different index doesn't get mis-translated.
 * drizzle-version-agnostic (reads top level or `err.cause`).
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (pgErrorField(err, 'code') !== PG_UNIQUE_VIOLATION) return false;
  if (constraintName === undefined) return true;
  return pgErrorField(err, 'constraint_name') === constraintName;
}
