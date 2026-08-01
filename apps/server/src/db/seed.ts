// Seed dev data: one test account + one read/write API key.
// Idempotent: re-running does not duplicate. Safe to run on a fresh DB.
//
// The seed prints the plaintext API key on first creation so a developer
// can paste it into a curl command. On re-run, the key is already hashed
// in the DB and cannot be recovered — re-running prints the prefix only.

import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { accounts, apiKeys } from './schema.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../lib/api-keys.js';
import { loadConfig } from '../lib/config.js';
import { assertSeedTargetIsLocal } from './seed-target-guard.js';

const SEED_EMAIL = 'dev@driftstack.local';
const SEED_KEY_NAME = 'dev-default';

async function main(): Promise<void> {
  const config = loadConfig();
  // Before opening a connection: this script mints an API key with
  // ['read', 'write', 'admin'] and prints its plaintext. That is correct for a
  // local dev database and a credential-issuing incident anywhere else.
  assertSeedTargetIsLocal(config.databaseUrl, process.env);
  const { db, close } = createDb(config.databaseUrl);

  try {
    const [existingAccount] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, SEED_EMAIL))
      .limit(1);

    let accountId: string;
    if (existingAccount) {
      accountId = existingAccount.id;
      console.warn(JSON.stringify({ msg: 'seed account exists', email: SEED_EMAIL, accountId }));
    } else {
      const [created] = await db
        .insert(accounts)
        .values({
          email: SEED_EMAIL,
          name: 'Local Dev',
          tier: 'api_builder',
          status: 'active',
        })
        .returning({ id: accounts.id });
      if (!created) throw new Error('failed to create seed account');
      accountId = created.id;
      console.warn(JSON.stringify({ msg: 'seed account created', email: SEED_EMAIL, accountId }));
    }

    const [existingKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .limit(1);

    if (existingKey) {
      console.warn(
        JSON.stringify({
          msg: 'seed api key exists (plaintext unrecoverable)',
          keyPrefix: existingKey.keyPrefix,
          keyId: existingKey.id,
        }),
      );
      return;
    }

    const plaintext = generateApiKey('live');
    const keyHash = await hashApiKey(plaintext);
    const keyPrefix = keyPrefixFromPlaintext(plaintext);

    const [inserted] = await db
      .insert(apiKeys)
      .values({
        accountId,
        name: SEED_KEY_NAME,
        keyPrefix,
        keyHash,
        scopes: ['read', 'write', 'admin'],
      })
      .returning({ id: apiKeys.id });
    if (!inserted) throw new Error('failed to create seed api key');

    console.warn(
      JSON.stringify({
        msg: 'seed api key created — copy this NOW; not recoverable later',
        keyId: inserted.id,
        plaintext,
      }),
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
