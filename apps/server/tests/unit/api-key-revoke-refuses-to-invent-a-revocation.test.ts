// `revokeApiKeyAtomic` must never report a revocation it cannot see.
//
// The method revokes with a conditional UPDATE:
//
//   UPDATE api_keys SET revoked_at = … WHERE <scope> AND revoked_at IS NULL RETURNING *
//
// and, when that matches nothing, re-reads the row under the SAME scope to find
// out why. Two answers are legitimate — the row is gone (`not_found`), or someone
// else revoked it first and the loser returns the winner's timestamp
// (`already_revoked`). The third branch is the one under test:
//
//   if (key.revokedAt === null) throw new Error('revokeApiKeyAtomic lost its update …')
//
// A row that is present with `revoked_at` still NULL, after an update predicated on
// exactly that condition matched nothing, is a contradiction. Nothing in the
// codebase clears `revoked_at`, so the column only ever goes NULL → set; the state
// therefore should not arise, and the guard exists to say so out loud.
//
// Why it earns a test anyway: the caller-visible consequence of REMOVING it is not
// a crash but a WRONG ANSWER. Execution falls through to
// `return { kind: 'already_revoked', key }` — carrying the row it just read, whose
// `revokedAt` is null. The service reports the key as already revoked, the customer
// is told a key is dead, and the key keeps authenticating. Revocation is the
// control a customer reaches for when a key has leaked, so "reported revoked but
// still live" is the worst direction for this particular lie.
//
// Reaching the branch needs a state Postgres will not produce, so the database is
// stubbed rather than driven: the update matches nothing, the re-read returns a row
// with `revokedAt: null`. That is precisely the contradiction, injected directly.
// Both other branches are asserted alongside it, so a stub that simply refused
// everything could not satisfy the suite.
//
// From the never-executed-throw sweep (coverage taken WITH DATABASE_URL set, so the
// 80 integration files were running and cannot be the reason a guard looks unfired).

import { describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import type { Database } from '../../src/db/client.js';

const REVOKED_AT = new Date('2026-08-16T12:00:00.000Z');
const EARLIER = new Date('2026-08-16T11:00:00.000Z');

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'key_1',
    accountId: 'acc_1',
    name: 'a key',
    keyPrefix: 'dsk_live_aaaa',
    keyHash: 'h'.repeat(64),
    scopes: ['read'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    provenance: 'customer',
    createdAt: EARLIER,
    ...over,
  };
}

/**
 * The two chains `revokeApiKeyAtomic` uses, and nothing else:
 *   update(...).set(...).where(...).returning()
 *   select().from(...).where(...).limit(1)
 * `updated` is what the conditional UPDATE returns, `reread` what the follow-up
 * SELECT returns.
 */
function stubDatabase(updated: unknown[], reread: unknown[]): Database {
  return {
    db: {
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve(updated) }) }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(reread) }) }) }),
    },
    client: {},
    close: async () => {},
  } as unknown as Database;
}

const input = { id: 'key_1', accountId: 'acc_1', revokedAt: REVOKED_AT };

describe('revokeApiKeyAtomic refuses to invent a revocation', () => {
  it('CRITICAL throws when the conditional update matched nothing yet the row re-reads with revoked_at NULL. Without this branch it falls through to already_revoked carrying that row, so the service reports a key as revoked while the key keeps authenticating — and revocation is exactly the control a customer reaches for when a key has leaked.', async () => {
    const repo = new DrizzleApiKeysRepo(stubDatabase([], [row({ revokedAt: null })]));

    await expect(repo.revokeApiKeyAtomic(input)).rejects.toThrow(/lost its update/i);
  });

  it('still reports already_revoked, with the WINNER timestamp, when the re-read shows a real revocation', async () => {
    const repo = new DrizzleApiKeysRepo(stubDatabase([], [row({ revokedAt: EARLIER })]));

    const result = await repo.revokeApiKeyAtomic(input);

    expect(result.kind).toBe('already_revoked');
    // The loser must return the persisted timestamp rather than its own, or two
    // racing revokes disagree about when the key died.
    expect(result.kind === 'already_revoked' ? result.key.revokedAt : null).toEqual(EARLIER);
  });

  it('still reports not_found when the re-read finds no row at all', async () => {
    const repo = new DrizzleApiKeysRepo(stubDatabase([], []));

    expect((await repo.revokeApiKeyAtomic(input)).kind).toBe('not_found');
  });

  it('still reports revoked when the conditional update wins', async () => {
    const repo = new DrizzleApiKeysRepo(stubDatabase([row({ revokedAt: REVOKED_AT })], []));

    const result = await repo.revokeApiKeyAtomic(input);

    expect(result.kind).toBe('revoked');
    expect(result.kind === 'revoked' ? result.key.revokedAt : null).toEqual(REVOKED_AT);
  });
});
