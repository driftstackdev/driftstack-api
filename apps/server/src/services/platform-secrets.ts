// Platform-secrets service (admin-cockpit secrets Phase A — founder-locked
// decision 3, 2026-06-04: DB-backed key management, name-bound encryption at
// rest, owner-gated + audited).
//
// This is the STORAGE/SERVICE layer behind the live owner-gated routes and
// per-action admin audit. Design points:
//
//   - `name` is a stable slug (e.g. 'stripe_secret_key') — validated here so a
//     typo'd or hostile name can't smuggle path-ish/format-ish junk into audit
//     logs or future env-sync tooling.
//   - Values use a name-bound AES-256-GCM v2 byte envelope under the shared
//     MFA_ENCRYPTION_KEY. No key configured → the service is OFF (set/reveal
//     throw FeatureUnavailable-style errors at the route layer; here they
//     throw plain Errors the route maps).
//   - `list()` NEVER touches ciphertext — metadata only. `reveal()` is the only
//     decrypt path and returns the brand-typed plaintext so call sites that log
//     it are visibly unsafe in review.

import type { PlatformSecretPlaintext } from '../lib/platform-secret-encryption.js';
import {
  decryptPlatformSecretValue,
  encryptPlatformSecretValue,
  isValidPlatformSecretValue,
  PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES,
} from '../lib/platform-secret-value-encryption.js';
import { ValidationError } from '../lib/errors.js';

export interface PlatformSecretMeta {
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedByKeyId: string | null;
}

export interface PlatformSecretsRepo {
  /** Metadata for every stored secret — NEVER selects the ciphertext. */
  listMeta(): Promise<PlatformSecretMeta[]>;
  /** The encrypted blob for one secret, or null when absent. */
  getCiphertext(name: string): Promise<Buffer | null>;
  /** Insert-or-update a secret's blob (+ description / editor key). */
  upsert(args: {
    name: string;
    ciphertext: Buffer;
    description: string | null;
    updatedByKeyId: string | null;
  }): Promise<void>;
  /** Delete a secret. Resolves false when the name didn't exist. */
  remove(name: string): Promise<boolean>;
}

/** Slug contract for secret names: lowercase snake_case, 1–64 chars, no
 *  leading/trailing underscore. Tight on purpose — these names land in audit
 *  rows and (later) env-sync tooling. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/;

/** Values are operational secrets (API keys, tokens, DSNs) — bound the size so
 *  a paste-accident (a whole file) can't balloon the table. */
const MAX_DESCRIPTION_CHARS = 256;

export class PlatformSecretsService {
  /** `encryptionKeyBase64` = the shared MFA_ENCRYPTION_KEY (Q1-verdict reuse,
   *  same as BYOK). Null/empty → the service is disabled (set/reveal throw). */
  constructor(
    private readonly repo: PlatformSecretsRepo,
    private readonly encryptionKeyBase64: string | null,
  ) {}

  get enabled(): boolean {
    return this.encryptionKeyBase64 !== null && this.encryptionKeyBase64 !== '';
  }

  private requireKey(): string {
    if (!this.enabled) {
      throw new Error(
        'platform-secrets encryption key is not configured (MFA_ENCRYPTION_KEY unset)',
      );
    }
    return this.encryptionKeyBase64 as string;
  }

  /** Metadata-only listing (no ciphertext ever leaves the repo for this). */
  async list(): Promise<PlatformSecretMeta[]> {
    return this.repo.listMeta();
  }

  /** Encrypt + store (insert-or-update) one secret. */
  async set(args: {
    name: string;
    value: string;
    description?: string | null;
    updatedByKeyId?: string | null;
  }): Promise<void> {
    const key = this.requireKey();
    if (!NAME_RE.test(args.name)) {
      throw new ValidationError({
        formErrors: [],
        fieldErrors: {
          name: ['must be a lowercase snake_case slug (1-64 chars, [a-z0-9_])'],
        },
      });
    }
    if (!isValidPlatformSecretValue(args.value)) {
      throw new ValidationError({
        formErrors: [],
        fieldErrors: {
          value: [`must be 1-${PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES} exact UTF-8 bytes`],
        },
      });
    }
    const description = args.description ?? null;
    if (description !== null && description.length > MAX_DESCRIPTION_CHARS) {
      throw new ValidationError({
        formErrors: [],
        fieldErrors: { description: [`must be at most ${MAX_DESCRIPTION_CHARS} characters`] },
      });
    }
    await this.repo.upsert({
      name: args.name,
      ciphertext: encryptPlatformSecretValue(args.value, key, args.name),
      description,
      updatedByKeyId: args.updatedByKeyId ?? null,
    });
  }

  /** Decrypt one secret. Null when the name isn't stored. The return type is
   *  brand-tainted — keep its lifetime short and never log it. */
  async reveal(name: string): Promise<PlatformSecretPlaintext | null> {
    const key = this.requireKey();
    const blob = await this.repo.getCiphertext(name);
    if (blob === null) return null;
    return decryptPlatformSecretValue(blob, key, name);
  }

  /** Delete one secret. False when it didn't exist (route maps to 404). */
  async remove(name: string): Promise<boolean> {
    return this.repo.remove(name);
  }
}
