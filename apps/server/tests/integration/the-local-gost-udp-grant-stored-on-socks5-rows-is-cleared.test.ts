// Proxy-accuracy audit S1 — the SOCKS5 UDP readings already stored are cleared.
//
// Until S1 the route stored a SOCKS5 row's `udp_probe` from the fleet node's bare
// `udp_associate`, which is the grant of the node's OWN local gost listener: it
// says yes before the upstream is ever contacted, so proxies that refuse UDP
// (0x07, 0x02) and proxies that drop every datagram were stored as "UDP works",
// and a probe tool that never ran was stored as "no UDP". `udp_echo_ok` was
// parsed nowhere and no node sends `udp_detail` on the SOCKS5 path, so EVERY
// SOCKS5 `udp_probe` on record came from that source. The route no longer writes
// it (see `capabilityReadingsForReply`), but the values already stored are served
// on the list and adopted by every desktop until something removes them.
//
// A MIGRATION, not a one-off script: it has to run on every database exactly
// once, before the new code serves, with no operator step to forget — and the
// code alone cannot tell an old-source reading from a new one, because both are
// a boolean and a date. It is data only (no column, constraint or index), and it
// touches no other scheme and no other column: a VPN row's readings never came
// from this source, and the QUIC timeout on a SOCKS5 row is a real reading (the
// only negative a proxy that refuses UDP produces on this path).
//
// Two halves: the file's shape, pinned statically; and the file itself run
// against real Postgres inside a transaction that is rolled back, over a TEMP
// table that shadows `account_proxies` for that transaction only, so the shared
// test database is never written.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0145_socks5_udp_probe_from_the_local_gost_grant_is_cleared';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';

/** The migration with `--` comments removed: the prose mentions what it does not do. */
function statements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return sql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

describe('migration 0145 clears the SOCKS5 UDP readings the local gost grant wrote, and nothing else', () => {
  it('CRITICAL it is exactly two statements: the lock timeout FIRST, then one UPDATE scoped to socks5 rows that hold a UDP reading', () => {
    expect(statements()).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'UPDATE "account_proxies" SET "udp_probe" = NULL, "udp_probe_at" = NULL WHERE "scheme" = \'socks5\' AND ("udp_probe" IS NOT NULL OR "udp_probe_at" IS NOT NULL)',
    ]);
  });

  it('the journal applies it after 0144, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(145);
    expect(journal.entries[at]?.idx).toBe(145);
    expect(journal.entries[at - 1]?.tag).toBe('0144_crypto_order_payment_mint_claim');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });
});

let client: ReturnType<typeof postgres> | null = null;
afterAll(async () => {
  if (client !== null) await client.end({ timeout: 1 });
});

/** Rolls the whole transaction back after `body` ran — nothing it wrote survives. */
class Rollback extends Error {}

describe.skipIf(!RUN_DB_TESTS)('migration 0145 run against real Postgres', () => {
  it('CRITICAL clears udp_probe and udp_probe_at on SOCKS5 rows only — a VPN row’s reading, an HTTP row, the QUIC columns and a never-measured row are untouched', async () => {
    client = postgres(DB_URL, { max: 1, connect_timeout: 5, idle_timeout: 1 });
    const at = '2026-09-20T08:00:00.000Z';
    let rows: Array<{
      id: string;
      scheme: string;
      udp_probe: boolean | null;
      udp_probe_at: Date | null;
      quic_probe: boolean | null;
      quic_probe_at: Date | null;
    }> = [];
    await client
      .begin(async (tx) => {
        // A TEMP table shadows `account_proxies` for this transaction (pg_temp is
        // searched first), with the real table's columns and defaults — so the
        // migration's own unqualified statement runs against it, and nothing
        // outside this transaction can see a row.
        await tx.unsafe(
          'CREATE TEMP TABLE account_proxies (LIKE public.account_proxies INCLUDING DEFAULTS) ON COMMIT DROP',
        );
        // The row's name rides in `label` (the id is a uuid the table mints).
        const insert = (
          name: string,
          scheme: string,
          udp: boolean | null,
          quic: boolean | null,
        ): Promise<unknown> =>
          tx.unsafe(
            `INSERT INTO account_proxies (account_id, label, scheme, host, port, udp_probe, udp_probe_at, quic_probe, quic_probe_at)
             VALUES (gen_random_uuid(), $1, $2, 'h.example', 1080, $3, $4::timestamptz, $5, $6::timestamptz)`,
            [name, scheme, udp, udp === null ? null : at, quic, quic === null ? null : at],
          );
        await insert('prx_socks_true', 'socks5', true, false);
        await insert('prx_socks_false', 'socks5', false, true);
        await insert('prx_socks_never', 'socks5', null, null);
        await insert('prx_wg_true', 'wireguard', true, true);
        await insert('prx_ovpn_false', 'openvpn', false, null);
        await insert('prx_http', 'http', null, null);
        for (const statement of statements()) await tx.unsafe(statement);
        rows = await tx.unsafe(
          'SELECT label AS id, scheme, udp_probe, udp_probe_at, quic_probe, quic_probe_at FROM account_proxies ORDER BY label',
        );
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.size).toBe(6);
    for (const id of ['prx_socks_true', 'prx_socks_false']) {
      expect(byId.get(id)?.udp_probe, id).toBeNull();
      expect(byId.get(id)?.udp_probe_at, id).toBeNull();
    }
    // The QUIC reading on the same SOCKS5 rows is a real measurement and stays.
    expect(byId.get('prx_socks_true')?.quic_probe).toBe(false);
    expect(byId.get('prx_socks_false')?.quic_probe).toBe(true);
    expect(byId.get('prx_socks_true')?.quic_probe_at?.toISOString()).toBe(at);
    // VACUITY CONTROL — the VPN rows' readings did not come from this source.
    expect(byId.get('prx_wg_true')?.udp_probe).toBe(true);
    expect(byId.get('prx_wg_true')?.udp_probe_at?.toISOString()).toBe(at);
    expect(byId.get('prx_ovpn_false')?.udp_probe).toBe(false);
    expect(byId.get('prx_socks_never')?.udp_probe).toBeNull();
    expect(byId.get('prx_http')?.udp_probe).toBeNull();
  });
});
