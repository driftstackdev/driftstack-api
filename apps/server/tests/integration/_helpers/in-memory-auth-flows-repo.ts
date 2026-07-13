// In-memory AuthFlowsRepo for integration tests.
//
// Stores accounts + the four single-use token kinds + web_sessions in
// plain Maps keyed by id. Behavioural fidelity:
//   - email lookup is case-insensitive (canonical lowercased email)
//   - tokens are stored by their pre-hashed token value
//   - findActiveAuthToken filters by kind + tokenHash + expires_at + consumed_at
//   - revoke / consume mutations follow the same atomicity boundary as Drizzle's
//
// No FK enforcement; tests that exercise account-cascade-delete shapes
// should use the Drizzle repo against real Postgres.

import { randomUUID } from 'node:crypto';
import type {
  AuthFlowAccountRow,
  AuthFlowKind,
  AuthFlowTokenRow,
  AuthFlowsRepo,
  WebSessionRow,
} from '../../../src/services/auth-flows.js';
import { canonicalizeEmailForDedup } from '../../../src/services/auth-flows.js';

interface Storage {
  account: AuthFlowAccountRow;
  // 2026-07-01 security fix — mirrors accounts.canonical_email (migration
  // 0096). Computed the same way the Drizzle repo computes it at insert
  // time (canonicalizeEmailForDedup), so findAccountByCanonicalEmail
  // behaves identically against both repo implementations.
  canonicalEmail: string;
}

export class InMemoryAuthFlowsRepo implements AuthFlowsRepo {
  private accounts = new Map<string, Storage>();
  private tokensByKind: Record<AuthFlowKind, Map<string, AuthFlowTokenRow>> = {
    email_verify: new Map(),
    magic_link: new Map(),
    password_reset: new Map(),
  };
  private webSessions = new Map<string, WebSessionRow>();

  /**
   * Test-only seam for seeding existing accounts (e.g. legacy migration
   * scenarios where accounts pre-date the password column). Computes
   * canonicalEmail off row.email the same way createAccount does, so a
   * seeded account is findable via findAccountByCanonicalEmail too.
   */
  seedAccount(row: AuthFlowAccountRow): void {
    this.accounts.set(row.id, {
      account: row,
      canonicalEmail: canonicalizeEmailForDedup(row.email),
    });
  }

  findAccountByEmail(email: string): Promise<AuthFlowAccountRow | null> {
    const wanted = email.trim().toLowerCase();
    for (const { account } of this.accounts.values()) {
      if (account.email === wanted) return Promise.resolve(account);
    }
    return Promise.resolve(null);
  }

  // 2026-07-01 security fix — mirrors DrizzleAuthFlowsRepo.findAccountByCanonicalEmail
  // (accounts_canonical_email_unique, migration 0096): matches ANY stored
  // account whose canonical form equals the given one, regardless of which
  // literal variant was registered first.
  findAccountByCanonicalEmail(canonicalEmail: string): Promise<AuthFlowAccountRow | null> {
    for (const slot of this.accounts.values()) {
      if (slot.canonicalEmail === canonicalEmail) return Promise.resolve(slot.account);
    }
    return Promise.resolve(null);
  }

  findAccountById(id: string): Promise<AuthFlowAccountRow | null> {
    return Promise.resolve(this.accounts.get(id)?.account ?? null);
  }

  createAccount(args: {
    email: string;
    name: string | null;
    passwordHash: string;
    initialTier: AuthFlowAccountRow['tier'];
    // Arc 1 sub-slice 6.2 (v2-#6) — bundled-LLM opt-in. The
    // in-memory row doesn't surface these on AuthFlowAccountRow
    // today (the type stays narrow); accepting them as no-ops
    // preserves caller parity with the Drizzle path so tests can
    // exercise the signup wire without TS errors.
    bundledLlmConsent?: boolean;
    bundledLlmMonthlyCapUsdCents?: number;
  }): Promise<AuthFlowAccountRow> {
    const now = new Date();
    const normalizedEmail = args.email.trim().toLowerCase();
    const row: AuthFlowAccountRow = {
      id: randomUUID(),
      email: normalizedEmail,
      name: args.name,
      passwordHash: args.passwordHash,
      emailVerifiedAt: null,
      tier: args.initialTier,
      status: 'active',
      createdAt: now,
    };
    this.accounts.set(row.id, {
      account: row,
      canonicalEmail: canonicalizeEmailForDedup(normalizedEmail),
    });
    return Promise.resolve(row);
  }

  setPassword(accountId: string, passwordHash: string): Promise<void> {
    const slot = this.accounts.get(accountId);
    if (!slot) return Promise.resolve();
    slot.account = { ...slot.account, passwordHash };
    return Promise.resolve();
  }

  markEmailVerified(accountId: string, at: Date): Promise<boolean> {
    const slot = this.accounts.get(accountId);
    if (!slot) return Promise.resolve(false);
    if (slot.account.emailVerifiedAt !== null) return Promise.resolve(false);
    slot.account = { ...slot.account, emailVerifiedAt: at };
    return Promise.resolve(true);
  }

