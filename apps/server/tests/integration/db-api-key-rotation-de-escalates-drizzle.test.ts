// V-775 — rotation must not mint authority, and must not launder attribution.
//
// `ApiKeysService.rotate` is the SECOND key-issuance path. `create()` guards it with an
// ELEVATED_SCOPES loop that refuses to grant a scope the caller does not itself hold; `rotate()`
// had no such guard and the repo copied `locked.scopes` verbatim. Two separate defects fell out
// of that one line, and both are asserted here against real Postgres because both live in SQL
// the service layer cannot see.
//
//   1. PRIVILEGE ESCALATION. A caller holding only `account_owner` could rotate a key carrying
//      `driftstack_internal_admin` and be handed a fresh plaintext with staff authority. The
//      route contributes no scope gate (`requireAuth` + rate limit only), and rotate's sole
//      scope check is `account_owner`. rotate()'s own comment already said it "always produces
//      an ordinary customer API key" — the code simply never did it.
//
//   2. ATTRIBUTION LAUNDERING. The successor insert omitted `createdByAccountId`, so it landed
//      NULL. BOTH minter-attributed reclaims filter on that column — team offboarding
//      (`team-members-repo.ts`) and the staff termination sweep
//      (`api-keys-repo.revokeKeysMintedBy`). A member could mint a key on the owner's account,
//      rotate it, and keep a working key through their own offboarding.
//
// The de-escalation is computed inside the FOR UPDATE transaction from the locked row, so these
// tests exercise the same path a concurrent rotation would.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import type { Database } from '../../src/db/client.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `rot_deesc_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let reachable = false;

const NOW = new Date('2026-08-15T12:00:00.000Z');
const GRACE = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    reachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of ['accounts', 'api_keys']) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  client = postgres(DB_URL, { max: 1 });
  db = drizzle(client);
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    await client`SELECT 1 FROM api_keys LIMIT 0`;
  } catch {
    reachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'api-key rotation de-escalates and preserves the minter (V-775, real Postgres)',
  () => {
    async function account(): Promise<string> {
      const id = randomUUID();
      await client!`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${id}, ${`k-${id}@t.test`}, 'api_scale', 'active')`;
      return id;
    }

    async function key(
      accountId: string,
      scopes: string[],
      createdBy: string | null,
    ): Promise<string> {
      const id = randomUUID();
      await client!`
        INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes,
                              created_by_account_id)
        VALUES (${id}, ${accountId}, 'ops', ${`dsk_${id.slice(0, 8)}`}, ${`h-${id}`},
                ${client!.array(scopes)}::api_key_scope[], ${createdBy})
        RETURNING id`;
      return id;
    }

    function repo(): DrizzleApiKeysRepo {
      return new DrizzleApiKeysRepo({
        client: client!,
        db: db!,
        close: async () => {},
      } as unknown as Database);
    }

    async function successorOf(oldKeyId: string, accountId: string) {
      const rows = await client!<
        Array<{ id: string; scopes: string[]; created_by: string | null }>
      >`
        SELECT id, scopes, created_by_account_id AS created_by
          FROM api_keys WHERE account_id = ${accountId} AND id <> ${oldKeyId}`;
      return rows[0];
    }

    it('CRITICAL the successor does NOT carry driftstack_internal_admin — rotate is a second issuance path with only an account_owner gate, so copying the staff scope handed full staff authority to any account_owner caller', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = await account();
      const old = await key(acc, ['read', 'write', 'driftstack_internal_admin'], null);

      const res = await repo().rotateApiKeyAtomic({
        oldKeyId: old,
        accountId: acc,
        keyPrefix: `dsk_${randomUUID().slice(0, 8)}`,
        keyHash: `h-${randomUUID()}`,
        now: NOW,
        gracePeriodMs: GRACE,
      });
      expect(res.kind).toBe('rotated');

      const next = await successorOf(old, acc);
      expect(next?.scopes, 'staff authority must not survive a rotation').not.toContain(
        'driftstack_internal_admin',
      );
      // The ordinary customer scopes are untouched — this de-escalates, it does not neuter.
      expect(next?.scopes).toEqual(expect.arrayContaining(['read', 'write']));
    });

    it('CRITICAL the legacy `admin` alias is REPLACED by account_owner, not merely dropped — dropping it would silently strip customer authority, and admin-scope-mitigation.md says the enum retires only as stored keys are rotated', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const acc = await account();
      const old = await key(acc, ['admin'], null);

      await repo().rotateApiKeyAtomic({
        oldKeyId: old,
        accountId: acc,
        keyPrefix: `dsk_${randomUUID().slice(0, 8)}`,
        keyHash: `h-${randomUUID()}`,
        now: NOW,
        gracePeriodMs: GRACE,
      });

      const next = await successorOf(old, acc);
      expect(next?.scopes, 'the alias is retired on rotation').not.toContain('admin');
      // `admin` granted account_owner + the customer admin:* checks; account_owner satisfies
      // both, so the customer keeps exactly the authority they had.
      expect(next?.scopes).toContain('account_owner');
    });

    it('CRITICAL the successor keeps created_by_account_id — both minter-attributed reclaims filter on it, so a NULL let a rotated key survive the offboarding of the member who minted it', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const owner = await account();
      const minter = await account();
      const old = await key(owner, ['read', 'write'], minter);

      await repo().rotateApiKeyAtomic({
        oldKeyId: old,
        accountId: owner,
        keyPrefix: `dsk_${randomUUID().slice(0, 8)}`,
        keyHash: `h-${randomUUID()}`,
        now: NOW,
        gracePeriodMs: GRACE,
      });

      const next = await successorOf(old, owner);
      expect(next?.created_by, 'rotation must not launder attribution').toBe(minter);

      // End-to-end: the enumeration both reclaims are built on must now SEE the successor.
      // V-727's listApiKeysMintedBy is deliberately not account-scoped — the point is keys the
      // member minted on OTHER accounts — so before this fix it returned only the original and
      // the rotated successor was invisible to offboarding.
      const minted = await repo().listApiKeysMintedBy(minter);
      expect(
        minted.map((k) => k.id).sort(),
        'both the original and its successor must be reclaimable',
      ).toEqual([old, next!.id].sort());
    });
  },
);
