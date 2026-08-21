// V-1224 — one contract for the status-subscriber confirm/unsubscribe tokens, against BOTH
// implementations of `StatusSubscribersRepo`.
//
// The fourteenth of the twenty-nine. This is the double-opt-in path for the public status page: an
// address is only mailed after it confirms, and only until it unsubscribes. Both transitions are
// claimed by a token hash, and both claims are compare-and-swap:
//
//   markConfirmed      WHERE id = $1 AND confirm_token_hash = $expected
//                      SET confirmed_at, confirm_token_hash = NULL, unsubscribe_token_hash, …
//   markUnsubscribed   WHERE id = $1 AND (expected IS NULL OR unsubscribe_token_hash = $expected)
//
// THREE PROPERTIES WORTH PINNING, none of which the types express:
//
//   * The confirm token is single-use because the claim NULLS it. A replayed confirmation link
//     therefore finds no matching row and reports null — the same shape as the TOTP counter in
//     V-1220 and the reset-token family in V-1221, reached by clearing the key rather than by
//     comparing a counter or stamping a consumed_at.
//   * Confirming RESURRECTS a previously unsubscribed address: `unsubscribed_at` is set back to
//     NULL. That is the re-subscribe path, and it is easy to read the SET clause as only
//     establishing confirmation. Both implementations do it; nothing asserted it.
//   * `expectedUnsubscribeTokenHash: null` is the deliberate ADMIN branch — the operator
//     force-unsubscribe from V-1200, which takes no token because it carries admin authority
//     instead. Pinning it alongside the token-checked path is what keeps the token check honest:
//     a null slipping in from a customer-facing caller becomes an unauthenticated unsubscribe of
//     anyone whose id is known, and looks like a normal call while doing it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { StatusSubscribersRepo } from '../../src/services/status-subscribers.js';
import { DrizzleStatusSubscribersRepo } from '../../src/db/status-subscribers-repo.js';
import { InMemoryStatusSubscribersRepo } from './_helpers/in-memory-status-subscribers-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const CONFIRM_EXPIRES = new Date(NOW.getTime() + 86_400_000);

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededEmails: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM status_subscribers LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const e of seededEmails) {
      await client`DELETE FROM status_subscribers WHERE email = ${e}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Pending {
  id: string;
  confirmHash: string;
}

interface Subject {
  repo: StatusSubscribersRepo;
  /** A pending (unconfirmed) subscriber with a known confirm-token hash. */
  pending: () => Promise<Pending>;
}

function makePending(repo: StatusSubscribersRepo, track: boolean) {
  return async (): Promise<Pending> => {
    const tag = randomUUID();
    const email = `status-contract-${tag}@test.local`;
    if (track) seededEmails.push(email);
    const confirmHash = `confirm-${tag}`;
    const row = await repo.upsertPending({
      email,
      confirmTokenHash: confirmHash,
      confirmExpiresAt: CONFIRM_EXPIRES,
    });
    return { id: row.id, confirmHash };
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryStatusSubscribersRepo();
  return { repo, pending: makePending(repo, false) };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleStatusSubscribersRepo({ client: c, db, close: async () => {} });
  return { repo, pending: makePending(repo, true) };
}

async function confirm(s: Subject, p: Pending, unsubHash: string) {
  return s.repo.markConfirmed({
    id: p.id,
    expectedConfirmTokenHash: p.confirmHash,
    confirmedAt: NOW,
    unsubscribeTokenHash: unsubHash,
  });
}

function statusSubscriberContract(
  label: string,
  make: () => Subject,
  enabled: () => boolean,
): void {
  describe(`StatusSubscribersRepo confirm contract — ${label}`, () => {
    it('CRITICAL confirming requires the exact confirm token, in both. The hash IS the proof that whoever clicked the link received the mail, so an implementation matching on id alone would let anyone confirm an address they do not control onto the status list.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();

      const wrong = await s.repo.markConfirmed({
        id: p.id,
        expectedConfirmTokenHash: `not-${p.confirmHash}`,
        confirmedAt: NOW,
        unsubscribeTokenHash: 'unsub-x',
      });

      expect(wrong, 'a wrong confirm token confirmed the subscription').toBeNull();
    });

    it('CRITICAL the confirmation link is single-use, in both. The claim NULLS the confirm token, so a replay finds no matching row — the same guarantee as the TOTP counter and the reset-token family, reached by clearing the key rather than stamping a consumed_at.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();

      expect(
        await confirm(s, p, `unsub-${randomUUID()}`),
        'the first confirm failed',
      ).not.toBeNull();
      expect(
        await confirm(s, p, `unsub-${randomUUID()}`),
        'the same confirmation link was accepted twice',
      ).toBeNull();
    });

    it('CRITICAL confirming RESURRECTS a previously unsubscribed address, in both. unsubscribed_at is set back to NULL, which is the whole re-subscribe path — an implementation that only established confirmation would leave the row confirmed AND unsubscribed, and the address would never be mailed again.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();
      const unsub = `unsub-${randomUUID()}`;
      await confirm(s, p, unsub);
      await s.repo.markUnsubscribed({
        id: p.id,
        expectedUnsubscribeTokenHash: unsub,
        unsubscribedAt: NOW,
      });
      expect(
        (await s.repo.listConfirmed()).some((r) => r.id === p.id),
        'the unsubscribe did not take, so this arm would prove nothing',
      ).toBe(false);

      // Re-subscribe: a fresh pending token, then confirm again.
      const again = await s.repo.upsertPending({
        email: (await s.repo.getById(p.id))?.email ?? '',
        confirmTokenHash: `confirm-again-${randomUUID()}`,
        confirmExpiresAt: CONFIRM_EXPIRES,
      });
      const row = await s.repo.markConfirmed({
        id: again.id,
        expectedConfirmTokenHash: again.confirmTokenHash ?? '',
        confirmedAt: NOW,
        unsubscribeTokenHash: `unsub-${randomUUID()}`,
      });

      expect(row?.unsubscribedAt ?? null, 'confirming left the address unsubscribed').toBeNull();
      expect(
        (await s.repo.listConfirmed()).some((r) => r.id === p.id),
        'the re-subscribed address is still absent from the confirmed list',
      ).toBe(true);
    });

    it('CRITICAL unsubscribing requires the exact unsubscribe token, in both. Otherwise a known subscriber id is enough to unsubscribe someone else from incident mail they rely on.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();
      const unsub = `unsub-${randomUUID()}`;
      await confirm(s, p, unsub);

      expect(
        await s.repo.markUnsubscribed({
          id: p.id,
          expectedUnsubscribeTokenHash: `not-${unsub}`,
          unsubscribedAt: NOW,
        }),
        'a wrong unsubscribe token unsubscribed the address',
      ).toBeNull();
    });

    it('CRITICAL a row handed to the caller is a SNAPSHOT — a later write does not reach into it, in both. Postgres cannot mutate a result the caller already holds, and a fixture that can is not merely inaccurate: it makes every before/after comparison against it read "nothing changed", because `before` and `after` are the same object. An arm written that way passes forever and asserts nothing.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();
      await confirm(s, p, 'hash-snapshot');

      const before = await s.repo.getById(p.id);
      expect(before?.unsubscribedAt ?? null, 'precondition: not yet unsubscribed').toBeNull();

      await s.repo.markUnsubscribed({
        id: p.id,
        expectedUnsubscribeTokenHash: 'hash-snapshot',
        unsubscribedAt: new Date('2026-08-21T00:00:00.000Z'),
      });

      expect(
        before?.unsubscribedAt ?? null,
        'the row handed to the caller mutated underneath it — reads are aliasing the store',
      ).toBeNull();
      expect(
        (await s.repo.getById(p.id))?.unsubscribedAt ?? null,
        'and the write itself did not land, so the arm above proves nothing',
      ).not.toBeNull();
    });

    it("CRITICAL rotating the unsubscribe token replaces the stored hash, in both. The fan-out issues a fresh token per outgoing email and embeds it in that email's unsubscribe link, so a rotate that does not land leaves the recipient holding a link that will not work.", async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();
      await confirm(s, p, 'hash-original');

      await s.repo.rotateUnsubscribeTokenHash({ id: p.id, hash: 'hash-rotated' });

      expect(
        (await s.repo.getById(p.id))?.unsubscribeTokenHash,
        'the rotate did not replace the stored hash',
      ).toBe('hash-rotated');
    });

    it('CRITICAL rotating a subscriber that does not exist is a SILENT NO-OP, in both. The Drizzle repo issues a plain UPDATE and matches no rows; nothing is thrown. The double used to throw instead, which is a parity defect in the stricter direction — a caller production waves through would have failed here and nowhere else, for a reason production cannot produce. See the note in the log: silently succeeding also means the caller still gets a plaintext token back, and that is a separate question from whether the two implementations agree.', async () => {
      if (!enabled()) return;
      const s = make();

      await expect(
        s.repo.rotateUnsubscribeTokenHash({ id: randomUUID(), hash: 'hash-orphan' }),
        'rotating an unknown subscriber did not resolve quietly',
      ).resolves.toBeUndefined();
    });

    it('CRITICAL a NULL expected unsubscribe token is the deliberate admin branch and still works, in both. It is the operator force-unsubscribe, which carries admin authority instead of a token — pinning it beside the token-checked arm is what keeps that check honest, because a null arriving from a customer-facing caller is an unauthenticated unsubscribe that looks like a normal call.', async () => {
      if (!enabled()) return;
      const s = make();
      const p = await s.pending();
      await confirm(s, p, `unsub-${randomUUID()}`);

      const row = await s.repo.markUnsubscribed({
        id: p.id,
        expectedUnsubscribeTokenHash: null,
        unsubscribedAt: NOW,
      });

      expect(row, 'the admin force-unsubscribe branch stopped working').not.toBeNull();
      expect(
        (await s.repo.listConfirmed()).some((r) => r.id === p.id),
        'the force-unsubscribed address is still on the confirmed list',
      ).toBe(false);
    });
  });
}

statusSubscriberContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'StatusSubscribersRepo confirm contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    statusSubscriberContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
