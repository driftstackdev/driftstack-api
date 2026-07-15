// In-memory PlatformSecretsRepo for integration fixtures (secrets Phase A,
// migration 0074) — mirrors in-memory-pricing-repo.ts. Ciphertext blobs are
// stored as-is; listMeta never exposes them (same contract as the drizzle
// repo's metadata-only select).

import type {
  PlatformSecretMeta,
  PlatformSecretsRepo,
  PlatformSecretSetOutcome,
} from '../../../src/services/platform-secrets.js';

export class InMemoryPlatformSecretsRepo implements PlatformSecretsRepo {
  private readonly blobs = new Map<string, Buffer>();
  private readonly meta = new Map<string, PlatformSecretMeta>();

  listMeta(): Promise<PlatformSecretMeta[]> {
    return Promise.resolve([...this.meta.values()]);
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
    const existing = this.meta.get(args.name);
    this.blobs.set(args.name, args.ciphertext);
    this.meta.set(args.name, {
      name: args.name,
      description: args.description,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
      updatedByKeyId: args.updatedByKeyId,
    });
    return Promise.resolve(existing === undefined ? 'created' : 'updated');
  }

  remove(name: string): Promise<boolean> {
    this.meta.delete(name);
    return Promise.resolve(this.blobs.delete(name));
  }
}
