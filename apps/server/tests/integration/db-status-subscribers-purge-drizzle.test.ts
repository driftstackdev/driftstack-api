// Which subscriber emails the retention purge is allowed to destroy.
//
// v8 coverage: `status-subscribers-repo.ts` sits at 50% of lines, and four of
// its methods execute zero statements — including both halves of the purge.
// That matters more here than the percentage suggests: the purge is fired by a
// timer with no admin actor, so its `status_subscriber.purged` audit action is
// unemittable by construction (see
// `every-declared-admin-audit-action-is-reachable`). **A log line is the only
// evidence this ever ran.** Nothing else in the system would record it
// destroying the wrong rows.
//
// `listPurgeCandidates(cutoff)` selects `unsubscribedAt < cutoff AND email IS
// NOT NULL`, and each half is load-bearing:
//
//   unsubscribedAt < cutoff   the entire safety property. A row that never
//                             unsubscribed has a NULL there and is excluded by
//                             SQL's own semantics — implicitly, which is why it
//                             gets an explicit arm. Drop the comparison and
//                             every confirmed, actively-subscribed address
//                             becomes a purge candidate.
//   email IS NOT NULL         keeps an already-purged row out of the next
//                             batch, so the count reported is work actually
//                             done rather than rows re-nulled forever.
//
// `purgeEmails` then nulls the email AND all three token columns, because each
// is derived from the address; leaving a token behind keeps a live unsubscribe
// link pointing at a row whose email is supposedly gone. Its empty-input early
// return is asserted too — `inArray(col, [])` is the kind of thing that either
// matches nothing or errors depending on the driver, and neither should be
// discovered by a scheduled job at 3am.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStatusSubscribersRepo } from '../../src/db/status-subscribers-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY = 24 * 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleStatusSubscribersRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT unsubscribed_at FROM status_subscribers LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleStatusSubscribersRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM status_subscribers WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedSubscriber(args: {
  email: string | null;
  unsubscribedAgoMs?: number | null;
}): Promise<string> {
  const id = randomUUID();
  const unsubscribedAt =
    args.unsubscribedAgoMs === null || args.unsubscribedAgoMs === undefined
      ? null
      : new Date(Date.now() - args.unsubscribedAgoMs).toISOString();
  await sql!`
    INSERT INTO status_subscribers
      (id, email, confirm_token_hash, unsubscribe_token_hash, confirmed_at, unsubscribed_at)
    VALUES (${id}, ${args.email}, ${`confirm-${id}`}, ${`unsub-${id}`}, now(),
            ${unsubscribedAt}::timestamptz)`;
  seeded.push(id);
  return id;
}

const candidateIds = async (cutoff: Date): Promise<string[]> =>
  (await repo!.listPurgeCandidates(cutoff)).map((r) => r.id);

describe('status-subscriber retention purge', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an active subscriber is never a purge candidate', async () => {
    if (!dbReachable || !repo) return;
    const active = await seedSubscriber({ email: 'active@test.local', unsubscribedAgoMs: null });
    expect(
      await candidateIds(new Date(Date.now() - 30 * DAY)),
      'a subscriber who never unsubscribed was listed for purging — this job destroys the email ' +
        'addresses of people still receiving status updates',
    ).not.toContain(active);
  });

  it('CRITICAL a recent unsubscribe is not yet a purge candidate', async () => {
    if (!dbReachable || !repo) return;
    const recent = await seedSubscriber({ email: 'recent@test.local', unsubscribedAgoMs: DAY });
    expect(
      await candidateIds(new Date(Date.now() - 30 * DAY)),
      'someone who unsubscribed inside the retention window was purged early',
    ).not.toContain(recent);
  });

  it('CRITICAL an old unsubscribe with an email still set IS a candidate', async () => {
    if (!dbReachable || !repo) return;
    const old = await seedSubscriber({ email: 'old@test.local', unsubscribedAgoMs: 90 * DAY });
    expect(
      await candidateIds(new Date(Date.now() - 30 * DAY)),
      'the purge found nothing to do for a long-unsubscribed address — retention would never run',
    ).toContain(old);
  });

  it('CRITICAL an already-purged row is not offered again', async () => {
    if (!dbReachable || !repo) return;
    const done = await seedSubscriber({ email: null, unsubscribedAgoMs: 90 * DAY });
    expect(
      await candidateIds(new Date(Date.now() - 30 * DAY)),
      'a row whose email is already gone was listed again — every batch would re-null the same rows ' +
        'and report work it did not do',
    ).not.toContain(done);
  });

  it('CRITICAL purging clears the email and every token derived from it', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedSubscriber({ email: 'purge-me@test.local', unsubscribedAgoMs: 90 * DAY });
    expect(await repo.purgeEmails([id])).toBe(1);
    const [row] = await sql!<
      {
        email: string | null;
        confirm_token_hash: string | null;
        unsubscribe_token_hash: string | null;
      }[]
    >`SELECT email, confirm_token_hash, unsubscribe_token_hash FROM status_subscribers WHERE id = ${id}`;
    expect(row?.email, 'the purge left the email in place').toBeNull();
    expect(
      row?.unsubscribe_token_hash,
      'the purge left a live unsubscribe token on a row whose email is supposedly gone',
    ).toBeNull();
    expect(row?.confirm_token_hash).toBeNull();
  });

  it('CRITICAL purging nothing touches nothing and reports zero', async () => {
    if (!dbReachable || !repo) return;
    const untouched = await seedSubscriber({
      email: 'keep@test.local',
      unsubscribedAgoMs: 90 * DAY,
    });
    expect(await repo.purgeEmails([])).toBe(0);
    const [row] = await sql!<{ email: string | null }[]>`
      SELECT email FROM status_subscribers WHERE id = ${untouched}`;
    expect(row?.email, 'an empty purge batch still nulled a row').toBe('keep@test.local');
  });

  it('CRITICAL an unsubscribe token resolves to its own row, and an unknown one to nothing', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedSubscriber({ email: 'token@test.local', unsubscribedAgoMs: null });
    expect((await repo.findByUnsubscribeTokenHash(`unsub-${id}`))?.id).toBe(id);
    expect(
      await repo.findByUnsubscribeTokenHash(`unsub-${randomUUID()}`),
      'an unknown unsubscribe token resolved to a subscriber',
    ).toBeNull();
  });
});
