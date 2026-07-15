// Drizzle-backed PlatformSecretsRepo — reads/writes the `platform_secrets`
// table (migration 0074). The list read NEVER selects the ciphertext column —
// metadata only; getCiphertext is the single blob read path (feeding the
// service's reveal()).

import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  convertPlatformSecretValueToV2,
  decryptPlatformSecretValue,
  PLATFORM_SECRET_VALUE_V2_PREFIX,
} from '../lib/platform-secret-value-encryption.js';
import type {
  PlatformSecretMeta,
  PlatformSecretsRepo,
  PlatformSecretSetOutcome,
} from '../services/platform-secrets.js';
import type { Database } from './client.js';
import { platformSecrets } from './schema.js';

const MAX_PLATFORM_SECRET_VALUE_MIGRATION_BATCH = 500;
const PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES = Buffer.from(PLATFORM_SECRET_VALUE_V2_PREFIX, 'utf8');

function platformSecretValueIsV2() {
  return sql`substring(${platformSecrets.ciphertext} from 1 for ${PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES.length}) = ${PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES}`;
}

function platformSecretValueIsLegacy() {
  return sql`NOT (${platformSecretValueIsV2()})`;
}

// W197 — only the `db` handle is read; narrow the dependency so e2e fixtures
// stay composable without the full Database envelope.
export class DrizzlePlatformSecretsRepo implements PlatformSecretsRepo {
  constructor(private readonly database: Pick<Database, 'db'>) {}

  /**
   * Bootstrap-only no-DDL conversion from context-free byte envelopes to
   * name-bound v2. It authenticates a successor probe, prevalidates a complete
   * bounded page, and exact-CASes name + old ciphertext without moving metadata.
   */
  async migrateValueEnvelopes(
    encryptionKeyBase64: string,
    limit = MAX_PLATFORM_SECRET_VALUE_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PLATFORM_SECRET_VALUE_MIGRATION_BATCH
    ) {
      throw new Error(
        `Platform-secret value migration limit must be an integer from 1 to ` +
          `${MAX_PLATFORM_SECRET_VALUE_MIGRATION_BATCH.toString()}.`,
      );
    }

    const [v2Probe] = await this.database.db
      .select({ name: platformSecrets.name, ciphertext: platformSecrets.ciphertext })
      .from(platformSecrets)
      .where(platformSecretValueIsV2())
      .orderBy(asc(platformSecrets.name))
      .limit(1);
    if (v2Probe !== undefined) {
      decryptPlatformSecretValue(v2Probe.ciphertext, encryptionKeyBase64, v2Probe.name);
    }

    const rows = await this.database.db
      .select({ name: platformSecrets.name, ciphertext: platformSecrets.ciphertext })
      .from(platformSecrets)
      .where(platformSecretValueIsLegacy())
      .orderBy(asc(platformSecrets.name))
      .limit(limit);

    const prepared = rows.map((row) => ({
      ...row,
      next: convertPlatformSecretValueToV2(row.ciphertext, encryptionKeyBase64, row.name),
    }));

    let converted = 0;
    for (const row of prepared) {
      const updated = await this.database.db
        .update(platformSecrets)
        .set({ ciphertext: row.next })
        .where(
          and(eq(platformSecrets.name, row.name), eq(platformSecrets.ciphertext, row.ciphertext)),
        )
        .returning({ name: platformSecrets.name });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(platformSecrets)
      .where(platformSecretValueIsLegacy());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

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

  // Serialize one name's existence check + write so callers receive an
  // authoritative create/update outcome. Stamps `updated_at` on edit
  // (created_at keeps the first-set time) and records which owner key wrote it.
  async upsert(args: {
    name: string;
    ciphertext: Buffer;
    description: string | null;
    updatedByKeyId: string | null;
  }): Promise<PlatformSecretSetOutcome> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform-secret-upsert:${args.name}`}, 0))`,
      );
      const [existing] = await tx
        .select({ name: platformSecrets.name })
        .from(platformSecrets)
        .where(eq(platformSecrets.name, args.name))
        .limit(1);

      if (existing === undefined) {
        const inserted = await tx
          .insert(platformSecrets)
          .values({
            name: args.name,
            ciphertext: args.ciphertext,
            description: args.description,
            updatedByKeyId: args.updatedByKeyId,
          })
          .returning({ name: platformSecrets.name });
        if (inserted.length !== 1) {
          throw new Error('Platform-secret insert returned an unexpected row count.');
        }
        return 'created';
      }

      const updated = await tx
        .update(platformSecrets)
        .set({
          ciphertext: args.ciphertext,
          description: args.description,
          updatedAt: sql`now()`,
          updatedByKeyId: args.updatedByKeyId,
        })
        .where(eq(platformSecrets.name, args.name))
        .returning({ name: platformSecrets.name });
      if (updated.length !== 1) {
        throw new Error('Platform-secret update lost its locked row.');
      }
      return 'updated';
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
