// Drizzle-backed implementation of AuthFlowsRepo (V-079).
//
// Maps the AuthFlowsService's domain shape onto the four token tables
// (`email_verify_tokens`, `magic_link_tokens`, `password_reset_tokens`)
// + `web_sessions` + the new `accounts.password_hash` /
// `accounts.email_verified_at` columns.

import { and, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  AuthFlowAccountRow,
  AuthFlowKind,
  AuthFlowTokenRow,
  AuthFlowsRepo,
  WebSessionRow,
} from '../services/auth-flows.js';
import { canonicalizeEmailForDedup } from '../services/auth-flows.js';
import type { Database } from './client.js';
import {
  accounts,
  emailVerifyTokens,
  magicLinkTokens,
  passwordResetTokens,
  webSessions,
} from './schema.js';
import type { AccountTier } from '@driftstack/api-types';

function tableForKind(kind: AuthFlowKind) {
  switch (kind) {
    case 'email_verify':
      return emailVerifyTokens;
    case 'magic_link':
      return magicLinkTokens;
    case 'password_reset':
      return passwordResetTokens;
  }
}

function toAccountRow(r: typeof accounts.$inferSelect): AuthFlowAccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    passwordHash: r.passwordHash,
    emailVerifiedAt: r.emailVerifiedAt,
    tier: r.tier,
    status: r.status,
    createdAt: r.createdAt,
  };
}

function toTokenRow<T extends typeof emailVerifyTokens.$inferSelect>(r: T): AuthFlowTokenRow {
  return {
    id: r.id,
    accountId: r.accountId,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    createdAt: r.createdAt,
  };
}

function toWebSessionRow(r: typeof webSessions.$inferSelect): WebSessionRow {
  return {
    id: r.id,
    accountId: r.accountId,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    issuedFromIp: r.issuedFromIp,
    userAgent: r.userAgent,
    mfaSatisfiedAt: r.mfaSatisfiedAt,
    createdAt: r.createdAt,
  };
}

export class DrizzleAuthFlowsRepo implements AuthFlowsRepo {
  constructor(private readonly database: Database) {}

