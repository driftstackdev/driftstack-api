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

  it('module framing pins explicit v2 bytes, account AAD, and bootstrap-only legacy input', () => {
    expect(body).toMatch(
      /New values in\s*\/\/ `accounts\.byok_anthropic_api_key_ciphertext` use an explicit v2 byte prefix\s*\/\/ followed by `\[12 bytes IV \| 16 bytes auth tag \| N bytes ciphertext\]`\./,
    );
    expect(body).toMatch(
      /AES-GCM AAD binds a dedicated purpose\/version and the owning account UUID/,
    );
    expect(body).toMatch(
      /The\s*\/\/ prefixless v1 form is accepted only by the bounded bootstrap converter\./,
    );
  });

  it("Q1 MFA_ENCRYPTION_KEY-re-use framing pinned: 'Encryption key: AES-256 via the shared MFA_ENCRYPTION_KEY env var (Q1 verdict — reuse for operational simplicity). The same key is used by mfa-totp.ts; rotating MFA_ENCRYPTION_KEY simultaneously rotates both surfaces' ciphertexts.' — pinned so the AES-256 + Q1-verdict + shared-MFA_ENCRYPTION_KEY + simultaneous-rotation-rotates-both contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Encryption key: AES-256 via the shared MFA_ENCRYPTION_KEY env var\s*\/\/ \(Q1 verdict — reuse for operational simplicity\)\. The same key is\s*\/\/ used by `mfa-totp\.ts`; rotating MFA_ENCRYPTION_KEY simultaneously\s*\/\/ rotates both surfaces' ciphertexts\./,
    );
  });

  it("Branded-plaintext taint-marker framing pinned: 'Plaintext leaves the AgentRuntime exactly once per request — the brand type BYOKAnthropicKeyPlaintext is the compiler-enforced taint marker so log/error/audit paths refuse to receive it without an explicit cast (which a code reviewer would catch).' — pinned so the once-per-request + compiler-enforced-taint + code-reviewer-catches-cast contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Plaintext leaves the AgentRuntime exactly once per request — the\s*\/\/ brand type `BYOKAnthropicKeyPlaintext` is the compiler-enforced\s*\/\/ taint marker so log\/error\/audit paths refuse to receive it without\s*\/\/ an explicit cast \(which a code reviewer would catch\)\./,
    );
  });

  it('3-constant catalog pinned: GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16 + AES_256_KEY_BYTES = 32. Drift to a different IV byte-count would break the GCM standard (NIST SP 800-38D recommends 96-bit / 12-byte IVs); drift to a different tag-byte-count would weaken authentication', () => {
    // The AES-GCM parameters are IMPORTED, not redeclared. Ten encryption
    // modules each held their own copy with their own pin like this one, so
    // every copy was covered and nothing required the ten to agree.
    expect(body).toContain("from './aes-gcm-parameters.js'");
    expect(body).not.toMatch(/const (?:AES_256_KEY_BYTES|GCM_IV_BYTES|GCM_TAG_BYTES) = /);
  });

  it("BYOKAnthropicKeyPlaintext brand-type framing pinned: 'string & { readonly __brand: byok-anthropic-plaintext }'. + 'Compiler-enforced taint marker for the decrypted BYOK plaintext. Internal call sites must as an explicit cast to assign to a raw string — meant to make log/error/audit paths visibly unsafe in code review.' — pinned so the brand-pattern + visibly-unsafe-cast review-signal contract stay documented (drift to dropping the brand would let raw plaintext flow into logs without TypeScript catching it)", () => {
    expect(body).toMatch(
      /\/\*\* Compiler-enforced taint marker for the decrypted BYOK plaintext\.\s*\*\s+Internal call sites must `as` an explicit cast to assign to a raw\s*\*\s+`string` — meant to make log\/error\/audit paths visibly unsafe in\s*\*\s+code review\. \*\/\s*export type BYOKAnthropicKeyPlaintext = string & \{\s*readonly __brand: 'byok-anthropic-plaintext';\s*\};/,
    );
  });

  it("decodeKey helper pinned: throws if MFA_ENCRYPTION_KEY decodes to != 32 bytes + operator-facing generation hint 'node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"'. Drift to silently padding would let mis-sized keys generate ciphertext that won't survive a key-rotation; drift to dropping the generation hint would leave operators guessing how to mint a valid key", () => {
    expect(body).toMatch(
      /function decodeKey\(keyBase64: string\): Buffer \{\s*const key = Buffer\.from\(keyBase64, 'base64'\);\s*if \(key\.length !== AES_256_KEY_BYTES\) \{\s*throw new Error\(\s*`MFA_ENCRYPTION_KEY must decode to \$\{AES_256_KEY_BYTES\} bytes; got \$\{key\.length\}\. ` \+\s*"Generate with: node -e \\"console\.log\(require\('crypto'\)\.randomBytes\(32\)\.toString\('base64'\)\)\\""/,
    );
  });

  it('v2 encrypt pins purpose/account AAD and prefix|iv|tag|ciphertext order', () => {
    expect(body).toMatch(
      /const BYOK_ANTHROPIC_KEY_AAD_PURPOSE = 'driftstack\.byok-anthropic-key';/,
    );
    expect(body).toMatch(
      /export const BYOK_ANTHROPIC_KEY_V2_PREFIX = 'driftstack:byok-anthropic-key:v2:';/,
    );
    expect(body).toMatch(
      /JSON\.stringify\(\[BYOK_ANTHROPIC_KEY_AAD_PURPOSE, 2, normalizeAccountId\(accountId\)\]\)/,
    );
    expect(body).toMatch(
      /cipher\.setAAD\(buildAdditionalAuthenticatedData\(accountId\)\);[\s\S]*?return Buffer\.concat\(\[BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES, iv, tag, ciphertext\]\);/,
    );
  });

  it('ordinary read is v2-only, payload allocation is bounded, and legacy read is bootstrap-only', () => {
    expect(body).toMatch(
      /if \(!isByokAnthropicKeyV2Envelope\(blob\)\) \{\s*throw new Error\('BYOK Anthropic key storage is not a v2 envelope\.'\);/,
    );
    expect(body).toMatch(
      /blob\.length < BYOK_ANTHROPIC_KEY_MIN_PAYLOAD_BYTES \|\|\s*blob\.length > BYOK_ANTHROPIC_KEY_MAX_PAYLOAD_BYTES/,
    );
    expect(body).toMatch(
      /if \(!Buffer\.from\(plaintext, 'utf8'\)\.equals\(plaintextBytes\)\) \{\s*throw new Error\('BYOK plaintext key is not valid UTF-8\.'\);/,
    );
    expect(body).toMatch(
      /export function decryptLegacyByokAnthropicKey[\s\S]*?legacy reader refuses a v2 envelope/,
    );
  });

  it("looksLikeAnthropicKey 'sk-ant-…' prefix-validation pinned + 'Anthropic API keys are documented as sk-ant-api03-... (base prefix sk-ant-). Allow some forward compatibility for future apiNN versions — match sk-ant- + at least one char.' framing — pinned so the sk-ant-prefix + forward-compat-for-apiNN-versions + lightweight-prefix-not-real-connection-test contract stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Lightweight prefix sanity-check that the customer provided what\s*\*\s+looks like an Anthropic key\. Used at PUT time before storing —\s*\*\s+not a substitute for a real connection test \(the POST \/test endpoint\s*\*\s+fires a small Anthropic call to verify\)\. \*\//,
    );
    expect(body).toMatch(
      /\/\/ Anthropic API keys are documented as `sk-ant-api03-\.\.\.` \(base prefix\s*\/\/ `sk-ant-`\)\. Allow some forward compatibility for future `apiNN`\s*\/\/ versions — match `sk-ant-` \+ 1 to 512 chars\./,
    );
    expect(body).toMatch(/return \/\^sk-ant-\[A-Za-z0-9_-\]\{1,512\}\$\/\.test\(s\);/);
  });
});
