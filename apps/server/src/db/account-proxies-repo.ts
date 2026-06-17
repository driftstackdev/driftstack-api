// ARC A — account_proxies repo (storage layer for per-account customer proxies).
//
// Thin DB layer, mirroring DrizzleProfilesRepo: it stores/returns
// `wrappedPassword` as OPAQUE base64 — the TMK wrap/unwrap is the service's job
// (it owns PROFILE_MASTER_KEY). Every read/mutation is OWNER-SCOPED (filtered by
// accountId) so one account can never read/update/delete another's proxy — the
// same cross-account isolation the profile DEK relies on.

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { accountProxies } from './schema.js';

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
  /** base64([iv|tag|ct]) wrapped under the account TMK, or null. Opaque here. */
  wrappedPassword: string | null;
  /** OVPN/WG: wrapped secret payload (config_blob / private_key), or null. Opaque. */
  wrappedSecret: string | null;
  /** OVPN/WG: non-secret structured fields. `{}` for socks5/http rows. */
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAccountProxyRow {
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
  update(args: {
    id: string;
    accountId: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null>;
  /** Returns true if a row was removed; false if no owned row matched. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
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

  async update(args: {
    id: string;
    accountId: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const rows = await this.database.db
      .update(accountProxies)
      .set({ ...args.updates, updatedAt: new Date() })
      // Owner-scoped: a cross-account id simply matches no row → null.
      .where(and(eq(accountProxies.id, args.id), eq(accountProxies.accountId, args.accountId)))
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
}

/** In-memory double — same owner-scoping invariants, for unit tests + the
 *  in-memory app stack. Uses crypto.randomUUID for ids (the DB default in
 *  Drizzle). */
export class InMemoryAccountProxiesRepo implements AccountProxiesRepo {
  private readonly rows = new Map<string, AccountProxyRow>();

  private mintId(): string {
    return crypto.randomUUID();
  }

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
    const now = new Date();
    const row: AccountProxyRow = {
      id: this.mintId(),
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

  update(args: {
    id: string;
    accountId: string;
    updates: AccountProxyRowUpdates;
  }): Promise<AccountProxyRow | null> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(null);
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
}
