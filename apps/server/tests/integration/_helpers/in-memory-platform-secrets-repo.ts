// In-memory PlatformSecretsRepo for integration fixtures (secrets Phase A,
// migration 0074) — mirrors in-memory-pricing-repo.ts. Ciphertext blobs are
// stored as-is; listMeta never exposes them (same contract as the drizzle
// repo's metadata-only select).

import type {
  PlatformSecretMeta,
  PlatformSecretsRepo,
  PlatformSecretSetOutcome,
} from '../../../src/services/platform-secrets.js';
import {
  actingKeyIdFromColumns,
  optionalActingKeyColumns,
} from '../../../src/lib/acting-key-columns.js';

export class InMemoryPlatformSecretsRepo implements PlatformSecretsRepo {
  private readonly blobs = new Map<string, Buffer>();
  private readonly meta = new Map<string, PlatformSecretMeta>();

  listMeta(): Promise<PlatformSecretMeta[]> {
    // V-1211 — mirrors DrizzlePlatformSecretsRepo's `ORDER BY name`. Map insertion order agreed
    // with the real repo only while secrets happened to be written alphabetically.
    return Promise.resolve([...this.meta.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  getCiphertext(name: string): Promise<Buffer | null> {
    return Promise.resolve(this.blobs.get(name) ?? null);
  }

  upsert(args: {
    name: string;
    ciphertext: Buffer;
    description: string | null;
    updatedByKeyId: string | null;
  }): Promise<PlatformSecretSetOutcome> {
    // 0138 — validated exactly as the real columns are (a key's uuid, a web
    // session's `wsk_<uuid>`, or none; anything else throws), and read back as the
    // real repo reads it back.
    const actor = optionalActingKeyColumns(args.updatedByKeyId);
    const existing = this.meta.get(args.name);
    this.blobs.set(args.name, args.ciphertext);
    this.meta.set(args.name, {
      name: args.name,
      description: args.description,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
      updatedByKeyId: actingKeyIdFromColumns(actor.keyId, actor.webSessionId),
    });
    return Promise.resolve(existing === undefined ? 'created' : 'updated');
  }

  remove(name: string): Promise<boolean> {
    this.meta.delete(name);
    return Promise.resolve(this.blobs.delete(name));
  }
}
