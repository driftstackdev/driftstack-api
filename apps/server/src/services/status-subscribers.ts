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
// Re-subscribe semantics: if the email already exists, we update the
// existing row with a fresh confirm_token + cleared confirmed_at /
// unsubscribed_at. The double-opt-in is the gate; abandoned signups
// don't ever get put on the notification list.

import { generateAuthToken, tokenHash } from '../lib/auth-tokens.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { EmailService } from './email.js';

export interface StatusSubscriberRow {
  id: string;
  email: string;
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
    confirmedAt: Date;
    unsubscribeTokenHash: string;
  }): Promise<StatusSubscriberRow>;
  markUnsubscribed(input: { id: string; unsubscribedAt: Date }): Promise<StatusSubscriberRow>;
  /**
   * V-295c3-followup — replaces ONLY `unsubscribe_token_hash` for an
   * already-confirmed row. Used by the fan-out path to issue a fresh
   * per-email unsubscribe token. Does NOT touch confirmed_at.
   */
  rotateUnsubscribeTokenHash(input: { id: string; hash: string }): Promise<void>;
  listConfirmed(): Promise<StatusSubscriberRow[]>;
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
    const confirmLink = `${this.baseUrl}/subscribe/confirm?token=${encodeURIComponent(plaintext)}`;
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
    const unsubPlaintext = generateAuthToken();
    const unsubHash = tokenHash(unsubPlaintext);
    await this.repo.markConfirmed({
      id: row.id,
      confirmedAt: now,
      unsubscribeTokenHash: unsubHash,
    });
    const unsubscribeLink = `${this.baseUrl}/subscribe/unsubscribe?token=${encodeURIComponent(unsubPlaintext)}`;
    await this.email.sendStatusSubscriptionWelcome({
      to: row.email,
      statusPageUrl: this.baseUrl,
      unsubscribeLink,
    });
    return { email: row.email };
  }

  /** Validate unsubscribe token + mark unsubscribed. */
  async unsubscribe(plaintext: string, now: Date): Promise<{ email: string }> {
    const hash = tokenHash(plaintext);
    const row = await this.repo.findByUnsubscribeTokenHash(hash);
    if (!row) {
      throw new NotFoundError('Unsubscribe link is invalid.');
    }
    await this.repo.markUnsubscribed({ id: row.id, unsubscribedAt: now });
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
}
