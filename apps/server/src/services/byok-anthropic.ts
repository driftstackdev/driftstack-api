// AI-CHAT BYOK Anthropic — per-customer key storage service.
// Tier-3 verdicts LOCKED 2026-05-17 (5 questions, see
// docs/internal/byok-anthropic-key-storage-design.md).
//
// Surface:
//   - `setKey`     — encrypt customer's Anthropic key + persist
//   - `clearKey`   — delete the row (NULL ciphertext + timestamps)
//   - `getPlaintext` — decrypt for the AgentRuntime call site ONLY
//   - `getMetadata`  — non-secret read for the dashboard ("Key set on …",
//                      "Last used …"); never returns plaintext
//   - `touchLastUsed` — bump `last_used_at` after a successful Claude call
//
// Account-owner-only authorisation (Q3 verdict). Team members on a
// shared account may USE the resolved key (the AgentRuntime resolves
// from the owner's account) but cannot SET/CLEAR via this service —
// route-layer auth enforces the owner-only gate.
//
// No audit-log fingerprint of the key value (Q2 verdict). Audit
// entries on PUT/DELETE/test record only `account_id` + timestamp
// (the route layer wires those calls separately).

import {
  decryptByokAnthropicKey,
  encryptByokAnthropicKey,
  looksLikeAnthropicKey,
  type BYOKAnthropicKeyPlaintext,
} from '../lib/byok-anthropic-encryption.js';

export interface BYOKAnthropicKeyRow {
  accountId: string;
  /** Base64 representation of the bytea (`[IV | tag | ciphertext]`).
   *  Drizzle returns this as a `Buffer`; the InMemory variant uses
   *  base64 strings for portability. Both paths normalise to `Buffer`
   *  in the service. */
  ciphertext: Buffer | null;
  setAt: Date | null;
  lastUsedAt: Date | null;
}

/** Metadata read for the dashboard — never includes plaintext.
 *  `hasKey === false` means no BYOK key set (runtime falls back to
 *  the per-request header → deployment fallback). */
export interface BYOKAnthropicKeyMetadata {
  hasKey: boolean;
  setAt: Date | null;
  lastUsedAt: Date | null;
}

export interface BYOKAnthropicRepo {
  /** Read the encrypted row; `ciphertext === null` if no key set. */
  findByAccount(accountId: string): Promise<BYOKAnthropicKeyRow | null>;
  /** Upsert: write the ciphertext bytea + bump `set_at`. */
  upsert(args: { accountId: string; ciphertext: Buffer; setAt: Date; now: Date }): Promise<void>;
  /** Clear: set ciphertext + set_at + last_used_at to NULL. */
  clear(args: { accountId: string; now: Date }): Promise<void>;
  /** Touch `last_used_at` after a successful Anthropic call. */
  touchLastUsed(args: { accountId: string; now: Date }): Promise<void>;
}

export interface BYOKAnthropicServiceConfig {
  /** Base64-encoded 32-byte AES-256 key. Shares
   *  `MFA_ENCRYPTION_KEY` per Q1 verdict 2026-05-17 — operational
   *  simplicity over compartmentalisation. */
  encryptionKey: string;
  /**
   * v2-#21 — maximum age (ms) of a stored BYOK key before
   * `getPlaintext` treats it as expired and returns `null`. Lets the
   * agent-sessions resolution chain fall through to either the
   * per-request `x-byok-anthropic-api-key` header (still honoured —
   * a header value bypasses storage entirely) or the deployment
   * fallback / 502 ByokAnthropicRequired posture. Default 90 days
   * matches the 60-day reminder + 90-day rotation target documented
   * by the WebhookRotationReminderService / ByokAnthropicRotationReminderService.
   * Set to `Infinity` to disable expiry (legacy / test paths).
   */
  maxKeyAgeMs?: number;
  /**
   * v2-#32 — optional warn-level callback invoked when the TTL gate
   * fires (a stored BYOK key is past `maxKeyAgeMs` and resolution
   * returns `null`). Lets ops surface the silent-fallthrough event
   * without grepping the agent-sessions route for negative-space.
   * Bootstrap wires this to the production logger; tests can pass a
   * spy. Omitting the callback keeps the gate silent (legacy posture).
   */
  onKeyExpired?: (info: { accountId: string; ageMs: number; maxAgeMs: number }) => void;
}

/** v2-#21 — default BYOK Anthropic key TTL. 90 days matches the
 *  ROTATION_TARGET_DAYS constant in the rotation-reminder services
 *  (v2-#10.5 / v2-#11.5) — past that point the customer has been
 *  nagged for ~30 days and the key is considered stale. */
export const BYOK_ANTHROPIC_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class InvalidKeyFormatError extends Error {
  constructor() {
    super('Provided value does not look like an Anthropic API key (expected `sk-ant-…` prefix).');
    this.name = 'InvalidKeyFormatError';
  }
}

export class BYOKAnthropicService {
  constructor(
    private readonly repo: BYOKAnthropicRepo,
    private readonly config: BYOKAnthropicServiceConfig,
  ) {}

