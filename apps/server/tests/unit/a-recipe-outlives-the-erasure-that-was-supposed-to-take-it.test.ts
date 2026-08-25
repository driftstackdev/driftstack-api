// Deleting a customer's account left their visited URLs behind, in recipes.
//
// The account-deletion sweeper already hard-deletes `agent_sessions`, and that
// arm's own docstring names `transcript` as "the customer's agent conversation".
// So erasure LOOKED complete. It was not:
//
//   `recipes.agent_session_id` is ON DELETE SET NULL *specifically so a recipe
//   survives agent-session cleanup* (schema.ts:2467-2469).
//
// That survival is correct for a live account — it is why the column is nullable
// at all — and exactly wrong for a terminated one. Purging the sessions nulled
// the pointer and left `recipes.intent_log` + `recipes.transcript_snapshot`
// sitting there, holding the same AgentIntentSchema navigate members whose `url`
// is unconstrained `z.string()`: full URLs, path and query included.
//
// ⛔ The shape of the bug is what makes it worth a dedicated file. A cascade you
// would expect to fire is deliberately disabled, so the erasure that appears to
// cover the data is the very thing that guarantees it does not. Nothing else
// purged recipes on any schedule — the only other delete over the table is the
// customer-initiated `deleteById`.

import { describe, expect, it, vi } from 'vitest';
import {
  AccountDeletionPurgeSweeperService,
  type AccountDeletionPurgeSweeperDeps,
} from '../../src/services/account-deletion-purge-sweeper.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');

/** A sweeper with only the arms a test names; everything else absent. */
function sweeper(
  deps: Partial<AccountDeletionPurgeSweeperDeps>,
): AccountDeletionPurgeSweeperService {
  return new AccountDeletionPurgeSweeperService({
    repo: { findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve([]) },
    ...deps,
  });
}

describe('a recipe outlives the erasure that was supposed to take it', () => {
  it('CRITICAL recipes are purged for a terminated account. Without this arm the customer full URLs in intent_log and transcript_snapshot survive account deletion indefinitely.', async () => {
    const purge = vi.fn(() => Promise.resolve(3));
    const result = await sweeper({
      recipes: { purgeForTerminatedAccountsBefore: purge },
    }).tickOnce(NOW);

    expect(purge, 'the recipes arm never ran').toHaveBeenCalledTimes(1);
    expect(result.recipesPurged).toBe(3);
  });

  it('CRITICAL purging agent sessions does NOT reach recipes, which is why this needs its own arm and not a cascade', async () => {
    // Both arms wired. The agent-session purge reports work done; the recipe
    // arm must still run and report its own count. If a future change makes
    // recipes cascade from agent_sessions, this arm going to zero while the
    // session arm reports 4 is the signal — not a reason to delete this test.
    const sessions = vi.fn(() => Promise.resolve(4));
    const recipes = vi.fn(() => Promise.resolve(2));
    const result = await sweeper({
      agentSessions: { purgeForTerminatedAccountsBefore: sessions },
      recipes: { purgeForTerminatedAccountsBefore: recipes },
    }).tickOnce(NOW);

    expect(result.agentSessionsPurged).toBe(4);
    expect(
      result.recipesPurged,
      'recipes were not purged alongside the sessions they deliberately outlive',
    ).toBe(2);
    expect(recipes).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL an absent recipes arm emits `skipped`, so an unwired erasure promise is visible rather than indistinguishable from having nothing to purge', async () => {
    const inc = vi.fn();
    await sweeper({ metrics: { inc } as never }).tickOnce(NOW);

    const labels = inc.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(
      labels.some((l) => l.includes('"arm":"recipes"') && l.includes('"outcome":"skipped"')),
      'an unwired recipes arm emitted nothing at all',
    ).toBe(true);
  });

  it('a failing recipes purge is swallowed and retried, never thrown — one arm must not abort the erasure of the others', async () => {
    const sessions = vi.fn(() => Promise.resolve(1));
    const error = vi.fn();
    const result = await sweeper({
      agentSessions: { purgeForTerminatedAccountsBefore: sessions },
      recipes: {
        purgeForTerminatedAccountsBefore: () => Promise.reject(new Error('deadlock')),
      },
      logger: { error } as never,
    }).tickOnce(NOW);

    // The sibling arm still completed.
    expect(result.agentSessionsPurged).toBe(1);
    expect(result.recipesPurged).toBe(0);
    expect(error, 'a failed erasure arm passed silently').toHaveBeenCalled();
  });

  it('the cutoff it purges against is the retention window, not now — a just-deleted account is not erased on the next tick', async () => {
    let seen: Date | undefined;
    await sweeper({
      recipes: {
        purgeForTerminatedAccountsBefore: (cutoff) => {
          seen = cutoff;
          return Promise.resolve(0);
        },
      },
    }).tickOnce(NOW);

    expect(seen, 'no cutoff reached the arm').toBeInstanceOf(Date);
    expect(
      seen!.getTime(),
      'the arm was handed `now`, so it would erase an account the moment it was deleted',
    ).toBeLessThan(NOW.getTime());
  });
});
