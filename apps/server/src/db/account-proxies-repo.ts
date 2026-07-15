// ARC A — account_proxies repo (storage layer for per-account customer proxies).
//
// Thin DB layer, mirroring DrizzleProfilesRepo: it stores/returns
// `wrappedPassword`/`wrappedSecret` as opaque versioned envelopes. Every
// read/mutation is OWNER-SCOPED (filtered by
// accountId) so one account can never read/update/delete another's proxy — the
// same cross-account isolation the profile DEK relies on.

import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import { accountProxies } from './schema.js';
import {
  ACCOUNT_PROXY_SECRET_V2_PREFIX,
  convertAccountProxySecretToV2,
  readAccountProxySecret,
  type AccountProxySecretSlot,
} from '../lib/account-proxy-secret-encryption.js';

const MAX_PROXY_SECRET_MIGRATION_BATCH = 500;

/** Full row incl. the wrapped password (opaque). Internal — the API never
 *  returns `wrappedPassword`; the service maps to a metadata view. */
export interface AccountProxyRow {
  id: string;
  accountId: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  /** Record/slot-bound v2 envelope, or null. Opaque at the repository boundary. */
  wrappedPassword: string | null;
  /** OVPN/WG record/slot-bound secret (config_blob / private_key), or null. */
  wrappedSecret: string | null;
  /** OVPN/WG: non-secret structured fields. `{}` for socks5/http rows. */
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAccountProxyRow {
  /** Stable UUID allocated before credential encryption. */
  id: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  wrappedPassword: string | null;
  /** Optional — VPN secret payload; defaults to null (socks5/http rows). */
  wrappedSecret?: string | null;
  /** Optional — non-secret VPN fields; defaults to `{}` (socks5/http rows). */
  config?: Record<string, unknown>;
}

export interface AccountProxyRowUpdates {
  label?: string;
  scheme?: string;
  host?: string;
  port?: number;
  username?: string | null;
  wrappedPassword?: string | null;
  wrappedSecret?: string | null;
  config?: Record<string, unknown>;
}

export interface AccountProxiesRepo {
  list(accountId: string): Promise<AccountProxyRow[]>;
  findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null>;
  create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow>;
  createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null>;
  update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null>;
  /** Returns true if a row was removed; false if no owned row matched. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
  migrateSecretEnvelopes(
    masterKey: Buffer,
    limit?: number,
  ): Promise<{ scanned: number; converted: number; remaining: number }>;
}

function wrappersAreV2(): SQL {
  return sql`(
    (${accountProxies.wrappedPassword} IS NULL OR ${accountProxies.wrappedPassword} LIKE ${`${ACCOUNT_PROXY_SECRET_V2_PREFIX}%`})
    AND (${accountProxies.wrappedSecret} IS NULL OR ${accountProxies.wrappedSecret} LIKE ${`${ACCOUNT_PROXY_SECRET_V2_PREFIX}%`})
    AND (${accountProxies.wrappedSecret} IS NULL OR ${accountProxies.scheme} IN ('openvpn', 'wireguard'))
  )`;
}

function wrappersAreNotV2(): SQL {
  return sql`NOT (${wrappersAreV2()})`;
}

function vpnSecretSlot(scheme: string): AccountProxySecretSlot {
  if (scheme === 'openvpn') return 'openvpn-config';
  if (scheme === 'wireguard') return 'wireguard-private-key';
  throw new Error(`Account proxy scheme ${scheme} cannot carry wrapped_secret.`);
}

function rowWrappersAreV2(row: {
  scheme: string;
  wrappedPassword: string | null;
  wrappedSecret: string | null;
}): boolean {
  return (
    (row.wrappedPassword === null ||
      row.wrappedPassword.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) &&
    (row.wrappedSecret === null || row.wrappedSecret.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) &&
    (row.wrappedSecret === null || row.scheme === 'openvpn' || row.scheme === 'wireguard')
  );
}

function validateLimit(name: string, limit: number, maximum?: number): void {
  if (!Number.isInteger(limit) || limit < 1 || (maximum !== undefined && limit > maximum)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer.`
        : `${name} must be an integer from 1 to ${maximum.toString()}.`,
    );
  }
}

function toRow(r: typeof accountProxies.$inferSelect): AccountProxyRow {
  return {
    id: r.id,
    accountId: r.accountId,
    label: r.label,
    scheme: r.scheme,
    host: r.host,
    port: r.port,
    username: r.username,
    wrappedPassword: r.wrappedPassword,
    wrappedSecret: r.wrappedSecret,
    config: r.config,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class DrizzleAccountProxiesRepo implements AccountProxiesRepo {
  constructor(private readonly database: Database) {}

  async list(accountId: string): Promise<AccountProxyRow[]> {
    const rows = await this.database.db
      .select()
      .from(accountProxies)
      .where(eq(accountProxies.accountId, accountId))
      .orderBy(asc(accountProxies.createdAt));
    return rows.map(toRow);
  }

  async findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null> {
    const rows = await this.database.db
      .select()
      .from(accountProxies)
      .where(and(eq(accountProxies.id, args.id), eq(accountProxies.accountId, args.accountId)))
      .limit(1);
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow> {
    const rows = await this.database.db
      .insert(accountProxies)
      .values({
        id: input.id,
        accountId,
        label: input.label,
        scheme: input.scheme,
        host: input.host,
        port: input.port,
        username: input.username,
        wrappedPassword: input.wrappedPassword,
        wrappedSecret: input.wrappedSecret ?? null,
        config: input.config ?? {},
      })
      .returning();
    // insert-returning always yields the inserted row.
    return toRow(rows[0]!);
  }

  async createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null> {
    validateLimit('Account proxy limit', limit);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`account-proxy-create:${accountId}`}))`,
      );
      const [countRow] = await tx
        .select({ value: count() })
        .from(accountProxies)
        .where(eq(accountProxies.accountId, accountId));
      if ((countRow?.value ?? 0) >= limit) return null;
      const [row] = await tx
        .insert(accountProxies)
        .values({
          id: input.id,
          accountId,
          label: input.label,
          scheme: input.scheme,
          host: input.host,
          port: input.port,
          username: input.username,
          wrappedPassword: input.wrappedPassword,
          wrappedSecret: input.wrappedSecret ?? null,
          config: input.config ?? {},
        })
        .returning();
      if (!row) throw new Error('Account proxy capped insert returned no row.');
      return toRow(row);
    });
  }

  async update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const rows = await this.database.db
      .update(accountProxies)
      .set({ ...args.updates, updatedAt: new Date() })
      // Owner-scoped: a cross-account id simply matches no row → null.
      .where(
        and(
          eq(accountProxies.id, args.id),
          eq(accountProxies.accountId, args.accountId),
          ...(args.expectedScheme !== undefined
            ? [eq(accountProxies.scheme, args.expectedScheme)]
            : []),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async delete(args: { id: string; accountId: string }): Promise<boolean> {
    const rows = await this.database.db
      .delete(accountProxies)
      .where(and(eq(accountProxies.id, args.id), eq(accountProxies.accountId, args.accountId)))
      .returning({ id: accountProxies.id });
    return rows.length > 0;
  }

  async migrateSecretEnvelopes(
    masterKey: Buffer,
    limit = MAX_PROXY_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    validateLimit('Account proxy secret migration limit', limit, MAX_PROXY_SECRET_MIGRATION_BATCH);

    // Authenticate one already-bound tuple even after every legacy row drains.
    const [v2Probe] = await this.database.db
      .select({
        id: accountProxies.id,
        accountId: accountProxies.accountId,
        scheme: accountProxies.scheme,
        wrappedPassword: accountProxies.wrappedPassword,
        wrappedSecret: accountProxies.wrappedSecret,
      })
      .from(accountProxies)
      .where(
        and(
          wrappersAreV2(),
          sql`(${accountProxies.wrappedPassword} IS NOT NULL OR ${accountProxies.wrappedSecret} IS NOT NULL)`,
        ),
      )
      .orderBy(asc(accountProxies.id))
      .limit(1);
    if (v2Probe !== undefined) {
      if (v2Probe.wrappedPassword !== null) {
        readAccountProxySecret(
          masterKey,
          { accountId: v2Probe.accountId, proxyId: v2Probe.id, slot: 'password' },
          v2Probe.wrappedPassword,
        );
      }
      if (v2Probe.wrappedSecret !== null) {
        readAccountProxySecret(
          masterKey,
          {
            accountId: v2Probe.accountId,
            proxyId: v2Probe.id,
            slot: vpnSecretSlot(v2Probe.scheme),
          },
          v2Probe.wrappedSecret,
        );
      }
    }

    const rows = await this.database.db
      .select({
        id: accountProxies.id,
        accountId: accountProxies.accountId,
        scheme: accountProxies.scheme,
        wrappedPassword: accountProxies.wrappedPassword,
        wrappedSecret: accountProxies.wrappedSecret,
      })
      .from(accountProxies)
      .where(wrappersAreNotV2())
      .orderBy(asc(accountProxies.id))
      .limit(limit);

    // Map the complete page before the first maintenance write.
    const prepared = rows.map((row) => ({
      row,
      wrappedPassword:
        row.wrappedPassword === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              { accountId: row.accountId, proxyId: row.id, slot: 'password' },
              row.wrappedPassword,
            ),
      wrappedSecret:
        row.wrappedSecret === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              {
                accountId: row.accountId,
                proxyId: row.id,
                slot: vpnSecretSlot(row.scheme),
              },
              row.wrappedSecret,
            ),
    }));

    let converted = 0;
    for (const { row, wrappedPassword, wrappedSecret } of prepared) {
      const updated = await this.database.db
        .update(accountProxies)
        .set({ wrappedPassword, wrappedSecret })
        .where(
          and(
            eq(accountProxies.id, row.id),
            eq(accountProxies.accountId, row.accountId),
            eq(accountProxies.scheme, row.scheme),
            sql`${accountProxies.wrappedPassword} IS NOT DISTINCT FROM ${row.wrappedPassword}`,
            sql`${accountProxies.wrappedSecret} IS NOT DISTINCT FROM ${row.wrappedSecret}`,
          ),
        )
        .returning({ id: accountProxies.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(accountProxies)
      .where(wrappersAreNotV2());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }
}

/** In-memory double — same owner-scoping invariants, for unit tests + the
 *  in-memory app stack. IDs are preallocated by callers before encryption. */
export class InMemoryAccountProxiesRepo implements AccountProxiesRepo {
  private readonly rows = new Map<string, AccountProxyRow>();

