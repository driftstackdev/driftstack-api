// V-667.C — OAuth-client service interfaces.
//
// The service composes 4 repos (oauth-links + oauth-pending-links +
// accounts + email-sender) to fulfil the founder-locked verdicts:
//
//   Verdict 1: existing-email collision → merge-with-verification via
//     oauth_pending_links token sent to existing account's email.
//   Verdict 2: IDP revocation → mark account_oauth_links.last_revoked_at
//     on next-login-failure; graceful fallback to password (if set).
//   Verdict 3: avatar/name sync → first-link-only; user-override
//     wins (driven by accounts.avatar_source enum).
//
// This file defines the REPO interfaces + the SERVICE interface. The
// Drizzle implementation lands in db/oauth-links-repo.ts (next slice);
// the service implementation lands in services/oauth-client-service.ts
// (slice after).

import type { OAuthClientProvider } from '../lib/oauth-client-providers.js';

// ─── repo: account_oauth_links ──────────────────────────────────

export interface OAuthLinkRow {
  id: string;
  accountId: string;
  provider: OAuthClientProvider;
  providerSub: string;
  providerEmail: string | null;
  providerName: string | null;
  providerAvatarUrl: string | null;
  linkedAt: Date;
  lastLoginAt: Date | null;
  lastRevokedAt: Date | null;
}

export interface InsertOAuthLinkInput {
  accountId: string;
  provider: OAuthClientProvider;
  providerSub: string;
  providerEmail: string;
  providerName: string | null;
  providerAvatarUrl: string | null;
}

export interface OAuthLinksRepo {
  /** Find by stable IDP identity. Returns null when no match. */
  findByProviderSub(
    provider: OAuthClientProvider,
    providerSub: string,
  ): Promise<OAuthLinkRow | null>;

  /** List all links for a given account — drives the "your linked
   *  accounts" profile UI. */
  listForAccount(accountId: string): Promise<readonly OAuthLinkRow[]>;

  /** Insert a fresh link. Throws if (provider, providerSub) already
   *  exists — caller should detect via findByProviderSub first. */
  insertLink(input: InsertOAuthLinkInput): Promise<OAuthLinkRow>;

  /** Stamp last_login_at = now on a successful sign-in. Idempotent. */
  markLoginAt(id: string, at: Date): Promise<void>;

  /** Verdict 2 — stamp last_revoked_at when the token-exchange returns
   *  an IDP-revoke error. Subsequent login attempts fall back to
   *  password per the founder verdict. */
  markRevokedAt(id: string, at: Date): Promise<void>;
}

// ─── repo: oauth_pending_links ──────────────────────────────────

export interface OAuthPendingLinkRow {
  id: string;
  accountId: string;
  provider: OAuthClientProvider;
  providerSub: string;
  providerEmail: string;
  providerName: string | null;
  providerAvatarUrl: string | null;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface InsertPendingLinkInput {
  accountId: string;
  provider: OAuthClientProvider;
  providerSub: string;
  providerEmail: string;
  providerName: string | null;
  providerAvatarUrl: string | null;
  tokenHash: string;
  expiresAt: Date;
}

export interface OAuthPendingLinksRepo {
  insertPending(input: InsertPendingLinkInput): Promise<OAuthPendingLinkRow>;

  /** Find by hash + check it isn't expired or already consumed. The
   *  `now` arg makes the time-check deterministic for tests. */
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<OAuthPendingLinkRow | null>;

  /** Atomically claim the pending row as consumed (single-use). Returns true
   *  when THIS call transitioned it to consumed, false if it was already
   *  consumed (a concurrent confirm won the race). Idempotent — a second call
   *  no-ops and returns false. Callers must only create the link when the claim
   *  wins, so a double-submit can't produce a duplicate-key 500. */
  markConsumedAt(id: string, at: Date): Promise<boolean>;
}

// ─── service surface ────────────────────────────────────────────

export interface LinkOrCreateAccountArgs {
  provider: OAuthClientProvider;
  providerSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** Override `now` for tests. */
  now?: Date;
}

export type LinkOrCreateAccountResult =
  | {
      /** Existing link found — return the resolved account_id. The
       *  route should immediately issue a web session. */
      kind: 'signed-in-existing-link';
      accountId: string;
      linkId: string;
    }
  | {
      /** New account created — IDP identity is the first + only
       *  account for this email. */
      kind: 'created-new-account';
      accountId: string;
      linkId: string;
    }
  | {
      /** Email already has a password account; Verdict 1 collision
       *  flow: a oauth_pending_links token has been issued + emailed
       *  to the account's address. The route renders a "check your
       *  email" page. */
      kind: 'collision-pending-verification';
      pendingLinkId: string;
      expiresAt: Date;
    }
  | {
      /** Existing link was previously marked revoked (Verdict 2). The
       *  route should prompt the user to re-link or sign in via
       *  password. */
      kind: 'existing-link-revoked';
      accountId: string;
      linkId: string;
    };

export interface OAuthClientService {
  linkOrCreateAccount(args: LinkOrCreateAccountArgs): Promise<LinkOrCreateAccountResult>;

  /** Consume a pending-link token (Verdict 1 collision-flow
   *  completion). Returns the resolved account_id + the newly-
   *  inserted link, or `null` if the token is expired / consumed /
   *  not found. */
  confirmPendingLink(
    plaintextToken: string,
    now?: Date,
  ): Promise<{ accountId: string; linkId: string } | null>;
}
