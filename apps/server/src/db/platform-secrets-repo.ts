// Drizzle-backed PlatformSecretsRepo — reads/writes the `platform_secrets`
// table (migration 0074). The list read NEVER selects the ciphertext column —
// metadata only; getCiphertext is the single blob read path (feeding the
// service's reveal()).

import { eq, sql } from 'drizzle-orm';
import type { PlatformSecretMeta, PlatformSecretsRepo } from '../services/platform-secrets.js';
import type { Database } from './client.js';
import { platformSecrets } from './schema.js';

// W197 — only the `db` handle is read; narrow the dependency so e2e fixtures
// stay composable without the full Database envelope.
export class DrizzlePlatformSecretsRepo implements PlatformSecretsRepo {
  constructor(private readonly database: Pick<Database, 'db'>) {}

  async listMeta(): Promise<PlatformSecretMeta[]> {
    const rows = await this.database.db
      .select({
        name: platformSecrets.name,
        description: platformSecrets.description,
        createdAt: platformSecrets.createdAt,
        updatedAt: platformSecrets.updatedAt,
        updatedByKeyId: platformSecrets.updatedByKeyId,
      })
      .from(platformSecrets)
      .orderBy(platformSecrets.name);
    return rows;
  }

  async getCiphertext(name: string): Promise<Buffer | null> {
    const rows = await this.database.db
      .select({ ciphertext: platformSecrets.ciphertext })
      .from(platformSecrets)
      .where(eq(platformSecrets.name, name))
      .limit(1);
    return rows[0]?.ciphertext ?? null;
  }

  // Insert-or-update on the `name` primary key. Stamps `updated_at` on edit
  // (created_at keeps the first-set time) and records which owner key wrote it.
  async upsert(args: {
    name: string;
    ciphertext: Buffer;
    description: string | null;
    updatedByKeyId: string | null;
  }): Promise<void> {
    await this.database.db
      .insert(platformSecrets)
      .values({
        name: args.name,
        ciphertext: args.ciphertext,
        description: args.description,
        updatedByKeyId: args.updatedByKeyId,
      })
      .onConflictDoUpdate({
        target: platformSecrets.name,
        set: {
          ciphertext: args.ciphertext,
          description: args.description,
          updatedAt: sql`now()`,
          updatedByKeyId: args.updatedByKeyId,
        },
      });
  }

  async remove(name: string): Promise<boolean> {
    const deleted = await this.database.db
      .delete(platformSecrets)
      .where(eq(platformSecrets.name, name))
      .returning({ name: platformSecrets.name });
    return deleted.length > 0;
  }
}