  insertAuthToken(args: {
    kind: AuthFlowKind;
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedFromIp: string | null;
  }): Promise<AuthFlowTokenRow> {
    const row: AuthFlowTokenRow = {
      id: randomUUID(),
      accountId: args.accountId,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.tokensByKind[args.kind].set(row.id, row);
    return Promise.resolve(row);
  }

  findActiveAuthToken(args: {
    kind: AuthFlowKind;
    tokenHash: string;
    now: Date;
  }): Promise<AuthFlowTokenRow | null> {
    for (const row of this.tokensByKind[args.kind].values()) {
      if (row.tokenHash !== args.tokenHash) continue;
      if (row.consumedAt !== null) continue;
      if (row.expiresAt.getTime() <= args.now.getTime()) continue;
      return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  consumeAuthToken(args: { kind: AuthFlowKind; id: string; at: Date }): Promise<boolean> {
    const row = this.tokensByKind[args.kind].get(args.id);
    // Mirror the drizzle conditional UPDATE: only the first consume of an
    // unconsumed token "claims" it (returns true); a later attempt on an
    // already-consumed row returns false.
    if (!row || row.consumedAt !== null) return Promise.resolve(false);
    this.tokensByKind[args.kind].set(args.id, { ...row, consumedAt: args.at });
    return Promise.resolve(true);
  }

  consumeAuthTokenFamily(args: {
    kind: AuthFlowKind;
    id: string;
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    const rows = this.tokensByKind[args.kind];
    const target = rows.get(args.id);
    const claimedTarget =
      target !== undefined && target.accountId === args.accountId && target.consumedAt === null;
    if (!claimedTarget) return Promise.resolve(false);
    for (const [id, row] of rows.entries()) {
      if (row.accountId !== args.accountId || row.consumedAt !== null) continue;
      rows.set(id, { ...row, consumedAt: args.at });
    }
    return Promise.resolve(true);
  }

  deleteStaleAuthTokens(args: {
    kind: AuthFlowKind;
    consumedBefore: Date;
    expiredBefore: Date;
  }): Promise<number> {
    const map = this.tokensByKind[args.kind];
    let deleted = 0;
    for (const [id, row] of map.entries()) {
      const staleConsumed = row.consumedAt !== null && row.consumedAt < args.consumedBefore;
      const staleExpired = row.consumedAt === null && row.expiresAt < args.expiredBefore;
      if (staleConsumed || staleExpired) {
        map.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  insertWebSession(args: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    issuedFromIp: string | null;
    userAgent: string | null;
  }): Promise<WebSessionRow> {
    const now = new Date();
    const row: WebSessionRow = {
      id: randomUUID(),
      accountId: args.accountId,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      lastUsedAt: now,
      revokedAt: null,
      issuedFromIp: args.issuedFromIp,
      userAgent: args.userAgent,
      mfaSatisfiedAt: null,
      createdAt: now,
    };
    this.webSessions.set(row.id, row);
    return Promise.resolve(row);
  }

  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionRow | null> {
    for (const row of this.webSessions.values()) {
      if (row.tokenHash !== args.tokenHash) continue;
      if (row.revokedAt !== null) continue;
      if (row.expiresAt.getTime() <= args.now.getTime()) continue;
      return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  touchWebSession(id: string, at: Date): Promise<void> {
    const row = this.webSessions.get(id);
    if (!row) return Promise.resolve();
    this.webSessions.set(id, { ...row, lastUsedAt: at });
    return Promise.resolve();
  }

  revokeWebSession(id: string, at: Date): Promise<boolean> {
    const row = this.webSessions.get(id);
    if (!row || row.revokedAt !== null) return Promise.resolve(false);
    this.webSessions.set(id, { ...row, revokedAt: at });
    return Promise.resolve(true);
  }

  // ── V-355 — list / lookup / bulk-revoke per account ───────────────
  listActiveWebSessionsForAccount(accountId: string, now: Date): Promise<WebSessionRow[]> {
    const out: WebSessionRow[] = [];
    for (const row of this.webSessions.values()) {
      if (row.accountId !== accountId) continue;
      if (row.revokedAt !== null) continue;
      if (row.expiresAt.getTime() <= now.getTime()) continue;
      out.push(row);
    }
    out.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
    return Promise.resolve(out);
  }

  findWebSessionByIdForAccount(id: string, accountId: string): Promise<WebSessionRow | null> {
    const row = this.webSessions.get(id);
    if (!row) return Promise.resolve(null);
    if (row.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(row);
  }

  revokeAllWebSessionsExcept(accountId: string, exceptId: string, at: Date): Promise<number> {
    let n = 0;
    for (const row of this.webSessions.values()) {
      if (row.accountId !== accountId) continue;
      if (row.id === exceptId) continue;
      if (row.revokedAt !== null) continue;
      this.webSessions.set(row.id, { ...row, revokedAt: at });
      n++;
    }
    return Promise.resolve(n);
  }

  revokeAllWebSessionsForAccount(accountId: string, at: Date): Promise<number> {
    let n = 0;
    for (const row of this.webSessions.values()) {
      if (row.accountId !== accountId) continue;
      if (row.revokedAt !== null) continue;
      this.webSessions.set(row.id, { ...row, revokedAt: at });
      n++;
    }
    return Promise.resolve(n);
  }

  markWebSessionMfaSatisfied(id: string, at: Date): Promise<void> {
    const row = this.webSessions.get(id);
    if (row) this.webSessions.set(id, { ...row, mfaSatisfiedAt: at });
    return Promise.resolve();
  }
}
