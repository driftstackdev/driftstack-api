// Drift guard for apps/server/src/lib/gui-control-key-encryption.ts.
// Pins the Arc 2 sub-slice 8.4 auto-minted gui_control_key encryption
// — versioned, context-bound AES-256-GCM envelope + gck_-prefixed
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

  it('Arc 2 sub-slice 8.4 module framing pins the versioned envelope, canonical AAD purpose/account/session binding, and the 24h MFA-key pattern', () => {
    expect(body).toMatch(/\/\/ Arc 2 sub-slice 8\.4 \(v2-#8 AI chat \+ manual side-by-side\)\./);
    expect(body).toMatch(
      /\/\/ Encryption for the auto-minted gui_control_key\. AES-256-GCM uses a\s*\/\/ versioned `\[magic \| IV \| tag \| ciphertext\]` envelope and canonical\s*\/\/ additional authenticated data \(AAD\) that binds the ciphertext to its\s*\/\/ purpose, owning account, and one agent-session\. Re-uses\s*\/\/ MFA_ENCRYPTION_KEY per Q2=C \(24h-TTL, MFA-key pattern\)\./,
    );
  });

  it("gck_-prefix + log-recognition framing pinned: 'The plaintext format is gck_<32 base32 chars> — a 20-byte random body prefixed with gck_ so logs / Sentry breadcrumbs can recognise it without leaking. The customer's gui-client uses this as a bearer token for the manual-control plane (sub-slice 8.4 route surfaces it). NOT an API key; scoped to a single agent-session and its 24h TTL.' — pinned so the gck_-recognition + bearer-not-API-key + scoped-to-single-agent-session + 24h-TTL contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ The plaintext format is `gck_<32 base32 chars>` — a 20-byte\s*\/\/ random body prefixed with `gck_` so logs \/ Sentry breadcrumbs can\s*\/\/ recognise it without leaking\. The customer's gui-client uses this\s*\/\/ as a bearer token for the manual-control plane \(sub-slice 8\.4\s*\/\/ route surfaces it\)\. NOT an API key; scoped to a single\s*\/\/ agent-session and its 24h TTL\./,
    );
  });

  it('cryptographic sizes, bounded context, v2 magic, unique purpose and base32 alphabet are pinned', () => {
    // The AES-GCM parameters are IMPORTED, not redeclared. Ten encryption
    // modules each held their own copy with their own pin like this one, so
    // every copy was covered and nothing required the ten to agree.
    expect(body).toContain("from './aes-gcm-parameters.js'");
    expect(body).not.toMatch(/const (?:AES_256_KEY_BYTES|GCM_IV_BYTES|GCM_TAG_BYTES) = /);
    expect(body).toMatch(/const PLAINTEXT_BODY_BYTES = 20;/);
    expect(body).toMatch(/const MAX_CONTEXT_FIELD_BYTES = 256;/);
    expect(body).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
    expect(body).toMatch(/const GUI_CONTROL_KEY_V2_MAGIC = Buffer\.from\('DSGCK2', 'ascii'\);/);
    expect(body).toMatch(/const GUI_CONTROL_KEY_AAD_PURPOSE = 'driftstack:gui-control-key:v2';/);
  });

  it("GuiControlKeyPlaintext brand-type framing pinned: 'string & { readonly __brand: gui-control-key-plaintext }'. + 'Compile-time taint marker so the gui-control-key plaintext can't be assigned to a raw string without an explicit cast — matches the BYOK taint pattern.' — pinned so the brand-pattern + BYOK-taint-pattern-cross-reference + cast-required-for-leak contract all stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Compile-time taint marker so the gui-control-key plaintext can't\s*\*\s+be assigned to a raw `string` without an explicit cast — matches\s*\*\s+the BYOK taint pattern\. \*\/\s*export type GuiControlKeyPlaintext = string & \{\s*readonly __brand: 'gui-control-key-plaintext';\s*\};/,
    );
  });

  it("base32Encode 5-bit-at-a-time loop pinned: 'value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]; bits -= 5; }'. + tail-byte handling for bits > 0 leftover. Drift to a different bit-grouping would mint keys with non-standard base32 encoding", () => {
    expect(body).toMatch(
      /function base32Encode\(buf: Buffer\): string \{\s*let bits = 0;\s*let value = 0;\s*let out = '';\s*for \(const byte of buf\) \{\s*value = \(value << 8\) \| byte;\s*bits \+= 8;\s*while \(bits >= 5\) \{\s*out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];\s*bits -= 5;/,
    );
    expect(body).toMatch(
      /if \(bits > 0\) \{\s*out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\];\s*\}/,
    );
  });

  it("generateGuiControlKey 'gck_<32 base32 chars>' format pinned: gck_ prefix + base32Encode(randomBytes(PLAINTEXT_BODY_BYTES)) where 20 bytes × 8 / 5 = 32 base32 chars. Drift to a shorter body would shrink the per-key entropy below 100-bit threshold; drift to a different prefix would break log-recognition framing", () => {
    expect(body).toMatch(
      /export function generateGuiControlKey\(\): GuiControlKeyPlaintext \{\s*return `gck_\$\{base32Encode\(randomBytes\(PLAINTEXT_BODY_BYTES\)\)\}` as GuiControlKeyPlaintext;\s*\}/,
    );
  });

  it('encrypt/decrypt require immutable context, authenticate canonical purpose/account/session AAD, and reject non-v2 envelopes', () => {
    expect(body).toMatch(
      /export function encryptGuiControlKey\(\s*plaintext: string,\s*keyBase64: string,\s*context: GuiControlKeyEncryptionContext,\s*\): Buffer \{/,
    );
    expect(body).toMatch(/cipher\.setAAD\(buildAdditionalAuthenticatedData\(context\)\);/);
    expect(body).toMatch(
      /return Buffer\.concat\(\[GUI_CONTROL_KEY_V2_MAGIC, iv, tag, ciphertext\]\);/,
    );
    expect(body).toMatch(/GUI_CONTROL_KEY_AAD_PURPOSE, accountId, sessionId/);
    expect(body).toMatch(/ciphertext version is unsupported/);
    expect(body).toMatch(/decipher\.setAAD\(buildAdditionalAuthenticatedData\(context\)\);/);
    expect(body).toMatch(/decipher\.setAuthTag\(tag\);/);
    expect(body).toMatch(/return plaintext as GuiControlKeyPlaintext;/);
  });
});
