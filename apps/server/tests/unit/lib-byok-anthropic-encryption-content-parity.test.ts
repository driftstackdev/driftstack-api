// Drift guard for apps/server/src/lib/byok-anthropic-encryption.ts.
// Pins the AI-CHAT BYOK Anthropic encryption envelope —
// migration 0041 + Tier-3 verdicts LOCKED 2026-05-17 + AES-256-GCM
// envelope shape + brand-type taint marker + MFA_ENCRYPTION_KEY
// re-use (Q1 verdict).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/byok-anthropic-encryption.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/byok-anthropic-encryption content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-CHAT BYOK Anthropic module-level framing pinned: 'per-customer encrypted key (migration 0041, Tier-3 verdicts LOCKED 2026-05-17). The bytea column on accounts.byok_anthropic_api_key_ciphertext stores a single blob [12 bytes IV | 16 bytes auth tag | N bytes ciphertext] so the GCM parameters travel with the ciphertext.' — pinned so the migration 0041 + Tier-3 lock-date + bytea-column-name + 12-IV + 16-tag + N-ciphertext envelope shape all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-CHAT BYOK Anthropic — per-customer encrypted key \(migration 0041,\s*\n?\s*\/\/ Tier-3 verdicts LOCKED 2026-05-17\)\. The bytea column on\s*\n?\s*\/\/ `accounts\.byok_anthropic_api_key_ciphertext` stores a single blob\s*\n?\s*\/\/ `\[12 bytes IV \| 16 bytes auth tag \| N bytes ciphertext\]` so the GCM\s*\n?\s*\/\/ parameters travel with the ciphertext\./,
    );
  });

  it("Q1 MFA_ENCRYPTION_KEY-re-use framing pinned: 'Encryption key: AES-256 via the shared MFA_ENCRYPTION_KEY env var (Q1 verdict — reuse for operational simplicity). The same key is used by mfa-totp.ts; rotating MFA_ENCRYPTION_KEY simultaneously rotates both surfaces' ciphertexts.' — pinned so the AES-256 + Q1-verdict + shared-MFA_ENCRYPTION_KEY + simultaneous-rotation-rotates-both contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Encryption key: AES-256 via the shared MFA_ENCRYPTION_KEY env var\s*\n?\s*\/\/ \(Q1 verdict — reuse for operational simplicity\)\. The same key is\s*\n?\s*\/\/ used by `mfa-totp\.ts`; rotating MFA_ENCRYPTION_KEY simultaneously\s*\n?\s*\/\/ rotates both surfaces' ciphertexts\./,
    );
  });

  it("Branded-plaintext taint-marker framing pinned: 'Plaintext leaves the AgentRuntime exactly once per request — the brand type BYOKAnthropicKeyPlaintext is the compiler-enforced taint marker so log/error/audit paths refuse to receive it without an explicit cast (which a code reviewer would catch).' — pinned so the once-per-request + compiler-enforced-taint + code-reviewer-catches-cast contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Plaintext leaves the AgentRuntime exactly once per request — the\s*\n?\s*\/\/ brand type `BYOKAnthropicKeyPlaintext` is the compiler-enforced\s*\n?\s*\/\/ taint marker so log\/error\/audit paths refuse to receive it without\s*\n?\s*\/\/ an explicit cast \(which a code reviewer would catch\)\./,
    );
  });

  it('3-constant catalog pinned: GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16 + AES_256_KEY_BYTES = 32. Drift to a different IV byte-count would break the GCM standard (NIST SP 800-38D recommends 96-bit / 12-byte IVs); drift to a different tag-byte-count would weaken authentication', () => {
    expect(body).toMatch(/const GCM_IV_BYTES = 12;/);
    expect(body).toMatch(/const GCM_TAG_BYTES = 16;/);
    expect(body).toMatch(/const AES_256_KEY_BYTES = 32;/);
  });

  it("BYOKAnthropicKeyPlaintext brand-type framing pinned: 'string & { readonly __brand: byok-anthropic-plaintext }'. + 'Compiler-enforced taint marker for the decrypted BYOK plaintext. Internal call sites must as an explicit cast to assign to a raw string — meant to make log/error/audit paths visibly unsafe in code review.' — pinned so the brand-pattern + visibly-unsafe-cast review-signal contract stay documented (drift to dropping the brand would let raw plaintext flow into logs without TypeScript catching it)", () => {
    expect(body).toMatch(
      /\/\*\* Compiler-enforced taint marker for the decrypted BYOK plaintext\.\s*\n?\s*\*\s+Internal call sites must `as` an explicit cast to assign to a raw\s*\n?\s*\*\s+`string` — meant to make log\/error\/audit paths visibly unsafe in\s*\n?\s*\*\s+code review\. \*\/\s*\n?\s*export type BYOKAnthropicKeyPlaintext = string & \{\s*\n?\s*readonly __brand: 'byok-anthropic-plaintext';\s*\n?\s*\};/,
    );
  });

  it("decodeKey helper pinned: throws if MFA_ENCRYPTION_KEY decodes to != 32 bytes + operator-facing generation hint 'node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"'. Drift to silently padding would let mis-sized keys generate ciphertext that won't survive a key-rotation; drift to dropping the generation hint would leave operators guessing how to mint a valid key", () => {
    expect(body).toMatch(
      /function decodeKey\(keyBase64: string\): Buffer \{\s*\n?\s*const key = Buffer\.from\(keyBase64, 'base64'\);\s*\n?\s*if \(key\.length !== AES_256_KEY_BYTES\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`MFA_ENCRYPTION_KEY must decode to \$\{AES_256_KEY_BYTES\} bytes; got \$\{key\.length\}\. ` \+\s*\n?\s*"Generate with: node -e \\"console\.log\(require\('crypto'\)\.randomBytes\(32\)\.toString\('base64'\)\)\\""/,
    );
  });

  it("encryptByokAnthropicKey envelope-emission pinned: 'AES-256-GCM encrypt the customer's Anthropic API key. Returns the canonical [IV | tag | ciphertext] blob that the bytea column stores directly.' + empty-key throws + Buffer.concat([iv, tag, ciphertext]) order. Drift to a different field order would break the decrypt path on existing data; drift to encrypting empty would let database rows with empty ciphertext look meaningful", () => {
    expect(body).toMatch(
      /\/\*\* AES-256-GCM encrypt the customer's Anthropic API key\. Returns the\s*\n?\s*\*\s+canonical `\[IV \| tag \| ciphertext\]` blob that the `bytea` column\s*\n?\s*\*\s+stores directly\. \*\//,
    );
    expect(body).toMatch(
      /if \(plaintext\.length === 0\) \{\s*\n?\s*throw new Error\('BYOK plaintext key is empty; refusing to encrypt'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const cipher = createCipheriv\('aes-256-gcm', key, iv\);\s*\n?\s*const ciphertext = Buffer\.concat\(\[cipher\.update\(plaintext, 'utf8'\), cipher\.final\(\)\]\);\s*\n?\s*const tag = cipher\.getAuthTag\(\);\s*\n?\s*return Buffer\.concat\(\[iv, tag, ciphertext\]\);/,
    );
  });

  it('decryptByokAnthropicKey envelope-parse pinned: minimum-length check (>= IV + tag + 1) + extract iv/tag/ciphertext slices + setAuthTag + final() → branded plaintext. + operator-facing too-short error with byte counts. Drift to dropping the length check would crash on malformed rows; drift to a different slice order would diverge from the encrypt-side blob layout', () => {
    expect(body).toMatch(
      /if \(blob\.length < GCM_IV_BYTES \+ GCM_TAG_BYTES \+ 1\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`BYOK ciphertext blob is \$\{blob\.length\} bytes; expected at least ` \+\s*\n?\s*`\$\{GCM_IV_BYTES \+ GCM_TAG_BYTES \+ 1\} \(iv \+ tag \+ >=1 byte ciphertext\)`,/,
    );
    expect(body).toMatch(
      /const iv = blob\.subarray\(0, GCM_IV_BYTES\);\s*\n?\s*const tag = blob\.subarray\(GCM_IV_BYTES, GCM_IV_BYTES \+ GCM_TAG_BYTES\);\s*\n?\s*const ciphertext = blob\.subarray\(GCM_IV_BYTES \+ GCM_TAG_BYTES\);/,
    );
    expect(body).toMatch(
      /decipher\.setAuthTag\(tag\);\s*\n?\s*const plaintext = Buffer\.concat\(\[decipher\.update\(ciphertext\), decipher\.final\(\)\]\)\.toString\('utf8'\);\s*\n?\s*return plaintext as BYOKAnthropicKeyPlaintext;/,
    );
  });

  it("looksLikeAnthropicKey 'sk-ant-…' prefix-validation pinned + 'Anthropic API keys are documented as sk-ant-api03-... (base prefix sk-ant-). Allow some forward compatibility for future apiNN versions — match sk-ant- + at least one char.' framing — pinned so the sk-ant-prefix + forward-compat-for-apiNN-versions + lightweight-prefix-not-real-connection-test contract stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Lightweight prefix sanity-check that the customer provided what\s*\n?\s*\*\s+looks like an Anthropic key\. Used at PUT time before storing —\s*\n?\s*\*\s+not a substitute for a real connection test \(the POST \/test endpoint\s*\n?\s*\*\s+fires a small Anthropic call to verify\)\. \*\//,
    );
    expect(body).toMatch(
      /\/\/ Anthropic API keys are documented as `sk-ant-api03-\.\.\.` \(base prefix\s*\n?\s*\/\/ `sk-ant-`\)\. Allow some forward compatibility for future `apiNN`\s*\n?\s*\/\/ versions — match `sk-ant-` \+ at least one char\./,
    );
    expect(body).toMatch(/return \/\^sk-ant-\[A-Za-z0-9_-\]\{1,\}\$\/\.test\(s\);/);
  });
});
