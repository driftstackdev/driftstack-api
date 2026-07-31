// Drift guard for the durable direct-operation fences (slice 1 of
// docs/internal/durable-direct-operation-design.md).
//
// The integration suite proves the fences hold against real Postgres, but it
// skips wherever no database is reachable. These assertions run everywhere and
// pin the parts whose quiet removal would disable a fence without failing
// anything obvious: the two partial unique indexes must exist in BOTH the DDL
// and the Drizzle table with the SAME predicates, the incarnation column must
// stay NOT NULL, and the terminal CAS must keep both of its predicates.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION = read('apps/server/src/db/migrations/0108_session_operations.sql');
const SCHEMA = read('apps/server/src/db/schema.ts');
const REPO = read('apps/server/src/db/session-operations-repo.ts');

const ADMISSION_INDEX = 'session_operations_one_live_per_session';
const IDEMPOTENCY_INDEX = 'session_operations_account_idempotency_key';

describe('durable direct-operation fences are declared consistently', () => {
  it('CRITICAL both partial unique indexes exist in the DDL and in the Drizzle table. A fence present in only one place is a fence the other layer will silently drop on the next generated migration.', () => {
    for (const index of [ADMISSION_INDEX, IDEMPOTENCY_INDEX]) {
      expect(MIGRATION, `${index} missing from the migration`).toContain(index);
      expect(SCHEMA, `${index} missing from the Drizzle table`).toContain(index);
    }
  });

  it('CRITICAL the admission fence stays PARTIAL on live statuses. Without the predicate it would be a unique index on session_id alone, which forbids a session from ever running a second operation; with the wrong predicate it stops excluding anything.', () => {
    expect(MIGRATION).toMatch(
      /ON "session_operations" \("session_id"\)\s*\n\s*WHERE "status" IN \('queued', 'running'\)/,
    );
    expect(SCHEMA).toMatch(
      /\.on\(t\.sessionId\)\s*\n\s*\.where\(sql`\$\{t\.status\} IN \('queued', 'running'\)`\)/,
    );
  });

  it('CRITICAL the idempotency fence stays account-scoped and partial. Dropping the account scope would let one customer’s key collide with another’s; dropping the partial predicate would make every key-less operation collide on a shared NULL.', () => {
    expect(MIGRATION).toMatch(
      /ON "session_operations" \("account_id", "idempotency_key_hash"\)\s*\n\s*WHERE "idempotency_key_hash" IS NOT NULL/,
    );
    expect(SCHEMA).toMatch(/\.on\(t\.accountId, t\.idempotencyKeyHash\)/);
  });

  it('CRITICAL driver_incarnation_id stays NOT NULL. Fence 3 compares against it on every terminal write, so a nullable column would disable that fence for any row that omitted it.', () => {
    expect(MIGRATION).toMatch(/"driver_incarnation_id" uuid NOT NULL/);
    expect(SCHEMA).toMatch(/driverIncarnationId: uuid\('driver_incarnation_id'\)\.notNull\(\)/);
  });

  it('CRITICAL the terminal CAS keeps BOTH predicates — live status AND incarnation. Losing the status predicate lets a settled outcome be rewritten; losing the incarnation predicate lets a superseded driver settle a successor’s operation. Each was mutation-proved to red exactly one integration case.', () => {
    const settle = REPO.slice(REPO.indexOf('async settle('));
    expect(settle).toContain('inArray(sessionOperations.status, [...LIVE_STATUSES])');
    expect(settle).toContain('eq(sessionOperations.driverIncarnationId, args.driverIncarnationId)');
    expect(REPO).toMatch(/const LIVE_STATUSES = \['queued', 'running'\] as const;/);
  });

  it('CRITICAL admit resolves idempotency BEFORE session-busy. A caller retrying after a dropped connection holds the same key AND their own live operation, so checking busy first turns their safe retry into a 409 — mutation-proved to red two integration cases.', () => {
    const admit = REPO.slice(
      REPO.indexOf('async admit('),
      REPO.indexOf('async findLiveForSession('),
    );
    const keyBranch = admit.indexOf('args.idempotencyKeyHash !== null');
    const busyBranch = admit.indexOf('findLiveForSession');
    expect(keyBranch).toBeGreaterThan(-1);
    expect(busyBranch).toBeGreaterThan(-1);
    expect(keyBranch).toBeLessThan(busyBranch);
  });

  it('the deadline is never invented locally — the row carries a caller-supplied deadline rather than computing one from a constant in this layer', () => {
    expect(REPO).toContain('deadlineAt: args.deadlineAt');
    expect(REPO).not.toMatch(/600_?000/);
  });
});
