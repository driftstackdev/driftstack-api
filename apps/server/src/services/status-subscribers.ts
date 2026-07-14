// V-295c3 — public status-page email subscriber service.
//
// Three flows:
//   1. subscribe(email) — generates confirm token, stores sha256 hash +
//      24h expiry, returns the plaintext token to the caller (route
//      hands it to email.sendStatusSubscriptionConfirmation).
//   2. confirm(plaintext) — token-hash lookup, validates expiry, sets
//      confirmed_at + generates a fresh unsubscribe token (lifelong).
//   3. unsubscribe(plaintext) — token-hash lookup, sets unsubscribed_at.
//
// listConfirmed() returns rows the incident-notification dispatcher
// uses to fan-out emails when a public incident is created or resolved.
//
// Re-subscribe semantics: if the email already exists, we update only the
// pending confirm token. Existing confirmed/unsubscribed state remains
// authoritative until the mailbox owner uses that token. Otherwise an
// anonymous submitter who knows an active recipient's address could suppress
// its incident notifications before proving mailbox control.

import { generateAuthToken, tokenHash } from '../lib/auth-tokens.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { EmailService } from './email.js';

export interface StatusSubscriberRow {
  id: string;
  /** Null only when V-295c3-tombstone purge has zeroed the email out
   *  (90d post-unsubscribe). The row persists so re-subscription kicks
   *  off a fresh double-opt-in flow. */
  email: string | null;
  confirmTokenHash: string | null;
  confirmExpiresAt: Date | null;
  confirmedAt: Date | null;
  unsubscribeTokenHash: string | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
}

export interface StatusSubscribersRepo {
  upsertPending(input: {
    email: string;
    confirmTokenHash: string;
    confirmExpiresAt: Date;
  }): Promise<StatusSubscriberRow>;
  findByConfirmTokenHash(hash: string): Promise<StatusSubscriberRow | null>;
  findByUnsubscribeTokenHash(hash: string): Promise<StatusSubscriberRow | null>;
  markConfirmed(input: {
    id: string;
    expectedConfirmTokenHash: string;
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow | null>;
  markUnsubscribed(input: {
    id: string;
    /** null is reserved for the authenticated admin force-action path. */
    expectedUnsubscribeTokenHash: string | null;
    unsubscribedAt: Date;
  }): Promise<StatusSubscriberRow | null>;
  /**
   * V-295c3-followup — replaces ONLY `unsubscribe_token_hash` for an
   * already-confirmed row. Used by the fan-out path to issue a fresh
   * per-email unsubscribe token. Does NOT touch confirmed_at.
   */
  rotateUnsubscribeTokenHash(input: { id: string; hash: string }): Promise<void>;
  listConfirmed(): Promise<StatusSubscriberRow[]>;
  /** V-295c3-tombstone — admin endpoint paginated read. */
  listAll(opts: { limit: number; offset: number }): Promise<StatusSubscriberRow[]>;
  /** V-295c3-tombstone — admin endpoint single read by id. */
  getById(id: string): Promise<StatusSubscriberRow | null>;
  /** V-295c3-tombstone — purge candidates (rows where unsubscribed_at < cutoff
   *  AND email IS NOT NULL). Returned for the audit-log entry per row. */
  listPurgeCandidates(cutoff: Date): Promise<StatusSubscriberRow[]>;
  /** V-295c3-tombstone — NULLs the email column for the given ids. */
  purgeEmails(ids: readonly string[]): Promise<number>;
}

export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface StatusSubscribersConfig {
  /** Public origin of the status site, used to build the confirm +
   *  unsubscribe URLs. E.g. `https://status.driftstack.dev`. */
  statusPageBaseUrl: string;
}

export class StatusSubscribersService {
  private readonly baseUrl: string;

  constructor(
    private readonly repo: StatusSubscribersRepo,
    private readonly email: EmailService,
    config: StatusSubscribersConfig,
  ) {
    this.baseUrl = config.statusPageBaseUrl.replace(/\/+$/, '');
  }

  /** Initiate or refresh a double-opt-in subscription + send confirmation email. */
  async subscribe(rawEmail: string, now: Date): Promise<{ accepted: true }> {
    const normalized = rawEmail.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new BadRequestError('Invalid email address.');
    }
    const plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    const expiresAt = new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS);
    await this.repo.upsertPending({
      email: normalized,
      confirmTokenHash: hash,
      confirmExpiresAt: expiresAt,
    });
    const confirmLink = `${this.baseUrl}/subscribe/confirm/?token=${encodeURIComponent(plaintext)}`;
    await this.email.sendStatusSubscriptionConfirmation({
      to: normalized,
      confirmLink,
      expiresAt,
    });
    return { accepted: true };
  }

