// A Test's QUIC / UDP reading lands ONLY on a row that still carries the identity
// it was measured through — and the DATABASE decides that, in the write itself.
//
// `POST /v1/account/me/proxies/:id/test` reads the row, spends seconds on the
// wire, and then stores what it measured (migration 0124). A customer PUT in that
// window can repoint the row at a different machine, and the same statement that
// moves it nulls these columns. The first version of the write fenced that with
// `findById` and then a generic `update` matched on id + account alone — a check,
// then a write, with a gap between them. A PUT landing in the gap let the OLD
// endpoint's reading land on the NEW one, dated after the move. The worst such
// value is a `false`: a stored negative is what tells every consumer not to look
// again, here about a machine nobody has measured.
//
// `storeProbeReadingsIfSameIdentity` closes the gap by putting the identity in
// the UPDATE's WHERE. Every part of that is a clause that type-checks whether or
// not it is there, and the in-memory double cannot say what Postgres does with
// it — so, against a real one:
//
//   * each of the SIX identity columns declines the write when it has moved (the
//     same six `readingWasTakenThroughCurrentIdentity` compares). The sixth is
//     `wrapped_secret`: a VPN row's host and port are a display address, so a
//     WireGuard key rotation that keeps both is a move only that column shows;
//   * the three NULLABLE ones are matched null-safely — a plain `=` against NULL
//     is never true and would silently decline every write onto a proxy with no
//     credential, which is most of them;
//   * a PUT that is IN FLIGHT when the write runs — uncommitted, holding the row
//     lock — still wins: the write waits, re-reads the row the PUT committed, and
//     matches nothing. This is the arm a check-then-write cannot pass;
//   * a leg moves only with its date, an unmeasured leg is left as stored, and a
//     reading measured EARLIER than the stored one does not overwrite it, so two
//     Tests finishing out of order end on the newer measurement — and a write
//     whose every leg stood down leaves `updated_at` where it was.
//
// Runs on its OWN database, migrated by the helper (so 0124 is applied by
// construction): this file DELETEs whole tables.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DrizzleAccountProxiesRepo,
  InMemoryAccountProxiesRepo,
  type AccountProxiesRepo,
  type AccountProxyRow,
} from '../../src/db/account-proxies-repo.js';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

const ISOLATED_DB_NAME = 'driftstack_iso_proxy_probe_identity';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

const EARLIER = new Date('2026-09-17T08:00:00.000Z');
const MEASURED_AT = new Date('2026-09-17T09:00:00.000Z');
const LATER = new Date('2026-09-17T10:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let other: ReturnType<typeof postgres> | null = null;
let accountId = '';

function repoFor(sqlClient: ReturnType<typeof postgres>): DrizzleAccountProxiesRepo {
  return new DrizzleAccountProxiesRepo({
    client: sqlClient,
    db: drizzle(sqlClient) as unknown as ReturnType<typeof drizzle<typeof schema>>,
    close: async () => {},
  });
}

interface ProxyOverrides {
  scheme?: string;
  username?: string | null;
  wrappedPassword?: string | null;
  wrappedSecret?: string | null;
}

/** A saved SOCKS5 proxy WITH a credential, through the repo's own `create`. */
async function createProxy(
  repo: AccountProxiesRepo,
  over: ProxyOverrides = {},
): Promise<AccountProxyRow> {
  return repo.create(accountId, {
    id: randomUUID(),
    label: 'p',
    scheme: over.scheme ?? 'socks5',
    host: 'gw.example.com',
    port: 1080,
    username: over.username === undefined ? 'user-country-us' : over.username,
    wrappedPassword: over.wrappedPassword === undefined ? 'envelope-one' : over.wrappedPassword,
    wrappedSecret: over.wrappedSecret ?? null,
  });
}

/** A WireGuard row as the route stores one: the tunnel material in
 *  `wrapped_secret`, no username, no password. */
const WIREGUARD: ProxyOverrides = {
  scheme: 'wireguard',
  username: null,
  wrappedPassword: null,
  wrappedSecret: 'secret-one',
};

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null || !RUN_DB_TESTS) return;
  const candidate = postgres(isolated, { max: 3 });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // This file DELETEs whole tables; prove the connection before that runs.
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
  // A SECOND connection: an in-flight PUT is only observable between two
  // sessions — one holding the row lock while the other writes.
  other = postgres(isolated, { max: 3 });
});