  async findAccountByEmail(email: string): Promise<AuthFlowAccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.email, email.trim().toLowerCase()))
      .limit(1);
    return row ? toAccountRow(row) : null;
  }

  // 2026-07-01 security fix — looks up by the accounts_canonical_email_unique
  // index (migration 0096) instead of the literal accounts_email_unique one,
  // so a signup collides with ANY existing account whose Gmail dot/+tag
  // canonical form matches — regardless of which literal variant was stored
  // first. Caller is expected to pass an already-canonicalized value (see
  // canonicalizeEmailForDedup).
  async findAccountByCanonicalEmail(canonicalEmail: string): Promise<AuthFlowAccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.canonicalEmail, canonicalEmail))
      .limit(1);
    return row ? toAccountRow(row) : null;
  }

  async findAccountById(id: string): Promise<AuthFlowAccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? toAccountRow(row) : null;
  }

  async createAccount(args: {
    email: string;
    name: string | null;
    passwordHash: string;
    initialTier: AccountTier;
    // Arc 1 sub-slice 6.2 (v2-#6) — optional bundled-LLM opt-in.
    bundledLlmConsent?: boolean;
    bundledLlmMonthlyCapUsdCents?: number;
  }): Promise<AuthFlowAccountRow> {
    const [row] = await this.database.db
      .insert(accounts)
      .values({
        email: args.email.trim().toLowerCase(),
        name: args.name,
        passwordHash: args.passwordHash,
        tier: args.initialTier,
        ...(args.bundledLlmConsent !== undefined
          ? { bundledLlmConsent: args.bundledLlmConsent }
          : {}),
        ...(args.bundledLlmMonthlyCapUsdCents !== undefined
          ? { bundledLlmMonthlyCapUsdCents: args.bundledLlmMonthlyCapUsdCents }
          : {}),
        // 2026-07-01 security fix — computed from the SAME
        // trim+lowercase normalization every account-creation caller
        // uses (password signup, OAuth IDP signup), not a separately-
        // passed argument, so every row's canonical form is always in
        // lockstep with its literal email. See migration 0096 +
        // canonicalizeEmailForDedup.
        canonicalEmail: canonicalizeEmailForDedup(args.email.trim().toLowerCase()),
      })
      .returning();
    if (!row) throw new Error('createAccount: insert returned no row');
    return toAccountRow(row);
  }

  async setPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
  }

  async markEmailVerified(accountId: string, at: Date): Promise<boolean> {
    // C9 — atomic first-transition claim: the isNull(emailVerifiedAt) guard
    // means a row is returned ONLY on the null→verified transition, so of
    // several outstanding verify tokens exactly one is the "first" and gets to
    // fire the one-time signup-welcome email.
    const rows = await this.database.db
      .update(accounts)
      .set({ emailVerifiedAt: at, updatedAt: at })
      .where(and(eq(accounts.id, accountId), isNull(accounts.emailVerifiedAt)))
      .returning({ id: accounts.id });
    return rows.length > 0;
  }

  async insertAuthToken(args: {
    kind: AuthFlowKind;
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedFromIp: string | null;
  }): Promise<AuthFlowTokenRow> {
    const t = tableForKind(args.kind);
    const [row] = await this.database.db
      .insert(t)
      .values({
        accountId: args.accountId,
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
        requestedFromIp: args.requestedFromIp,
      })
      .returning();
    if (!row) throw new Error('insertAuthToken: insert returned no row');
    return toTokenRow(row);
  }

  async findActiveAuthToken(args: {
    kind: AuthFlowKind;
    tokenHash: string;
    now: Date;
  }): Promise<AuthFlowTokenRow | null> {
    const t = tableForKind(args.kind);
    const [row] = await this.database.db
      .select()
      .from(t)
      .where(and(eq(t.tokenHash, args.tokenHash), gt(t.expiresAt, args.now), isNull(t.consumedAt)))
      .limit(1);
    return row ? toTokenRow(row) : null;
  }

  async consumeAuthToken(args: { kind: AuthFlowKind; id: string; at: Date }): Promise<boolean> {
    const t = tableForKind(args.kind);
    const rows = await this.database.db
      .update(t)
      .set({ consumedAt: args.at })
      .where(and(eq(t.id, args.id), isNull(t.consumedAt)))
      .returning({ id: t.id });
    // rows.length === 1 → this call claimed the token; 0 → already consumed
    // (a concurrent winner), so the caller must reject rather than double-run.
    return rows.length > 0;
  }

  async consumeAuthTokenFamily(args: {
    kind: AuthFlowKind;
    id: string;
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    const t = tableForKind(args.kind);
    const rows = await this.database.db
      .update(t)
      .set({ consumedAt: args.at })
      .where(and(eq(t.accountId, args.accountId), isNull(t.consumedAt)))
      .returning({ id: t.id });
    return rows.some((row) => row.id === args.id);
  }

  async deleteStaleAuthTokens(args: {
    kind: AuthFlowKind;
    consumedBefore: Date;
    expiredBefore: Date;
  }): Promise<number> {
    // postgres-js bind step calls Buffer.byteLength on params; pass ISO
    // strings rather than raw Date objects (matches d9417a91 drift-guard
    // pattern that fired the 2026-05-19 scheduled-jobs-poller TypeError).
    const consumedIso = args.consumedBefore.toISOString();
    const expiredIso = args.expiredBefore.toISOString();
    const t = tableForKind(args.kind);
    const result = await this.database.db
      .delete(t)
      .where(
        or(
          and(sql`${t.consumedAt} IS NOT NULL`, lt(t.consumedAt, sql`${consumedIso}::timestamptz`)),
          and(isNull(t.consumedAt), lt(t.expiresAt, sql`${expiredIso}::timestamptz`)),
        ),
      )
      .returning({ id: t.id });
    return result.length;
  }

  async insertWebSession(args: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    issuedFromIp: string | null;
    userAgent: string | null;
  }): Promise<WebSessionRow> {
    const [row] = await this.database.db
      .insert(webSessions)
      .values({
        accountId: args.accountId,
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
        issuedFromIp: args.issuedFromIp,
        userAgent: args.userAgent,
      })
      .returning();
    if (!row) throw new Error('insertWebSession: insert returned no row');
    return toWebSessionRow(row);
  }

  async findActiveWebSession(args: {
    tokenHash: string;
    now: Date;
  }): Promise<WebSessionRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webSessions)
      .where(
        and(
          eq(webSessions.tokenHash, args.tokenHash),
          gt(webSessions.expiresAt, args.now),
          isNull(webSessions.revokedAt),
        ),
      )
      .limit(1);
    return row ? toWebSessionRow(row) : null;
  }

  async touchWebSession(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(webSessions)
      .set({ lastUsedAt: at })
      .where(eq(webSessions.id, id));
  }

  async revokeWebSession(id: string, at: Date): Promise<boolean> {
    const rows = await this.database.db
      .update(webSessions)
      .set({ revokedAt: at })
      .where(and(eq(webSessions.id, id), isNull(webSessions.revokedAt)))
      .returning({ id: webSessions.id });
    return rows.length === 1;
  }

  async listActiveWebSessionsForAccount(accountId: string, now: Date): Promise<WebSessionRow[]> {
    const rows = await this.database.db
      .select()
      .from(webSessions)
      .where(
        and(
          eq(webSessions.accountId, accountId),
          isNull(webSessions.revokedAt),
          gt(webSessions.expiresAt, now),
        ),
      )
      .orderBy(desc(webSessions.lastUsedAt));
    return rows.map(toWebSessionRow);
  }

  async findWebSessionByIdForAccount(id: string, accountId: string): Promise<WebSessionRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webSessions)
      .where(and(eq(webSessions.id, id), eq(webSessions.accountId, accountId)))
      .limit(1);
    return row ? toWebSessionRow(row) : null;
  }

  async revokeAllWebSessionsExcept(accountId: string, exceptId: string, at: Date): Promise<number> {
    const rows = await this.database.db
      .update(webSessions)
      .set({ revokedAt: at })
      .where(
        and(
          eq(webSessions.accountId, accountId),
          isNull(webSessions.revokedAt),
          ne(webSessions.id, exceptId),
        ),
      )
      .returning({ id: webSessions.id });
    return rows.length;
  }

  async revokeAllWebSessionsForAccount(accountId: string, at: Date): Promise<number> {
    const rows = await this.database.db
      .update(webSessions)
      .set({ revokedAt: at })
      .where(and(eq(webSessions.accountId, accountId), isNull(webSessions.revokedAt)))
      .returning({ id: webSessions.id });
    return rows.length;
  }

  async markWebSessionMfaSatisfied(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(webSessions)
      .set({ mfaSatisfiedAt: at })
      .where(eq(webSessions.id, id));
  }
}