  /** Validate confirm token + mark confirmed + send welcome email. */
  async confirm(plaintext: string, now: Date): Promise<{ email: string }> {
    const hash = tokenHash(plaintext);
    const row = await this.repo.findByConfirmTokenHash(hash);
    if (!row) {
      throw new NotFoundError('Confirmation link is invalid or has been used.');
    }
    if (row.confirmExpiresAt && row.confirmExpiresAt < now) {
      throw new BadRequestError(
        'Confirmation link has expired. Please subscribe again to receive a fresh link.',
      );
    }
    if (row.email === null) {
      // V-295c3-tombstone — purged rows clear confirmTokenHash, so this
      // branch should be unreachable. Guard for type-narrowing only.
      throw new NotFoundError('Confirmation link is invalid or has been used.');
    }
    const email = row.email;
    const unsubPlaintext = generateAuthToken();
    const unsubHash = tokenHash(unsubPlaintext);
    const confirmed = await this.repo.markConfirmed({
      id: row.id,
      expectedConfirmTokenHash: hash,
      confirmedAt: now,
      unsubscribeTokenHash: unsubHash,
    });
    if (confirmed === null) {
      // A concurrent confirmation or re-subscribe replaced/consumed the
      // credential after our lookup. Only the atomic hash-bound update winner
      // may send a welcome email or publish its unsubscribe token.
      throw new NotFoundError('Confirmation link is invalid or has been used.');
    }
    const unsubscribeLink = `${this.baseUrl}/subscribe/unsubscribe/?token=${encodeURIComponent(unsubPlaintext)}`;
    await this.email.sendStatusSubscriptionWelcome({
      to: email,
      statusPageUrl: this.baseUrl,
      unsubscribeLink,
    });
    return { email };
  }

  /** Validate unsubscribe token + mark unsubscribed. */
  async unsubscribe(plaintext: string, now: Date): Promise<{ email: string }> {
    const hash = tokenHash(plaintext);
    const row = await this.repo.findByUnsubscribeTokenHash(hash);
    if (!row) {
      throw new NotFoundError('Unsubscribe link is invalid.');
    }
    if (row.email === null) {
      // Same purge-row defensive guard as confirm() above.
      throw new NotFoundError('Unsubscribe link is invalid.');
    }
    const unsubscribed = await this.repo.markUnsubscribed({
      id: row.id,
      expectedUnsubscribeTokenHash: hash,
      unsubscribedAt: now,
    });
    if (unsubscribed === null) {
      throw new NotFoundError('Unsubscribe link is invalid.');
    }
    return { email: row.email };
  }

  /** All confirmed + still-subscribed rows. Used by the notification fan-out. */
  async listConfirmed(): Promise<StatusSubscriberRow[]> {
    return this.repo.listConfirmed();
  }

  /**
   * V-295c3-followup — rotate the unsubscribe token for a subscriber +
   * return the fresh plaintext. The fan-out caller embeds this in the
   * unsubscribe URL of one outgoing email; the next notification
   * rotates it again. Old tokens become invalid as soon as a new one
   * is issued — acceptable because one-click unsubscribe is meant to
   * target the most recent email a recipient received.
   */
  async rotateUnsubscribeToken(subscriberId: string): Promise<string> {
    const plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    await this.repo.rotateUnsubscribeTokenHash({ id: subscriberId, hash });
    return plaintext;
  }

  /** V-295c3-tombstone — admin paginated list. */
  async listAll(opts: { limit?: number; offset?: number }): Promise<StatusSubscriberRow[]> {
    return this.repo.listAll({ limit: opts.limit ?? 50, offset: opts.offset ?? 0 });
  }