  list(accountId: string): Promise<AccountProxyRow[]> {
    const out = [...this.rows.values()]
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }));
    return Promise.resolve(out);
  }

  findById(args: { id: string; accountId: string }): Promise<AccountProxyRow | null> {
    const r = this.rows.get(args.id);
    return Promise.resolve(r && r.accountId === args.accountId ? { ...r } : null);
  }

  create(accountId: string, input: NewAccountProxyRow): Promise<AccountProxyRow> {
    if (this.rows.has(input.id)) throw new Error('Account proxy id already exists.');
    const now = new Date();
    const row: AccountProxyRow = {
      id: input.id,
      accountId,
      label: input.label,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username: input.username,
      wrappedPassword: input.wrappedPassword,
      wrappedSecret: input.wrappedSecret ?? null,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  createIfUnderLimit(
    accountId: string,
    input: NewAccountProxyRow,
    limit: number,
  ): Promise<AccountProxyRow | null> {
    validateLimit('Account proxy limit', limit);
    const accountRows = [...this.rows.values()].filter((row) => row.accountId === accountId);
    if (accountRows.length >= limit) return Promise.resolve(null);
    return this.create(accountId, input);
  }

  update(args: {
    id: string;
    accountId: string;
    expectedScheme?: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const r = this.rows.get(args.id);
    if (
      !r ||
      r.accountId !== args.accountId ||
      (args.expectedScheme !== undefined && r.scheme !== args.expectedScheme)
    ) {
      return Promise.resolve(null);
    }
    const next: AccountProxyRow = { ...r, ...args.updates, updatedAt: new Date() };
    this.rows.set(next.id, next);
    return Promise.resolve({ ...next });
  }

  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }

  migrateSecretEnvelopes(
    masterKey: Buffer,
    limit = MAX_PROXY_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    validateLimit('Account proxy secret migration limit', limit, MAX_PROXY_SECRET_MIGRATION_BATCH);
    const sortedRows = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const v2Probe = sortedRows.find(
      (row) =>
        rowWrappersAreV2(row) && (row.wrappedPassword !== null || row.wrappedSecret !== null),
    );
    if (v2Probe !== undefined) {
      if (v2Probe.wrappedPassword !== null) {
        readAccountProxySecret(
          masterKey,
          { accountId: v2Probe.accountId, proxyId: v2Probe.id, slot: 'password' },
          v2Probe.wrappedPassword,
        );
      }
      if (v2Probe.wrappedSecret !== null) {
        readAccountProxySecret(
          masterKey,
          {
            accountId: v2Probe.accountId,
            proxyId: v2Probe.id,
            slot: vpnSecretSlot(v2Probe.scheme),
          },
          v2Probe.wrappedSecret,
        );
      }
    }
    const legacy = sortedRows.filter((row) => !rowWrappersAreV2(row)).slice(0, limit);
    const prepared = legacy.map((row) => ({
      row,
      wrappedPassword:
        row.wrappedPassword === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              { accountId: row.accountId, proxyId: row.id, slot: 'password' },
              row.wrappedPassword,
            ),
      wrappedSecret:
        row.wrappedSecret === null
          ? null
          : convertAccountProxySecretToV2(
              masterKey,
              {
                accountId: row.accountId,
                proxyId: row.id,
                slot: vpnSecretSlot(row.scheme),
              },
              row.wrappedSecret,
            ),
    }));
    for (const value of prepared) {
      this.rows.set(value.row.id, {
        ...value.row,
        wrappedPassword: value.wrappedPassword,
        wrappedSecret: value.wrappedSecret,
      });
    }
    const remaining = [...this.rows.values()].filter((row) => !rowWrappersAreV2(row)).length;
    return Promise.resolve({ scanned: legacy.length, converted: legacy.length, remaining });
  }
}
