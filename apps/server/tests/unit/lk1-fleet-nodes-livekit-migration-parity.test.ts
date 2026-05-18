// LK.1 — migration + schema parity for the per-Mac LiveKit
// credentials columns added to fleet_nodes.
//
// Pins the migration shape (column types, all-or-none CHECK
// constraint, partial-index condition) AND the Drizzle schema's
// matching field declarations. Drift on either side breaks CI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fleetNodes } from '../../src/db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MIGRATION = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0056_fleet_nodes_livekit_credentials.sql',
);
const JOURNAL = resolve(REPO_ROOT, 'apps/server/src/db/migrations/meta/_journal.json');

describe('LK.1 — fleet_nodes per-Mac LiveKit credentials migration', () => {
  it('migration file exists at 0056', () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  const sql = readFileSync(MIGRATION, 'utf8');
  const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it('journal references the new migration tag at idx 56', () => {
    const entry = journal.entries.find((e) => e.idx === 56);
    expect(entry).toBeDefined();
    expect(entry?.tag).toBe('0056_fleet_nodes_livekit_credentials');
  });

  it('ALTERs fleet_nodes (the canonical fleet inventory) — NOT introducing a parallel mac_nodes table', () => {
    expect(sql).toMatch(/ALTER TABLE\s+"fleet_nodes"/);
    expect(sql.includes('CREATE TABLE')).toBe(false);
  });

  it('adds all 4 LiveKit columns: api_key + api_secret_ciphertext + ws_url + registered_at', () => {
    expect(sql).toMatch(/ADD COLUMN "livekit_api_key" text NULL/);
    expect(sql).toMatch(/ADD COLUMN "livekit_api_secret_ciphertext" text NULL/);
    expect(sql).toMatch(/ADD COLUMN "livekit_ws_url" text NULL/);
    expect(sql).toMatch(/ADD COLUMN "livekit_registered_at" timestamptz NULL/);
  });

  it('enforces an all-or-none CHECK constraint on the 4 LiveKit columns', () => {
    expect(sql).toMatch(/CONSTRAINT "fleet_nodes_livekit_all_or_none"/);
    // Both branches present: ALL NULL OR ALL NOT NULL.
    expect(sql).toMatch(/livekit_api_key" IS NULL[\s\S]+livekit_api_secret_ciphertext" IS NULL/);
    expect(sql).toMatch(
      /livekit_api_key" IS NOT NULL[\s\S]+livekit_api_secret_ciphertext" IS NOT NULL/,
    );
  });

  it('adds a partial index on (region) WHERE revoked_at IS NULL AND livekit_api_key IS NOT NULL', () => {
    expect(sql).toMatch(/CREATE INDEX "fleet_nodes_livekit_registered_idx"/);
    expect(sql).toMatch(/WHERE "revoked_at" IS NULL AND "livekit_api_key" IS NOT NULL/);
  });

  it('migration explains the AES-256-GCM secret-handling envelope', () => {
    expect(sql).toMatch(/AES-256-GCM/);
    expect(sql).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(sql).toMatch(/Plaintext is never[\s\S]*?persisted/i);
  });
});

describe('LK.1 — Drizzle schema mirror', () => {
  it('fleetNodes schema declares the 4 new LiveKit fields', () => {
    // Drizzle exposes column names + types on the table object. The
    // simplest cross-check is name-based: each LiveKit field must
    // be present in the resolved table-schema object.
    const fieldNames = Object.keys(fleetNodes);
    expect(fieldNames).toContain('livekitApiKey');
    expect(fieldNames).toContain('livekitApiSecretCiphertext');
    expect(fieldNames).toContain('livekitWsUrl');
    expect(fieldNames).toContain('livekitRegisteredAt');
  });

  it('schema file pins the AES-256-GCM envelope comment alongside the secret column', () => {
    const schemaPath = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
    const body = readFileSync(schemaPath, 'utf8');
    expect(body).toMatch(/AES-256-GCM ciphertext[\s\S]{0,200}MFA_ENCRYPTION_KEY/);
  });

  it('schema file declares the matching partial index', () => {
    const schemaPath = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
    const body = readFileSync(schemaPath, 'utf8');
    expect(body).toMatch(/fleet_nodes_livekit_registered_idx/);
    // Drizzle's `.where()` form on the index.
    expect(body).toMatch(/livekitApiKey} IS NOT NULL/);
  });
});
