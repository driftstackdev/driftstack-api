// V-1724 — signing in through an IDP with a Gmail alias of an existing account
// must reach the merge flow, not a 500.
//
// ⛔ THIS WAS OBSERVED, NOT REASONED ABOUT. Against a real database: an account
// created as `first.last@gmail.com` stores `canonical_email` =
// `firstlast@gmail.com`. The OAuth collision check consulted only the literal
// column, missed, fell through to `createFromIdp`, and the insert died on
// `accounts_canonical_email_unique` — a server error on an auth path, where the
// correct merge flow was already built and simply unreachable.
//
// ⚠️ The drift is dated and the lesson is about where a sweep looks. The wiring
// is 2026-05-15; canonical dedup and its safe helper arrived 2026-07-01 and moved
// four callers in `auth-flows.ts` across. The fifth lives in `bootstrap.ts`, and
// neither file shows the problem alone.
//
// So this asserts the REPOSITORY-level behaviour the fix depends on, over a real
// Postgres: that a canonical lookup finds what the literal lookup cannot, and
// that the two spellings genuinely collide on the unique index. Both halves
// matter — without the second, a canonical hit could be a coincidence rather
// than the thing that would otherwise have thrown.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema.js';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { canonicalizeEmailForDedup } from '../../src/services/auth-flows.js';

const DB_URL = process.env.DATABASE_URL ?? '';
const enabled = DB_URL.length > 0;

let client: ReturnType<typeof postgres>;
let repo: DrizzleAuthFlowsRepo;

beforeAll(() => {
  if (!enabled) return;
  client = postgres(DB_URL, { max: 2 });
  const db = drizzle(client, { schema });
  repo = new DrizzleAuthFlowsRepo({ client, db, close: async () => client.end({ timeout: 5 }) });
});

afterAll(async () => {
  if (enabled && client) await client.end({ timeout: 5 });
});

describe.runIf(enabled)('OAuth sign-in finds a canonical email match', () => {
  it('CRITICAL the literal lookup MISSES an alias and the canonical lookup FINDS it. The miss is the defect; asserting only the hit would pass against a repo where both lookups were literal.', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const dotted = `first.last.${tag}@gmail.com`;
    const undotted = `firstlast${tag}@gmail.com`;

    const created = await repo.createAccount({
      email: dotted,
      name: 'V1724',
      passwordHash: '',
      initialTier: 'free',
    });
    expect(created, 'the seed account was created').toBeTruthy();

    expect(
      await repo.findAccountByEmail(undotted),
      'the literal lookup must MISS — this is what sent the caller into createFromIdp',
    ).toBeNull();

    const byCanonical = await repo.findAccountByCanonicalEmail(canonicalizeEmailForDedup(undotted));
    expect(byCanonical, 'the canonical lookup finds the same account').not.toBeNull();
    expect(byCanonical?.email).toBe(dotted);
  });

  it('CRITICAL creating the alias as a NEW account is refused by the database. Without this the arm above proves only that a lookup works, not that skipping it produces the 500 the customer saw.', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    await repo.createAccount({
      email: `a.b.${tag}@gmail.com`,
      name: 'V1724b',
      passwordHash: '',
      initialTier: 'free',
    });

    await expect(
      repo.createAccount({
        email: `ab${tag}@gmail.com`,
        name: 'V1724c',
        passwordHash: '',
        initialTier: 'free',
      }),
      'the undotted alias must not be insertable alongside the dotted original',
    ).rejects.toThrow();
  });

  it('a NON-Gmail address is unaffected — canonicalisation is Gmail-only, so two literal spellings elsewhere stay two accounts', async () => {
    const tag = randomUUID().slice(0, 8).replace(/-/g, '');
    const a = `first.last.${tag}@example.com`;
    const b = `firstlast${tag}@example.com`;
    await repo.createAccount({ email: a, name: 'V1724d', passwordHash: '', initialTier: 'free' });
    const second = await repo.createAccount({
      email: b,
      name: 'V1724e',
      passwordHash: '',
      initialTier: 'free',
    });
    expect(second, 'a non-Gmail alias is a different account and inserts fine').toBeTruthy();
  });
});
