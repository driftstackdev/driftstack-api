// Cross-source invariant: the 4 secret-encryption classes (BYOK
// Anthropic + gui_control_key + LiveKit + MFA TOTP) ALL share the
// same MFA_ENCRYPTION_KEY env var as the AES-256-GCM key material.
// Drift on one (e.g. a refactor that introduces a separate
// LIVEKIT_ENCRYPTION_KEY) would break the "single trust boundary"
// + "one rotation rotates all four ciphertexts" guarantee.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BYOK = resolve(REPO_ROOT, 'apps/server/src/lib/byok-anthropic-encryption.ts');
const GCK = resolve(REPO_ROOT, 'apps/server/src/lib/gui-control-key-encryption.ts');
const LK = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-secret-encryption.ts');
const MFA = resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts');
// The four library files above document the shared key; the SHARING itself
// happens where they are wired.
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const CONFIG = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('MFA_ENCRYPTION_KEY shared 4-class cross-source invariant', () => {
  const byok = read(BYOK);
  const gck = read(GCK);
  const lk = read(LK);
  const mfa = read(MFA);

  it('Each of the 4 lib/* encryption modules references MFA_ENCRYPTION_KEY by name', () => {
    expect(byok).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(gck).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(lk).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(mfa).toMatch(/MFA_ENCRYPTION_KEY/);
  });

  it('Each of the 4 lib/* encryption modules validates the key as 32 bytes (AES-256) with a MFA_ENCRYPTION_KEY-named error message — pinned so the must-decode-to-32-bytes guard stays consistent across the 4 classes (drift would let a smaller-key class silently weaken its security)', () => {
    expect(byok).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(gck).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(lk).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(mfa).toMatch(/MFA_ENCRYPTION_KEY must decode to 32 bytes; got/);
  });

  it("byok-anthropic-encryption explicitly cross-references mfa-totp: 'The same key is used by mfa-totp.ts; rotating MFA_ENCRYPTION_KEY simultaneously rotates both surfaces' ciphertexts.' — pinned so the rotation-rotates-multiple-surfaces guarantee stays documented (drift here is the load-bearing operator-facing rotation-runbook contract)", () => {
    expect(byok).toMatch(
      /The same key is\s*\n?\s*\/\/ used by `mfa-totp\.ts`; rotating MFA_ENCRYPTION_KEY simultaneously\s*\n?\s*\/\/ rotates both surfaces' ciphertexts\./,
    );
  });

  it("livekit-secret-encryption explicitly cross-references the single-trust-boundary contract: 'single host-resident MFA_ENCRYPTION_KEY. The reused key is fine (single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all' — pinned so the cross-reference + single-trust-boundary + rotate-all rationale stays documented", () => {
    expect(lk).toMatch(
      /single host-resident MFA_ENCRYPTION_KEY\. The reused key is fine\s*\n?\s*\/\/ \(single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all/,
    );
  });

  it('gui-control-key-encryption pins the versioned envelope, context-bound AAD, and shared host-key contract', () => {
    expect(gck).toMatch(
      /AES-256-GCM uses a\s*\n?\s*\/\/ versioned `\[magic \| IV \| tag \| ciphertext\]` envelope and canonical\s*\n?\s*\/\/ additional authenticated data \(AAD\) that binds the ciphertext to its\s*\n?\s*\/\/ purpose, owning account, and one agent-session\. Re-uses\s*\n?\s*\/\/ MFA_ENCRYPTION_KEY per Q2=C \(24h-TTL, MFA-key pattern\)\./,
    );
  });

  it("CRITICAL every encryption consumer is wired from config.mfaEncryptionKey at the BOOTSTRAP site, and no second key source exists. The assertions above read the four library files, where `MFA_ENCRYPTION_KEY` appears only in comments and error strings for at least livekit-secret-encryption — so they pass on prose. Verified by mutation: giving LiveKit `process.env.LIVEKIT_ENCRYPTION_KEY ?? config.mfaEncryptionKey` in bootstrap left this file 5/5 GREEN, which is verbatim the refactor the header says it prevents. Breaking this makes 'one rotation rotates all four ciphertexts' silently false.", () => {
    const bootstrap = read(BOOTSTRAP);
    const config = read(CONFIG);

    // Every consumer draws from the one config field.
    const wirings = bootstrap.match(/config\.mfaEncryptionKey/g) ?? [];
    expect(wirings.length, 'bootstrap must wire the shared key to every consumer').toBeGreaterThan(
      5,
    );

    // And no consumer may reach around it to a second env var. `config.ts` is
    // the only place an *_ENCRYPTION_KEY env may be read at all.
    const rogueEnvReads = [...bootstrap.matchAll(/process\.env\.([A-Z_]*ENCRYPTION_KEY)/g)].map(
      (m) => m[1]!,
    );
    expect(
      [...new Set(rogueEnvReads)].sort(),
      'bootstrap must not read an encryption key directly from the environment:',
    ).toEqual([]);

    // config.ts itself must expose exactly one encryption-key env.
    const configEnvKeys = [
      ...new Set([...config.matchAll(/env\.([A-Z_]*ENCRYPTION_KEY)/g)].map((m) => m[1]!)),
    ];
    expect(configEnvKeys.sort(), 'exactly one encryption-key env may exist').toEqual([
      'MFA_ENCRYPTION_KEY',
    ]);
  });
});
