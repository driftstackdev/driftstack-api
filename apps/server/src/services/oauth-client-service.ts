// V-667.C — OAuth-client service implementation. Composes the 2 repos
// (oauth-links + pending-links) + a minimal accounts lookup + a token
// generator to fulfil the founder-verdict-locked flow:
//
//   Verdict 1: existing-email collision → MERGE-WITH-VERIFICATION
//     (60-min single-use token sent to existing account's email)
//   Verdict 2: IDP-revocation marker on next-login-failure
//   Verdict 3: avatar/name sync first-link-only + user-overridable
//     (driven by accounts.avatar_source enum, NOT by re-pull every
//     login)

import { createHash, randomBytes } from 'node:crypto';
import type {
  LinkOrCreateAccountArgs,
  LinkOrCreateAccountResult,
  OAuthClientService,
  OAuthLinksRepo,
  OAuthPendingLinksRepo,
} from './oauth-client.js';

const PENDING_TTL_MS = 60 * 60 * 1000; // V-667.C Verdict 1 — 60 min

export interface AccountsLookup {
  /** Return the account id when an account with this email already
   *  exists (case-insensitive match on email). Null otherwise. */
  findIdByEmail(email: string): Promise<string | null>;
  /** Insert a new account from an IDP signup. Sets avatar_source
   *  to 'idp' when avatarUrl is provided + name from IDP per
   *  Verdict 3. Returns the new account id. */
  createFromIdp(args: {
    email: string;
    name: string | null;
    avatarUrl: string | null;
  }): Promise<string>;
}

export interface OAuthPendingMailer {
  /** Send the Verdict-1 verify-merge email with the plaintext token
   *  in the URL. Fire-and-forget; failures are surfaced via the
   *  passed-in logger but not awaited (matches the rest of the
   *  email-service posture). */
  sendVerifyMergeEmail(args: {
    to: string;
    provider: 'google' | 'github';
    plaintextToken: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface OAuthClientServiceDeps {
  links: OAuthLinksRepo;
  pending: OAuthPendingLinksRepo;
  accounts: AccountsLookup;
  mailer: OAuthPendingMailer;
}

export class OAuthClientServiceImpl implements OAuthClientService {
  constructor(private readonly deps: OAuthClientServiceDeps) {}

  async linkOrCreateAccount(args: LinkOrCreateAccountArgs): Promise<LinkOrCreateAccountResult> {
    const now = args.now ?? new Date();

    // Step 1 — fast path: existing link for this IDP identity?
    const existing = await this.deps.links.findByProviderSub(args.provider, args.providerSub);
    if (existing) {
      // Verdict 2 fork — previously marked revoked. Don't auto-sign-in;
      // the route prompts the user to re-link or fall back to password.
      if (existing.lastRevokedAt !== null) {
        return {
          kind: 'existing-link-revoked',
          accountId: existing.accountId,
          linkId: existing.id,
        };
      }
      await this.deps.links.markLoginAt(existing.id, now);
      return {
        kind: 'signed-in-existing-link',
        accountId: existing.accountId,
        linkId: existing.id,
      };
    }

    // Step 2 — no link. Is there an existing account with this email?
    const collidingAccountId = await this.deps.accounts.findIdByEmail(args.email);
    if (collidingAccountId !== null) {
      // Verdict 1 — collision. Issue a pending-link token, send email.
      const plaintext = generatePlaintextToken();
      const tokenHash = sha256Hex(plaintext);
      const expiresAt = new Date(now.getTime() + PENDING_TTL_MS);
      const pending = await this.deps.pending.insertPending({
        accountId: collidingAccountId,
        provider: args.provider,
        providerSub: args.providerSub,
        providerEmail: args.email,
        providerName: args.name,
        providerAvatarUrl: args.avatarUrl,
        tokenHash,
        expiresAt,
      });
      // Fire-and-forget per email-service posture; route-layer logs
      // any send error via Sentry-pinned warn handler.
      void this.deps.mailer.sendVerifyMergeEmail({
        to: args.email,
        provider: args.provider,
        plaintextToken: plaintext,
        expiresAt,
      });
      return {
        kind: 'collision-pending-verification',
        pendingLinkId: pending.id,
        expiresAt,
      };
    }

    // Step 3 — no link, no colliding account → create new from IDP.
    const newAccountId = await this.deps.accounts.createFromIdp({
      email: args.email,
      name: args.name,
      avatarUrl: args.avatarUrl,
    });
    const link = await this.deps.links.insertLink({
      accountId: newAccountId,
      provider: args.provider,
      providerSub: args.providerSub,
      providerEmail: args.email,
      providerName: args.name,
      providerAvatarUrl: args.avatarUrl,
    });
    await this.deps.links.markLoginAt(link.id, now);
    return {
      kind: 'created-new-account',
      accountId: newAccountId,
      linkId: link.id,
    };
  }

  async confirmPendingLink(
    plaintextToken: string,
    now?: Date,
  ): Promise<{ accountId: string; linkId: string } | null> {
    const tokenHash = sha256Hex(plaintextToken);
    const nowDate = now ?? new Date();
    const pending = await this.deps.pending.findActiveByTokenHash(tokenHash, nowDate);
    if (!pending) return null;

    // Atomic single-use gate: claim the pending row BEFORE creating the link.
    // The findActiveByTokenHash read above is a fast-fail pre-check; this CAS is
    // the authoritative serialization point (mirrors OAuthService's
    // consumeCodeIfUnconsumed). Two concurrent confirm-merges carrying the same
    // token → exactly one claims → exactly one link created; the loser gets a
    // clean null (→ 400 "already used") instead of a duplicate-key 500.
    if (!(await this.deps.pending.markConsumedAt(pending.id, nowDate))) {
      return null;
    }

    // Insert the link onto the existing account_id from the (now-claimed)
    // pending row.
    const link = await this.deps.links.insertLink({
      accountId: pending.accountId,
      provider: pending.provider,
      providerSub: pending.providerSub,
      providerEmail: pending.providerEmail,
      providerName: pending.providerName,
      providerAvatarUrl: pending.providerAvatarUrl,
    });
    await this.deps.links.markLoginAt(link.id, nowDate);
    return { accountId: pending.accountId, linkId: link.id };
  }
}

// ─── helpers ──────────────────────────────────────────────────────

/** 32 random bytes → 64 hex chars. Same shape as the existing
 *  auth-flow plaintext tokens (email_verify, magic_link, password_reset)
 *  so the per-token entropy ceiling stays consistent across the auth
 *  surface. */
function generatePlaintextToken(): string {
  return randomBytes(32).toString('hex');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
