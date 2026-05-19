// Drift guard for apps/server/src/lib/livekit-secret-encryption.ts.
// Pins the LK.2 per-Mac LiveKit API secret encryption — same
// AES-256-GCM envelope as BYOK Anthropic + gui_control_key + MFA
// TOTP under shared MFA_ENCRYPTION_KEY, base64-TEXT-column storage.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-secret-encryption.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/livekit-secret-encryption content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.2 module-level framing pinned: 'AES-256-GCM envelope for per-Mac LiveKit API secrets. Same envelope as BYOK Anthropic + gui_control_key + MFA TOTP — single host-resident MFA_ENCRYPTION_KEY. The reused key is fine (single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all four secret classes at once).' — pinned so the LK.2 anchor + 4-class-secret-rotation (BYOK + gui_control_key + LiveKit + MFA TOTP) + single-trust-boundary contract all stay documented", () => {
    expect(body).toMatch(/\/\/ LK\.2 — AES-256-GCM envelope for per-Mac LiveKit API secrets\./);
    expect(body).toMatch(
      /\/\/ Same envelope as BYOK Anthropic \+ gui_control_key \+ MFA TOTP —\s*\n?\s*\/\/ single host-resident MFA_ENCRYPTION_KEY\. The reused key is fine\s*\n?\s*\/\/ \(single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all\s*\n?\s*\/\/ four secret classes at once\)\./,
    );
  });

  it("Storage-form framing pinned: 'base64(AES-256-GCM([IV(12) | tag(16) | ciphertext])) — the fleet_nodes.livekit_api_secret_ciphertext column is TEXT (per LK.1 migration; binary not chosen so JSON payloads + log dumps stay portable across the existing tooling).' — pinned so the base64-text-column + LK.1-migration cross-reference + why-not-binary (JSON-payload + log-dump portability) rationale all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Storage form: base64\(AES-256-GCM\(\[IV\(12\) \| tag\(16\) \| ciphertext\]\)\)\s*\n?\s*\/\/ — the fleet_nodes\.livekit_api_secret_ciphertext column is TEXT\s*\n?\s*\/\/ \(per LK\.1 migration; binary not chosen so JSON payloads \+ log\s*\n?\s*\/\/ dumps stay portable across the existing tooling\)\./,
    );
  });

  it('3-constant catalog pinned: AES_256_KEY_BYTES = 32 + GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16. Drift would diverge from the canonical envelope shared across all 4 secret classes', () => {
    expect(body).toMatch(/const AES_256_KEY_BYTES = 32;/);
    expect(body).toMatch(/const GCM_IV_BYTES = 12;/);
    expect(body).toMatch(/const GCM_TAG_BYTES = 16;/);
  });

  it("encryptLivekitSecret base64-emission pinned: 'Encrypt the per-Mac LiveKit API secret with the shared MFA_ENCRYPTION_KEY and return a base64-encoded [IV | tag | ciphertext] string suitable for the TEXT column.' + empty-key throws + .toString('base64') tail. Drift to dropping .toString('base64') would store Buffer hex/raw in TEXT column", () => {
    expect(body).toMatch(
      /\/\*\* Encrypt the per-Mac LiveKit API secret with the shared\s*\n?\s*\*\s+MFA_ENCRYPTION_KEY and return a base64-encoded\s*\n?\s*\*\s+`\[IV \| tag \| ciphertext\]` string suitable for the TEXT column\. \*\//,
    );
    expect(body).toMatch(
      /if \(plaintext\.length === 0\) \{\s*\n?\s*throw new Error\('LiveKit API secret is empty; refusing to encrypt'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/return Buffer\.concat\(\[iv, tag, ciphertext\]\)\.toString\('base64'\);/);
  });

  it("decryptLivekitSecret framing pinned: 'Decrypt a stored base64 [IV | tag | ciphertext] blob back to the plaintext LiveKit API secret. Used at JWT-mint time (LK.3) — the plaintext never escapes the server process.' — pinned so the LK.3-JWT-mint cross-reference + plaintext-never-escapes-server contract stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Decrypt a stored base64 `\[IV \| tag \| ciphertext\]` blob back to\s*\n?\s*\*\s+the plaintext LiveKit API secret\. Used at JWT-mint time \(LK\.3\) —\s*\n?\s*\*\s+the plaintext never escapes the server process\. \*\//,
    );
  });

  it('decryptLivekitSecret envelope-parse pinned: minimum-length check + iv/tag/ciphertext slice extraction + setAuthTag + final() → utf8. Drift would diverge from the encrypt-side blob layout; drift to dropping setAuthTag would silently skip GCM auth verification (catastrophic — accepts tampered ciphertext)', () => {
    expect(body).toMatch(
      /export function decryptLivekitSecret\(ciphertextBase64: string, keyBase64: string\): string \{\s*\n?\s*const blob = Buffer\.from\(ciphertextBase64, 'base64'\);\s*\n?\s*if \(blob\.length < GCM_IV_BYTES \+ GCM_TAG_BYTES \+ 1\) \{/,
    );
    expect(body).toMatch(
      /const iv = blob\.subarray\(0, GCM_IV_BYTES\);\s*\n?\s*const tag = blob\.subarray\(GCM_IV_BYTES, GCM_IV_BYTES \+ GCM_TAG_BYTES\);\s*\n?\s*const ciphertext = blob\.subarray\(GCM_IV_BYTES \+ GCM_TAG_BYTES\);\s*\n?\s*const key = decodeKey\(keyBase64\);\s*\n?\s*const decipher = createDecipheriv\('aes-256-gcm', key, iv\);\s*\n?\s*decipher\.setAuthTag\(tag\);\s*\n?\s*return Buffer\.concat\(\[decipher\.update\(ciphertext\), decipher\.final\(\)\]\)\.toString\('utf8'\);/,
    );
  });
});