  /** PUT /v1/account/me/byok-anthropic-key — set or rotate.
   *  Validates the prefix shape; rejects empty / wrong-prefix values.
   *  Encrypts + persists; bumps `set_at` to `now`. */
  async setKey(args: {
    accountId: string;
    plaintext: string;
    now: Date;
  }): Promise<{ setAt: Date }> {
    if (!looksLikeAnthropicKey(args.plaintext)) {
      throw new InvalidKeyFormatError();
    }
    const ciphertext = encryptByokAnthropicKey(
      args.plaintext,
      this.config.encryptionKey,
      args.accountId,
    );
    await this.repo.upsert({
      accountId: args.accountId,
      ciphertext,
      setAt: args.now,
      now: args.now,
    });
    return { setAt: args.now };
  }

  /** DELETE /v1/account/me/byok-anthropic-key — clear. */
  async clearKey(args: { accountId: string; now: Date }): Promise<void> {
    await this.repo.clear({ accountId: args.accountId, now: args.now });
  }

  /** Resolution-path read — used by the AgentRuntime call site ONLY.
   *  Returns `null` when no key set OR (v2-#21) when the stored key
   *  is older than `maxKeyAgeMs`. Caller falls back to header /
   *  deployment fallback / 502 ByokAnthropicRequired per the route's
   *  resolution chain. Decrypts + returns the branded plaintext. */
  async getPlaintext(args: {
    accountId: string;
    now?: Date;
  }): Promise<BYOKAnthropicKeyPlaintext | null> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row || row.ciphertext === null) return null;
    // v2-#21 — TTL gate. Stored keys older than `maxKeyAgeMs` are
    // treated as absent at resolution time so the agent-sessions
    // resolution chain falls through to header / fallback / 502.
    // Per-request `x-byok-anthropic-api-key` headers bypass storage
    // entirely so customers can always recover by passing a fresh
    // key on the wire.
    const maxAgeMs = this.config.maxKeyAgeMs ?? BYOK_ANTHROPIC_KEY_TTL_MS;
    if (row.setAt !== null && args.now !== undefined && Number.isFinite(maxAgeMs)) {
      const ageMs = args.now.getTime() - row.setAt.getTime();
      if (ageMs > maxAgeMs) {
        // v2-#32 — surface the silent fall-through so ops can correlate
        // expired-key events with downstream 502 ByokAnthropicRequired
        // responses. Best-effort: callback errors swallowed.
        try {
          this.config.onKeyExpired?.({
            accountId: args.accountId,
            ageMs,
            maxAgeMs,
          });
        } catch {
          /* swallow — observability hook must not break the read path */
        }
        return null;
      }
    }
    return decryptByokAnthropicKey(row.ciphertext, this.config.encryptionKey, row.accountId);
  }

  /** GET /v1/account/me/byok-anthropic-key — metadata for the dashboard
   *  card. Never returns plaintext. */
  async getMetadata(args: { accountId: string }): Promise<BYOKAnthropicKeyMetadata> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row || row.ciphertext === null) {
      return { hasKey: false, setAt: null, lastUsedAt: null };
    }
    return {
      hasKey: true,
      setAt: row.setAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  /** Bump `last_used_at` — wired into the AgentRuntime success path
   *  by the route handler once a Claude call succeeds. Idempotent;
   *  safe to call from concurrent turns. */
  async touchLastUsed(args: { accountId: string; now: Date }): Promise<void> {
    await this.repo.touchLastUsed(args);
  }
}

/** In-memory implementation for tests + dev mode. The real impl
 *  is `DrizzleBYOKAnthropicRepo` in `db/byok-anthropic-repo.ts`. */
export class InMemoryBYOKAnthropicRepo implements BYOKAnthropicRepo {
  private readonly rows = new Map<string, BYOKAnthropicKeyRow>();

  findByAccount(accountId: string): Promise<BYOKAnthropicKeyRow | null> {
    return Promise.resolve(this.rows.get(accountId) ?? null);
  }

  upsert(args: { accountId: string; ciphertext: Buffer; setAt: Date; now: Date }): Promise<void> {
    const existing = this.rows.get(args.accountId);
    this.rows.set(args.accountId, {
      accountId: args.accountId,
      ciphertext: args.ciphertext,
      setAt: args.setAt,
      lastUsedAt: existing?.lastUsedAt ?? null,
    });
    return Promise.resolve();
  }

  clear(args: { accountId: string }): Promise<void> {
    this.rows.set(args.accountId, {
      accountId: args.accountId,
      ciphertext: null,
      setAt: null,
      lastUsedAt: null,
    });
    return Promise.resolve();
  }

  touchLastUsed(args: { accountId: string; now: Date }): Promise<void> {
    const row = this.rows.get(args.accountId);
    if (!row || row.ciphertext === null) return Promise.resolve(); // no-op if no key set
    this.rows.set(args.accountId, { ...row, lastUsedAt: args.now });
    return Promise.resolve();
  }
}