beforeEach(async () => {
  if (!client) return;
  await client`DELETE FROM agent_sessions`;
  await client`DELETE FROM account_proxies`;
  await client`DELETE FROM accounts`;
  accountId = randomUUID();
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}::uuid, ${`probe-identity-${accountId}@example.test`})`;
});

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await other?.end({ timeout: 5 }).catch(() => {});
});

/** The identity edits a PUT can make, one column each. The readings are nulled in
 *  the same update, exactly as `proxyReadingsInvalidatedByEdit` has the route do. */
const IDENTITY_EDITS: Array<{
  name: string;
  /** The row the test dialled, when it is not the default SOCKS5 one. */
  probed?: ProxyOverrides;
  updates: Record<string, unknown>;
}> = [
  { name: 'scheme', updates: { scheme: 'http' } },
  { name: 'host', updates: { host: 'gw-moved.example.com' } },
  { name: 'port', updates: { port: 1081 } },
  { name: 'username', updates: { username: 'user-country-de' } },
  { name: 'username cleared', updates: { username: null } },
  { name: 'wrappedPassword', updates: { wrappedPassword: 'envelope-two' } },
  { name: 'wrappedPassword cleared', updates: { wrappedPassword: null } },
  // A key rotation: host, port and scheme all stand, and the tunnel now lands on
  // a different machine.
  { name: 'wrappedSecret', probed: WIREGUARD, updates: { wrappedSecret: 'secret-two' } },
  { name: 'wrappedSecret cleared', probed: WIREGUARD, updates: { wrappedSecret: null } },
];

describe.skipIf(!RUN_DB_TESTS)(
  'storing a Test reading through the identity it was measured on, on real Postgres',
  () => {
    it('CRITICAL the database is reachable and migrated, so nothing below can pass vacuously. Every arm returns early when the connection is null, which is right when there is no Postgres — but a green that means "the database was missing" is indistinguishable from one that means "the database agreed".', () => {
      expect(
        client,
        'postgres unreachable or unmigrated — the arms below never ran',
      ).not.toBeNull();
    });

    it('VACUITY CONTROL an unmoved row RECEIVES the reading — a measured false as FALSE, a measured true as true, each with the date it was MEASURED (not the date of the write) — and the statement hands back the row as it now stands. Three times: on a proxy with a credential, on one with NEITHER (username and wrapped_password NULL, as is wrapped_secret on both), and on a WireGuard row, the only kind whose wrapped_secret is NOT null. MUTATION: spell any of the three nullable predicates with `=` instead of `IS NOT DISTINCT FROM` and a write onto a row where that column is NULL is declined.', async () => {
      if (!client) return;
      const repo = repoFor(client);
      for (const credentials of [{}, { username: null, wrappedPassword: null }, WIREGUARD]) {
        const probed = await createProxy(repo, credentials);
        const written = await repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          readings: {
            quicProbe: false,
            quicProbeAt: MEASURED_AT,
            udpProbe: true,
            udpProbeAt: MEASURED_AT,
          },
        });
        expect(written, JSON.stringify(credentials)).not.toBeNull();
        expect(written?.id).toBe(probed.id);
        expect(written?.quicProbe, 'a measured negative is FALSE, not null').toBe(false);
        expect(written?.quicProbeAt).toEqual(MEASURED_AT);
        expect(written?.udpProbe).toBe(true);
        expect(written?.udpProbeAt).toEqual(MEASURED_AT);
        // The returned row is the stored row, not an echo of the arguments.
        const found = await repo.findById({ id: probed.id, accountId });
        expect(found?.quicProbe).toBe(false);
        expect(found?.quicProbeAt).toEqual(MEASURED_AT);
        expect(found?.udpProbe).toBe(true);
        expect(found?.udpProbeAt).toEqual(MEASURED_AT);
        expect(found?.host).toBe('gw.example.com');
      }
    });

    it('CRITICAL a row that MOVED between the measurement and the write receives nothing — for EACH of the six identity columns, including each nullable one going to NULL. The stale reading is a `false` on both legs, the worst value to let through. MUTATION: delete any one `AND p.<column> …` line from the statement and that column’s arm reds.', async () => {
      if (!client) return;
      const repo = repoFor(client);
      for (const edit of IDENTITY_EDITS) {
        const probed = await createProxy(repo, edit.probed);
        // The PUT: moves the row. (Nothing is stored yet, so there is nothing for
        // it to clear — what matters is that the row is no longer what was dialled.)
        const moved = await repo.update({ id: probed.id, accountId, updates: edit.updates });
        expect(moved, edit.name).not.toBeNull();

        const written = await repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          readings: {
            quicProbe: false,
            quicProbeAt: MEASURED_AT,
            udpProbe: false,
            udpProbeAt: MEASURED_AT,
          },
        });
        expect(written, `${edit.name}: the write must be declined`).toBeNull();
        const after = await repo.findById({ id: probed.id, accountId });
        expect(after?.quicProbe, edit.name).toBeNull();
        expect(after?.quicProbeAt, edit.name).toBeNull();
        expect(after?.udpProbe, edit.name).toBeNull();
        expect(after?.udpProbeAt, edit.name).toBeNull();
      }
    });

    it('CRITICAL THE RACE ITSELF. The PUT is IN FLIGHT when the write runs: another session has repointed the row and not yet committed. A reader at this instant still sees the OLD address — so a check-then-write passes its check here, then waits on the row lock, then writes onto the new address. The single statement waits on the same lock, re-reads the row the PUT committed, and matches nothing. MUTATION: restore `findById` + `update` and this arm stores `false` on gw-moved.', async () => {
      if (!client || !other) return;
      const repo = repoFor(client);
      const probed = await createProxy(repo);

      // A holder, not a `let`: TypeScript cannot see an assignment made inside the
      // transaction callback and would narrow a bare variable to its initial null.
      const pending: { write?: Promise<AccountProxyRow | null> } = {};
      await other.begin(async (tx) => {
        await tx`
          UPDATE account_proxies
             SET host = 'gw-moved.example.com',
                 quic_probe = NULL, quic_probe_at = NULL,
                 udp_probe = NULL, udp_probe_at = NULL
           WHERE id = ${probed.id}::uuid`;
        // The uncommitted move is invisible to everyone else: a fence that READS
        // first sees the address the test dialled and lets the write through.
        expect((await repo.findById({ id: probed.id, accountId }))?.host).toBe('gw.example.com');

        pending.write = repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          readings: {
            quicProbe: false,
            quicProbeAt: MEASURED_AT,
            udpProbe: false,
            udpProbeAt: MEASURED_AT,
          },
        });
        // Do not commit until the write is really WAITING on this transaction's
        // row lock — otherwise the arm would only prove the sequential case
        // again. Asked of the database, not slept for.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i += 1) {
          const rows = await client!`
            SELECT count(*)::int AS n
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND query LIKE '%quic_probe = CASE%'`;
          waiting = Number(rows[0]?.n ?? 0);
          if (waiting === 0) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting, 'the write never blocked on the in-flight edit').toBeGreaterThan(0);
      });

      expect(pending.write).toBeDefined();
      expect(await pending.write, 'the write must lose to the edit it waited for').toBeNull();
      const after = await repo.findById({ id: probed.id, accountId });
      expect(after?.host).toBe('gw-moved.example.com');
      expect(after?.quicProbe, 'a stale false must not land on the new address').toBeNull();
      expect(after?.quicProbeAt).toBeNull();
      expect(after?.udpProbe).toBeNull();
      expect(after?.udpProbeAt).toBeNull();
    });

    it('the write is OWNER-SCOPED and a missing row is a decline, not a throw: another account’s id, and a deleted proxy, both match nothing', async () => {
      if (!client) return;
      const repo = repoFor(client);
      const probed = await createProxy(repo);
      const readings = { quicProbe: true, quicProbeAt: MEASURED_AT };
      expect(
        await repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId: randomUUID(),
          probedIdentity: probed,
          readings,
        }),
      ).toBeNull();
      expect((await repo.findById({ id: probed.id, accountId }))?.quicProbe).toBeNull();

      expect(await repo.delete({ id: probed.id, accountId })).toBe(true);
      expect(
        await repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          readings,
        }),
      ).toBeNull();
    });

    it('CRITICAL the legs are independent and the row ends on the newer MEASUREMENT, whichever write came last: an unmeasured leg is left exactly as stored; a reading measured EARLIER than the stored one does not overwrite it (two Tests of one proxy finishing out of order); a LATER one does. Per leg — the older QUIC reading stands down while the UDP leg beside it, which the row holds nothing newer for, still lands. MUTATION: drop the `p.quic_probe_at <= …` disjunct and the older false replaces the newer true.', async () => {
      if (!client) return;
      const repo = repoFor(client);
      const probed = await createProxy(repo);
      const store = (
        readings: Parameters<typeof repo.storeProbeReadingsIfSameIdentity>[0]['readings'],
      ) =>
        repo.storeProbeReadingsIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          readings,
        });

      // One leg only: the other stays never-measured.
      const quicOnly = await store({ quicProbe: true, quicProbeAt: MEASURED_AT });
      expect(quicOnly?.quicProbe).toBe(true);
      expect(quicOnly?.udpProbe, 'an unmeasured leg must not become a stored false').toBeNull();
      expect(quicOnly?.udpProbeAt).toBeNull();

      // A Test that was measured EARLIER finishes later. Its QUIC reading is the
      // older one and stands down; its UDP reading is the only one and lands.
      const outOfOrder = await store({
        quicProbe: false,
        quicProbeAt: EARLIER,
        udpProbe: false,
        udpProbeAt: EARLIER,
      });
      expect(outOfOrder, 'standing down is not a decline: the row is returned').not.toBeNull();
      expect(outOfOrder?.quicProbe, 'the newer measurement stands').toBe(true);
      expect(outOfOrder?.quicProbeAt).toEqual(MEASURED_AT);
      expect(outOfOrder?.udpProbe).toBe(false);
      expect(outOfOrder?.udpProbeAt).toEqual(EARLIER);

      // A write whose EVERY leg stands down changed nothing, so the row's change
      // stamp must not move — on Postgres and on the double alike. The stamp is
      // pushed into the past first, so "did not move" cannot be a clock tie.
      await client`UPDATE account_proxies SET updated_at = ${EARLIER.toISOString()}::timestamptz WHERE id = ${probed.id}::uuid`;
      const stoodDown = await store({ quicProbe: false, quicProbeAt: EARLIER });
      expect(stoodDown?.quicProbe).toBe(true);
      expect(stoodDown?.updatedAt, 'nothing landed: updated_at stays').toEqual(EARLIER);

      // VACUITY CONTROL — a LATER measurement does overwrite, value and date, and
      // THAT moves the change stamp.
      const newer = await store({ quicProbe: false, quicProbeAt: LATER });
      expect(newer?.updatedAt.getTime()).toBeGreaterThan(EARLIER.getTime());

      // The double keeps the same rule. A real pause separates the two writes, so
      // an equal stamp means "not moved" rather than "moved within one tick".
      const double = new InMemoryAccountProxiesRepo();
      const onDouble = await createProxy(double);
      const storeOnDouble = (quicProbeAt: Date): Promise<AccountProxyRow | null> =>
        double.storeProbeReadingsIfSameIdentity({
          id: onDouble.id,
          accountId,
          probedIdentity: onDouble,
          readings: { quicProbe: true, quicProbeAt },
        });
      const landed = await storeOnDouble(MEASURED_AT);
      await new Promise((r) => setTimeout(r, 15));
      const yielded = await storeOnDouble(EARLIER);
      expect(yielded?.updatedAt).toEqual(landed?.updatedAt);
      await new Promise((r) => setTimeout(r, 15));
      const relanded = await storeOnDouble(LATER);
      expect(relanded?.updatedAt.getTime()).toBeGreaterThan(landed?.updatedAt.getTime() ?? 0);
      expect(newer?.quicProbe).toBe(false);
      expect(newer?.quicProbeAt).toEqual(LATER);
      expect(newer?.udpProbe).toBe(false);
      expect(newer?.udpProbeAt).toEqual(EARLIER);
    });

    it('half a leg is refused LOUDLY on both repos — a value with no date cannot be aged, and quietly skipping it would store less than the caller believes it stored', async () => {
      if (!client) return;
      for (const repo of [repoFor(client), new InMemoryAccountProxiesRepo()]) {
        const probed = await createProxy(repo);
        const call = (): Promise<unknown> =>
          repo.storeProbeReadingsIfSameIdentity({
            id: probed.id,
            accountId,
            probedIdentity: probed,
            readings: { quicProbe: false },
          });
        // The double throws synchronously and the Drizzle repo rejects; either
        // way nothing is written.
        await expect((async () => call())()).rejects.toThrow(/boolean with its date/);
        expect((await repo.findById({ id: probed.id, accountId }))?.quicProbe).toBeNull();
      }
    });

    it('THE DOUBLE AGREES WITH POSTGRES on every rule above — the route’s own tests run on it, so a double that accepted a moved row would make them prove nothing', async () => {
      if (!client) return;
      const run = async (repo: AccountProxiesRepo): Promise<unknown[]> => {
        const out: unknown[] = [];
        const view = (r: AccountProxyRow | null): unknown =>
          r === null
            ? null
            : {
                quicProbe: r.quicProbe,
                quicProbeAt: r.quicProbeAt?.toISOString() ?? null,
                udpProbe: r.udpProbe,
                udpProbeAt: r.udpProbeAt?.toISOString() ?? null,
              };
        for (const edit of [
          { name: 'unmoved', updates: {} },
          { name: 'unmoved wireguard', probed: WIREGUARD, updates: {} },
          ...IDENTITY_EDITS,
        ]) {
          const probed = await createProxy(repo, edit.probed);
          if (Object.keys(edit.updates).length > 0) {
            await repo.update({ id: probed.id, accountId, updates: edit.updates });
          }
          out.push([
            edit.name,
            view(
              await repo.storeProbeReadingsIfSameIdentity({
                id: probed.id,
                accountId,
                probedIdentity: probed,
                readings: { quicProbe: false, quicProbeAt: MEASURED_AT },
              }),
            ),
          ]);
        }
        const probed = await createProxy(repo, { username: null, wrappedPassword: null });
        for (const readings of [
          { udpProbe: true, udpProbeAt: MEASURED_AT },
          { quicProbe: true, quicProbeAt: EARLIER, udpProbe: false, udpProbeAt: EARLIER },
          { udpProbe: false, udpProbeAt: LATER },
        ]) {
          out.push(
            view(
              await repo.storeProbeReadingsIfSameIdentity({
                id: probed.id,
                accountId,
                probedIdentity: probed,
                readings,
              }),
            ),
          );
        }
        return out;
      };
      const onPostgres = await run(repoFor(client));
      const inMemory = await run(new InMemoryAccountProxiesRepo());
      expect(inMemory).toEqual(onPostgres);
      // Not vacuous: the sequence contains a write, declines and a stand-down.
      expect(onPostgres[0]).toEqual([
        'unmoved',
        {
          quicProbe: false,
          quicProbeAt: MEASURED_AT.toISOString(),
          udpProbe: null,
          udpProbeAt: null,
        },
      ]);
      expect(onPostgres[1]).toEqual([
        'unmoved wireguard',
        {
          quicProbe: false,
          quicProbeAt: MEASURED_AT.toISOString(),
          udpProbe: null,
          udpProbeAt: null,
        },
      ]);
      expect(onPostgres.slice(2, 2 + IDENTITY_EDITS.length)).toEqual(
        IDENTITY_EDITS.map((e) => [e.name, null]),
      );
    });
  },
);

// Proxy-accuracy audit G2 (d), second pass — the FULL-CHECK VERDICT (migration
// 0146) goes through the same fence. It is the one list field a desktop reads as
// "Driftstack could not use this proxy", and it retires the readings dated before
// it on every Mac, so the old endpoint's `false` landing on a row the customer
// just corrected would condemn the fix everywhere. Later wins, like a reading.
describe.skipIf(!RUN_DB_TESTS)(
  'storing a full-check verdict through the identity it was measured on, on real Postgres',
  () => {
    const verdictView = (r: AccountProxyRow | null): unknown =>
      r === null
        ? null
        : { fullCheckOk: r.fullCheckOk, fullCheckAt: r.fullCheckAt?.toISOString() ?? null };

    it('VACUITY CONTROL an unmoved row RECEIVES the verdict — a failure as FALSE, with the date it was MEASURED — on a proxy with a credential, one with none, and a WireGuard row; `updated_at` does not move (a verdict is not an edit)', async () => {
      if (!client) return;
      const repo = repoFor(client);
      for (const credentials of [{}, { username: null, wrappedPassword: null }, WIREGUARD]) {
        const probed = await createProxy(repo, credentials);
        await client`UPDATE account_proxies SET updated_at = ${EARLIER.toISOString()}::timestamptz WHERE id = ${probed.id}::uuid`;
        const written = await repo.storeFullCheckVerdictIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          ok: false,
          at: MEASURED_AT,
        });
        expect(written, JSON.stringify(credentials)).not.toBeNull();
        expect(written?.fullCheckOk, 'a failure is FALSE, not null').toBe(false);
        expect(written?.fullCheckAt).toEqual(MEASURED_AT);
        expect(written?.updatedAt).toEqual(EARLIER);
        const found = await repo.findById({ id: probed.id, accountId });
        expect(verdictView(found)).toEqual({
          fullCheckOk: false,
          fullCheckAt: MEASURED_AT.toISOString(),
        });
      }
    });

    it('CRITICAL a row that MOVED between the check and the write receives nothing — for EACH of the six identity columns. MUTATION: delete any `AND p.<column> …` line from the statement and that column’s arm reds', async () => {
      if (!client) return;
      const repo = repoFor(client);
      for (const edit of IDENTITY_EDITS) {
        const probed = await createProxy(repo, edit.probed);
        expect(
          await repo.update({ id: probed.id, accountId, updates: edit.updates }),
          edit.name,
        ).not.toBeNull();
        const written = await repo.storeFullCheckVerdictIfSameIdentity({
          id: probed.id,
          accountId,
          probedIdentity: probed,
          ok: false,
          at: MEASURED_AT,
        });
        expect(written, `${edit.name}: the verdict must be declined`).toBeNull();
        expect(verdictView(await repo.findById({ id: probed.id, accountId })), edit.name).toEqual({
          fullCheckOk: null,
          fullCheckAt: null,
        });
      }
    });

    it('CRITICAL later wins: a verdict measured EARLIER than the stored one is declined (two checks finishing out of order end on the newer one); a LATER one replaces it; another account’s id matches nothing. MUTATION: drop the `p.full_check_at <= …` disjunct and the older false replaces the newer true', async () => {
      if (!client) return;
      const repo = repoFor(client);
      const probed = await createProxy(repo);
      const store = (ok: boolean, at: Date, owner = accountId) =>
        repo.storeFullCheckVerdictIfSameIdentity({
          id: probed.id,
          accountId: owner,
          probedIdentity: probed,
          ok,
          at,
        });
      expect(verdictView(await store(true, MEASURED_AT))).toEqual({
        fullCheckOk: true,
        fullCheckAt: MEASURED_AT.toISOString(),
      });
      expect(await store(false, EARLIER), 'an older failure must not replace a newer pass').toBe(
        null,
      );
      expect(verdictView(await repo.findById({ id: probed.id, accountId }))).toEqual({
        fullCheckOk: true,
        fullCheckAt: MEASURED_AT.toISOString(),
      });
      expect(await store(false, LATER, randomUUID())).toBeNull();
      expect(verdictView(await store(false, LATER))).toEqual({
        fullCheckOk: false,
        fullCheckAt: LATER.toISOString(),
      });
    });

    it('THE DOUBLE AGREES WITH POSTGRES on every rule above', async () => {
      if (!client) return;
      const run = async (repo: AccountProxiesRepo): Promise<unknown[]> => {
        const out: unknown[] = [];
        for (const edit of [
          { name: 'unmoved', updates: {} },
          { name: 'unmoved wireguard', probed: WIREGUARD, updates: {} },
          ...IDENTITY_EDITS,
        ]) {
          const probed = await createProxy(repo, edit.probed);
          if (Object.keys(edit.updates).length > 0) {
            await repo.update({ id: probed.id, accountId, updates: edit.updates });
          }
          out.push([
            edit.name,
            verdictView(
              await repo.storeFullCheckVerdictIfSameIdentity({
                id: probed.id,
                accountId,
                probedIdentity: probed,
                ok: false,
                at: MEASURED_AT,
              }),
            ),
          ]);
        }
        const probed = await createProxy(repo);
        for (const [ok, at] of [
          [true, MEASURED_AT],
          [false, EARLIER],
          [false, LATER],
        ] as const) {
          out.push(
            verdictView(
              await repo.storeFullCheckVerdictIfSameIdentity({
                id: probed.id,
                accountId,
                probedIdentity: probed,
                ok,
                at,
              }),
            ),
          );
        }
        return out;
      };
      const onPostgres = await run(repoFor(client));
      const inMemory = await run(new InMemoryAccountProxiesRepo());
      expect(inMemory).toEqual(onPostgres);
      expect(onPostgres[0]).toEqual([
        'unmoved',
        { fullCheckOk: false, fullCheckAt: MEASURED_AT.toISOString() },
      ]);
      expect(onPostgres.slice(2, 2 + IDENTITY_EDITS.length)).toEqual(
        IDENTITY_EDITS.map((e) => [e.name, null]),
      );
      expect(onPostgres.slice(-3)).toEqual([
        { fullCheckOk: true, fullCheckAt: MEASURED_AT.toISOString() },
        null,
        { fullCheckOk: false, fullCheckAt: LATER.toISOString() },
      ]);
    });
  },
);