  /** 2026-05-22 — admin force-subscribe. Bypasses the public double-
   *  opt-in flow (no confirmation email; staff has out-of-band consent
   *  per a ticket / sales handoff). Reuses upsertPending → markConfirmed
   *  so the row enters the same final state a normal flow produces.
   *  The unsubscribe token still gets minted so an admin-added
   *  subscriber can opt out via the standard unsub link. Returns the
   *  confirmed row + the unsubscribe link so the route can audit-log
   *  + the staff member can copy the link to share if asked. */
  async adminForceSubscribe(
    rawEmail: string,
    now: Date,
  ): Promise<{ id: string; email: string; confirmedAt: Date; unsubscribeLink: string }> {
    const normalized = rawEmail.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new BadRequestError('Invalid email address.');
    }
    // upsertPending mints / refreshes the row with a confirm token we
    // immediately consume — admin authority replaces customer-side
    // proof-of-control. The same atomic transition clears the pending
    // credential even when this is an already-active subscriber.
    const confirmPlaintext = generateAuthToken();
    const pending = await this.repo.upsertPending({
      email: normalized,
      confirmTokenHash: tokenHash(confirmPlaintext),
      confirmExpiresAt: new Date(now.getTime() + CONFIRM_TOKEN_TTL_MS),
    });
    if (pending.confirmTokenHash === null) {
      throw new Error('status_subscribers admin force-subscribe lost its pending token');
    }
    const unsubPlaintext = generateAuthToken();
    const confirmed = await this.repo.markConfirmed({
      id: pending.id,
      expectedConfirmTokenHash: pending.confirmTokenHash,
      confirmedAt:
        pending.confirmedAt !== null && pending.unsubscribedAt === null ? pending.confirmedAt : now,
      unsubscribeTokenHash: tokenHash(unsubPlaintext),
    });
    if (confirmed === null) {
      throw new Error('status_subscribers admin force-subscribe lost its atomic claim');
    }
    return {
      id: confirmed.id,
      email: confirmed.email ?? normalized,
      confirmedAt: confirmed.confirmedAt ?? now,
      unsubscribeLink: `${this.baseUrl}/subscribe/unsubscribe/?token=${encodeURIComponent(unsubPlaintext)}`,
    };
  }

  /** V-295c3-tombstone — admin force-unsubscribe (no token; admin
   *  authority). Returns the row before the change so the route can
   *  audit-log the email value. */
  async forceUnsubscribe(subscriberId: string, now: Date): Promise<{ email: string | null }> {
    const row = await this.repo.getById(subscriberId);
    if (!row) {
      throw new NotFoundError(`Subscriber ${subscriberId} not found.`);
    }
    if (row.unsubscribedAt !== null) {
      // Idempotent — already unsubscribed; no-op but return the email
      // so the audit-log entry is still informative.
      return { email: row.email };
    }
    const unsubscribed = await this.repo.markUnsubscribed({
      id: subscriberId,
      expectedUnsubscribeTokenHash: null,
      unsubscribedAt: now,
    });
    if (unsubscribed === null) {
      throw new NotFoundError(`Subscriber ${subscriberId} not found.`);
    }
    return { email: row.email };
  }

  /** V-295c3-tombstone — 90d purge of email column on rows that
   *  unsubscribed >= retentionMs ago. Returns the purged subscribers
   *  (with their pre-purge email) so the caller can audit-log per row.
   *  Snapshots id+email BEFORE the in-place mutation so the return value
   *  is stable even with in-memory repos that mutate live row objects. */
  async processPurge(
    now: Date,
    retentionMs: number = 90 * 24 * 60 * 60 * 1000,
  ): Promise<{ purged: { id: string; email: string | null }[] }> {
    const cutoff = new Date(now.getTime() - retentionMs);
    const candidates = await this.repo.listPurgeCandidates(cutoff);
    if (candidates.length === 0) return { purged: [] };
    const snapshot = candidates.map((r) => ({ id: r.id, email: r.email }));
    await this.repo.purgeEmails(snapshot.map((r) => r.id));
    return { purged: snapshot };
  }
}
