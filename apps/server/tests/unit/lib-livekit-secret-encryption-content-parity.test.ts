import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-secret-encryption.ts');

describe('lib/livekit-secret-encryption content parity', () => {
  const body = readFileSync(LIB, 'utf8');

  it('exists at the canonical path and keeps the shared host-key contract', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/MFA_ENCRYPTION_KEY must decode to/);
    expect(body).toMatch(/const AES_256_KEY_BYTES = 32;/);
    expect(body).toMatch(/const GCM_IV_BYTES = 12;/);
    expect(body).toMatch(/const GCM_TAG_BYTES = 16;/);
  });

  it('uses one explicit v2 prefix and a dedicated purpose', () => {
    expect(body).toContain(
      "export const LIVEKIT_SECRET_V2_PREFIX = 'driftstack:livekit-api-secret:v2:';",
    );
    expect(body).toContain("const LIVEKIT_SECRET_AAD_PURPOSE = 'driftstack.livekit-api-secret';");
    expect(body).toMatch(/envelope\.startsWith\(LIVEKIT_SECRET_V2_PREFIX\)/);
    expect(body).toMatch(/envelope\.slice\(LIVEKIT_SECRET_V2_PREFIX\.length\)/);
  });

  it('binds canonical JSON AAD to purpose, version, node UUID, API key and URL', () => {
    expect(body).toMatch(
      /JSON\.stringify\(\[\s*LIVEKIT_SECRET_AAD_PURPOSE,\s*2,\s*normalized\.nodeId,\s*normalized\.apiKey,\s*normalized\.wsUrl,\s*\]\)/,
    );
    expect(body).toMatch(/cipher\.setAAD\(buildLivekitSecretAad\(context\)\);/);
    expect(body).toMatch(/buildLivekitSecretAad\(context\)/);
  });

  it('enforces canonical base64 and bounded context/plaintext before crypto work', () => {
    expect(body).toMatch(/decoded\.toString\('base64'\) !== value/);
    expect(body).toContain('const MAX_NODE_ID_BYTES = 64;');
    expect(body).toContain('const MAX_API_KEY_BYTES = 1_024;');
    expect(body).toContain('const MAX_WS_URL_BYTES = 16_384;');
    expect(body).toContain('const MAX_API_SECRET_BYTES = 4_096;');
    expect(body).toMatch(/UUID_RE\.test\(context\.nodeId\)/);
  });

  it('keeps legacy decryption bootstrap-only and makes the ordinary reader v2-only', () => {
    expect(body).toMatch(/export function decryptLegacyLivekitSecret/);
    expect(body).toContain('LiveKit legacy secret reader refuses a v2 envelope.');
    expect(body).toContain('LiveKit API secret storage is not a v2 envelope.');
    expect(body).toMatch(/return decryptPayload\(envelope, keyBase64\);/);
    expect(body).toMatch(
      /export function decryptLivekitSecret\([\s\S]*?if \(!envelope\.startsWith\(LIVEKIT_SECRET_V2_PREFIX\)\)[\s\S]*?envelope\.slice\(LIVEKIT_SECRET_V2_PREFIX\.length\)/,
    );
  });
});
