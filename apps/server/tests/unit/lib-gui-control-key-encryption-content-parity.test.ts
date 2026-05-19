// Drift guard for apps/server/src/lib/gui-control-key-encryption.ts.
// Pins the Arc 2 sub-slice 8.4 auto-minted gui_control_key encryption
// — same AES-256-GCM envelope as BYOK Anthropic + gck_-prefixed
// base32 plaintext + 24h-TTL Q2=C verdict + brand-type taint marker.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/gui-control-key-encryption.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/gui-control-key-encryption content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 2 sub-slice 8.4 module-level framing pinned: 'Encryption for the auto-minted gui_control_key. Same AES-256-GCM scheme + canonical [IV | tag | ciphertext] blob as the BYOK Anthropic crypto (lib/byok-anthropic-encryption.ts). Re-uses MFA_ENCRYPTION_KEY per Q2=C (24h-TTL, MFA-key pattern).' — pinned so the 8.4 anchor + cross-lib byok-anthropic-encryption cross-reference + Q2=C verdict + 24h-TTL + MFA-key-pattern contract all stay documented", () => {
    expect(body).toMatch(/\/\/ Arc 2 sub-slice 8\.4 \(v2-#8 AI chat \+ manual side-by-side\)\./);
    expect(body).toMatch(
      /\/\/ Encryption for the auto-minted gui_control_key\. Same AES-256-GCM\s*\n?\s*\/\/ scheme \+ canonical `\[IV \| tag \| ciphertext\]` blob as the BYOK\s*\n?\s*\/\/ Anthropic crypto \(lib\/byok-anthropic-encryption\.ts\)\. Re-uses\s*\n?\s*\/\/ MFA_ENCRYPTION_KEY per Q2=C \(24h-TTL, MFA-key pattern\)\./,
    );
  });

  it("gck_-prefix + log-recognition framing pinned: 'The plaintext format is gck_<32 base32 chars> — a 20-byte random body prefixed with gck_ so logs / Sentry breadcrumbs can recognise it without leaking. The customer's gui-client uses this as a bearer token for the manual-control plane (sub-slice 8.4 route surfaces it). NOT an API key; scoped to a single agent-session and its 24h TTL.' — pinned so the gck_-recognition + bearer-not-API-key + scoped-to-single-agent-session + 24h-TTL contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ The plaintext format is `gck_<32 base32 chars>` — a 20-byte\s*\n?\s*\/\/ random body prefixed with `gck_` so logs \/ Sentry breadcrumbs can\s*\n?\s*\/\/ recognise it without leaking\. The customer's gui-client uses this\s*\n?\s*\/\/ as a bearer token for the manual-control plane \(sub-slice 8\.4\s*\n?\s*\/\/ route surfaces it\)\. NOT an API key; scoped to a single\s*\n?\s*\/\/ agent-session and its 24h TTL\./,
    );
  });

  it("5-constant catalog pinned: GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16 + AES_256_KEY_BYTES = 32 + PLAINTEXT_BODY_BYTES = 20 + BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' (RFC 4648 lowercase). Drift to a different alphabet would mint keys that fail to round-trip through any standard base32 decoder", () => {
    expect(body).toMatch(/const GCM_IV_BYTES = 12;/);
    expect(body).toMatch(/const GCM_TAG_BYTES = 16;/);
    expect(body).toMatch(/const AES_256_KEY_BYTES = 32;/);
    expect(body).toMatch(/const PLAINTEXT_BODY_BYTES = 20;/);
    expect(body).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  it("GuiControlKeyPlaintext brand-type framing pinned: 'string & { readonly __brand: gui-control-key-plaintext }'. + 'Compile-time taint marker so the gui-control-key plaintext can't be assigned to a raw string without an explicit cast — matches the BYOK taint pattern.' — pinned so the brand-pattern + BYOK-taint-pattern-cross-reference + cast-required-for-leak contract all stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Compile-time taint marker so the gui-control-key plaintext can't\s*\n?\s*\*\s+be assigned to a raw `string` without an explicit cast — matches\s*\n?\s*\*\s+the BYOK taint pattern\. \*\/\s*\n?\s*export type GuiControlKeyPlaintext = string & \{\s*\n?\s*readonly __brand: 'gui-control-key-plaintext';\s*\n?\s*\};/,
    );
  });

  it("base32Encode 5-bit-at-a-time loop pinned: 'value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]; bits -= 5; }'. + tail-byte handling for bits > 0 leftover. Drift to a different bit-grouping would mint keys with non-standard base32 encoding", () => {
    expect(body).toMatch(
      /function base32Encode\(buf: Buffer\): string \{\s*\n?\s*let bits = 0;\s*\n?\s*let value = 0;\s*\n?\s*let out = '';\s*\n?\s*for \(const byte of buf\) \{\s*\n?\s*value = \(value << 8\) \| byte;\s*\n?\s*bits \+= 8;\s*\n?\s*while \(bits >= 5\) \{\s*\n?\s*out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];\s*\n?\s*bits -= 5;/,
    );
    expect(body).toMatch(
      /if \(bits > 0\) \{\s*\n?\s*out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\];\s*\n?\s*\}/,
    );
  });

  it("generateGuiControlKey 'gck_<32 base32 chars>' format pinned: gck_ prefix + base32Encode(randomBytes(PLAINTEXT_BODY_BYTES)) where 20 bytes × 8 / 5 = 32 base32 chars. Drift to a shorter body would shrink the per-key entropy below 100-bit threshold; drift to a different prefix would break log-recognition framing", () => {
    expect(body).toMatch(
      /export function generateGuiControlKey\(\): GuiControlKeyPlaintext \{\s*\n?\s*return `gck_\$\{base32Encode\(randomBytes\(PLAINTEXT_BODY_BYTES\)\)\}` as GuiControlKeyPlaintext;\s*\n?\s*\}/,
    );
  });

  it('encryptGuiControlKey + decryptGuiControlKey envelope pinned (same shape as byok-anthropic-encryption): empty-key throws + Buffer.concat([iv, tag, ciphertext]) + setAuthTag on decrypt. Drift would diverge from the canonical envelope shared with BYOK Anthropic encryption', () => {
    expect(body).toMatch(
      /export function encryptGuiControlKey\(plaintext: string, keyBase64: string\): Buffer \{\s*\n?\s*if \(plaintext\.length === 0\) \{\s*\n?\s*throw new Error\('gui_control_key plaintext is empty; refusing to encrypt'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const cipher = createCipheriv\('aes-256-gcm', key, iv\);\s*\n?\s*const ciphertext = Buffer\.concat\(\[cipher\.update\(plaintext, 'utf8'\), cipher\.final\(\)\]\);\s*\n?\s*const tag = cipher\.getAuthTag\(\);\s*\n?\s*return Buffer\.concat\(\[iv, tag, ciphertext\]\);/,
    );
    expect(body).toMatch(
      /export function decryptGuiControlKey\(blob: Buffer, keyBase64: string\): GuiControlKeyPlaintext \{/,
    );
    expect(body).toMatch(/decipher\.setAuthTag\(tag\);/);
    expect(body).toMatch(/return plaintext as GuiControlKeyPlaintext;/);
  });
});
