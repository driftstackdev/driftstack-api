// W449.A — drift guard for apps/server/src/db/seed.ts.
// Dev-data seed script: one test account + one read/write/admin
// API key. Drift here either drops the idempotency guard (re-running
// duplicates the account + key) or breaks the plaintext-only-on-
// first-creation rationale (developer loses the only chance to copy
// the plaintext for curl — hashes are irreversible).
//
//   • header framing pinned: idempotent + safe-on-fresh-DB +
//     plaintext-printed-once rationale.
//   • SEED_EMAIL = 'dev@driftstack.local'; SEED_KEY_NAME = 'dev-default'.
//   • account lookup: select by email + limit 1 → reuse if exists.
//   • account create branch: 4-field values (email + name + tier:
//     'api_builder' + status: 'active'); throws on no-row.
//   • api key lookup: select by accountId + limit 1 → 'exists,
//     plaintext unrecoverable' branch returns early.
//   • api key create: scopes ['read','write','admin'];
//     plaintext printed once with copy-NOW warning.
//   • main().catch: top-level rejection → console.error + exit(1).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/seed.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W449.A apps/server/src/db/seed.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Seed dev data: one test account + one read/write API key.' + idempotency + plaintext-once-rationale", () => {
    expect(body).toMatch(
      /\/\/ Seed dev data: one test account \+ one read\/write API key\.\s*\/\/ Idempotent: re-running does not duplicate\. Safe to run on a fresh DB\./,
    );
    expect(body).toMatch(
      /\/\/ The seed prints the plaintext API key on first creation so a developer\s*\/\/ can paste it into a curl command\. On re-run, the key is already hashed\s*\/\/ in the DB and cannot be recovered — re-running prints the prefix only\./,
    );
  });

  it("constants: SEED_EMAIL = 'dev@driftstack.local'; SEED_KEY_NAME = 'dev-default'", () => {
    expect(body).toMatch(/const SEED_EMAIL = 'dev@driftstack\.local';/);
    expect(body).toMatch(/const SEED_KEY_NAME = 'dev-default';/);
  });

  it('imports: eq from drizzle-orm; createDb from client; accounts+apiKeys schema; generateApiKey/hashApiKey/keyPrefixFromPlaintext from lib/api-keys; loadConfig from lib/config', () => {
    expect(body).toMatch(/import \{ eq \} from 'drizzle-orm';/);
    expect(body).toMatch(/import \{ createDb \} from '\.\/client\.js';/);
    expect(body).toMatch(/import \{ accounts, apiKeys \} from '\.\/schema\.js';/);
    expect(body).toMatch(
      /import \{ generateApiKey, hashApiKey, keyPrefixFromPlaintext \} from '\.\.\/lib\/api-keys\.js';/,
    );
    expect(body).toMatch(/import \{ loadConfig \} from '\.\.\/lib\/config\.js';/);
  });

  it("account lookup branch: select where email=SEED_EMAIL + limit 1; reuses existingAccount.id; logs 'seed account exists' on reuse", () => {
    expect(body).toMatch(
      /const \[existingAccount\] = await db\s*\.select\(\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.email, SEED_EMAIL\)\)\s*\.limit\(1\);/,
    );
    expect(body).toMatch(/msg: 'seed account exists', email: SEED_EMAIL, accountId/);
  });

  it("account create branch: 4-field values (email + name 'Local Dev' + tier 'api_builder' + status 'active'); throws 'failed to create seed account' on no-row; logs 'seed account created'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*email: SEED_EMAIL,\s*name: 'Local Dev',\s*tier: 'api_builder',\s*status: 'active',\s*\}\)\s*\.returning\(\{ id: accounts\.id \}\);/,
    );
    expect(body).toMatch(/if \(!created\) throw new Error\('failed to create seed account'\);/);
    expect(body).toMatch(/msg: 'seed account created', email: SEED_EMAIL, accountId/);
  });

  it("api key lookup: select by accountId + limit 1; existingKey branch logs 'seed api key exists (plaintext unrecoverable)' + early return", () => {
    expect(body).toMatch(
      /const \[existingKey\] = await db\s*\.select\(\)\s*\.from\(apiKeys\)\s*\.where\(eq\(apiKeys\.accountId, accountId\)\)\s*\.limit\(1\);/,
    );
    expect(body).toMatch(
      /msg: 'seed api key exists \(plaintext unrecoverable\)',\s*keyPrefix: existingKey\.keyPrefix,\s*keyId: existingKey\.id,/,
    );
  });

  it("api key create: generateApiKey('live') + hashApiKey + keyPrefixFromPlaintext; insert with scopes ['read','write','admin']; plaintext printed once with 'copy this NOW; not recoverable later' warning", () => {
    expect(body).toMatch(/const plaintext = generateApiKey\('live'\);/);
    expect(body).toMatch(/const keyHash = await hashApiKey\(plaintext\);/);
    expect(body).toMatch(/const keyPrefix = keyPrefixFromPlaintext\(plaintext\);/);
    expect(body).toMatch(
      /\.values\(\{\s*accountId,\s*name: SEED_KEY_NAME,\s*keyPrefix,\s*keyHash,\s*scopes: \['read', 'write', 'admin'\],\s*\}\)\s*\.returning\(\{ id: apiKeys\.id \}\);/,
    );
    expect(body).toMatch(/if \(!inserted\) throw new Error\('failed to create seed api key'\);/);
    expect(body).toMatch(
      /msg: 'seed api key created — copy this NOW; not recoverable later',\s*keyId: inserted\.id,\s*plaintext,/,
    );
  });

  it('main() top-level catch: console.error(err) + process.exit(1) on rejection', () => {
    expect(body).toMatch(
      /main\(\)\.catch\(\(err: unknown\) => \{\s*console\.error\(err\);\s*process\.exit\(1\);\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
