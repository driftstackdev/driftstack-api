// W989 — db/seed dev-bootstrap cross-source invariant. Three-hundred-
// fifteenth in the drift-guard series. Pins the apps/server/src/db/
// seed.ts dev-data bootstrap primitive:
//
//   Header framing — 'Seed dev data: one test account + one
//   read/write API key. Idempotent: re-running does not duplicate.
//   Safe to run on a fresh DB. The seed prints the plaintext API key
//   on first creation so a developer can paste it into a curl
//   command. On re-run, the key is already hashed in the DB and
//   cannot be recovered — re-running prints the prefix only'.
//
//   2 SEED_* constants — SEED_EMAIL 'dev@driftstack.local' +
//     SEED_KEY_NAME 'dev-default'.
//
//   Account seed shape — email + name 'Local Dev' + tier
//     'api_builder' + status 'active'.
//
//   API key seed — generateApiKey('live') + scopes
//     ['read','write','admin'].
//
//   Plaintext-once-only framing — 'seed api key created — copy this
//     NOW; not recoverable later'.
//
//   Re-run printout — 'seed api key exists (plaintext
//     unrecoverable)' + keyPrefix + keyId only.
//
//   Account-already-exists branch logs 'seed account exists' with
//     email + accountId.
//
//   finally block calls close() on success or failure.
//
// stays in lockstep across apps/server/src/db/seed.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W989 db/seed dev-bootstrap cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/db/seed.ts header pins surface — 'Seed dev data: one test account + one read/write API key. Idempotent: re-running does not duplicate. Safe to run on a fresh DB. The seed prints the plaintext API key on first creation so a developer can paste it into a curl command. On re-run, the key is already hashed in the DB and cannot be recovered — re-running prints the prefix only'. The 1-account + 1-key + idempotent + print-once design is the V-079 + V-156 dev-seed contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/Seed dev data: one test account \+ one read\/write API key\./);
    expect(p).toMatch(/Idempotent: re-running does not duplicate\. Safe to run on a fresh DB\./);
    expect(p).toMatch(/The seed prints the plaintext API key on first creation so a developer/);
    expect(p).toMatch(/can paste it into a curl command\. On re-run, the key is already hashed/);
    expect(p).toMatch(/in the DB and cannot be recovered — re-running prints the prefix only\./);
  });

  // ─── 2 SEED_* constants ──────────────────────────────────────

  it("CRITICAL 2 SEED_* constants — SEED_EMAIL 'dev@driftstack.local' + SEED_KEY_NAME 'dev-default'. The .local TLD prevents accidental conflict with a real domain.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/const SEED_EMAIL = 'dev@driftstack\.local';/);
    expect(p).toMatch(/const SEED_KEY_NAME = 'dev-default';/);
  });

  // ─── Account seed shape ──────────────────────────────────────

  it("CRITICAL account seed has 4 fields — email (SEED_EMAIL) + name 'Local Dev' + tier 'api_builder' + status 'active'. The api_builder tier gives the dev key enough quota for full E2E flows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/email: SEED_EMAIL,/);
    expect(p).toMatch(/name: 'Local Dev',/);
    expect(p).toMatch(/tier: 'api_builder',/);
    expect(p).toMatch(/status: 'active',/);
  });

  // ─── API key seed ────────────────────────────────────────────

  it("CRITICAL API key seed — generateApiKey('live') + 3-scope set ['read', 'write', 'admin']. The 3-scope live key lets E2E tests exercise every scope-gated path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/const plaintext = generateApiKey\('live'\);/);
    expect(p).toMatch(/scopes: \['read', 'write', 'admin'\],/);
  });

  // ─── 3 imports from lib/api-keys ─────────────────────────────

  it('CRITICAL imports 3 api-keys helpers — generateApiKey + hashApiKey + keyPrefixFromPlaintext. The 3-helper set is what makes the seed re-use lib primitives instead of inlining the scrypt+base32 dance.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(
      /import \{ generateApiKey, hashApiKey, keyPrefixFromPlaintext \} from '\.\.\/lib\/api-keys\.js';/,
    );
  });

  // ─── Plaintext-once-only framing ─────────────────────────────

  it("CRITICAL plaintext-printed-once message — 'seed api key created — copy this NOW; not recoverable later'. The copy-this-NOW message is the print-once contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/msg: 'seed api key created — copy this NOW; not recoverable later',/);
    expect(p).toMatch(/plaintext,/);
  });

  // ─── Re-run printout ─────────────────────────────────────────

  it("CRITICAL re-run printout — 'seed api key exists (plaintext unrecoverable)' + keyPrefix + keyId only. The prefix-only printout matches the V-079 plaintext-not-recoverable contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/msg: 'seed api key exists \(plaintext unrecoverable\)',/);
    expect(p).toMatch(/keyPrefix: existingKey\.keyPrefix,/);
    expect(p).toMatch(/keyId: existingKey\.id,/);
  });

  // ─── Account-already-exists branch ───────────────────────────

  it("CRITICAL account-already-exists logs 'seed account exists' with email + accountId. The pre-existing-account log lets devs reason about idempotency.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/msg: 'seed account exists', email: SEED_EMAIL, accountId/);
  });

  // ─── finally block calls close() ─────────────────────────────

  it("CRITICAL finally block calls close() — 'try { ... } finally { await close(); }'. The finally-close ensures the postgres pool drains on both success + failure paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/seed.ts'));
    expect(p).toMatch(/\} finally \{/);
    expect(p).toMatch(/await close\(\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/db-seed-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
