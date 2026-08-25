// Security drift guard for apps/gui-client/src/lib/proxies.ts. The runtime
// behavioral suite proves storage semantics; this cross-app invariant ensures a
// future GUI-only refactor cannot silently reintroduce plaintext proxy/VPN
// credentials without breaking the server's repository-wide security gate.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/proxies.ts');
const body = readFileSync(LIB, 'utf8');

describe('GUI proxy protected-storage content invariant', () => {
  it('keeps the canonical source and non-secret persisted schema', () => {
    expect(existsSync(LIB)).toBe(true);
    const persisted = body.match(/interface PersistedProxyConfig \{(?<fields>[\s\S]*?)\n\}/)?.groups
      ?.fields;
    expect(persisted).toBeDefined();
    expect(persisted).not.toMatch(/password|openvpn|wireguard|private_key|config_blob/);
    expect(body).toContain("const STORE_FILE = 'settings.json';");
    expect(body).toContain("const PROXIES_KEY = 'proxies';");
    expect(body).toContain("const SECRET_ENVELOPES_KEY = 'proxy_secret_envelopes_v2';");
    expect(body).toContain("const VAULT_KEY_NAME = 'proxy_vault_key';");
    // Retained only so existing installations can migrate their old entries.
    expect(body).toContain("const SECRET_PREFIX = 'proxy_secret:';");
  });

  it('stores a versioned AES-GCM envelope per proxy under one cached Keychain vault key', () => {
    expect(body).toMatch(
      /interface ProxySecretPayload \{[\s\S]*?version: 1;[\s\S]*?binding: \{[\s\S]*?host: string;[\s\S]*?port: number;[\s\S]*?password: string \| null;[\s\S]*?openvpn\?: OpenVpnConfigInput;[\s\S]*?wireguard\?: WireGuardConfigInput;[\s\S]*?\n\}/,
    );
    expect(body).toMatch(
      /interface ProxySecretEnvelope \{\s*version: 2;\s*iv: string;\s*ciphertext: string;/,
    );
    expect(body).toContain("await invoke<string | null>('secret_load', { key: VAULT_KEY_NAME })");
    expect(body).toContain("await invoke('secret_save', { key: VAULT_KEY_NAME, value: stored })");
    expect(body).toContain("crypto.subtle.importKey('raw', exactArrayBuffer(raw), 'AES-GCM'");
    expect(body).toContain("name: 'AES-GCM'");
    expect(body).toContain('additionalData: vaultAad(');
    expect(body).toContain('let vaultKeyPromise: Promise<CryptoKey> | null = null;');
    expect(body).not.toContain("invoke('secret_save', { key: secretName(");
  });

  it('persists only sanitized metadata across every mutation path', () => {
    expect(body).toContain('proxies.map(toPersistedProxy)');
    expect(body).toContain('await saveSecret(next);');
    expect(body).toContain('await saveSecret(updated);');
    expect(body).toContain('await deleteSecret(id).catch(() => undefined);');
    expect(body).not.toContain('get<ProxyConfig[]>(PROXIES_KEY)');
  });

  it('migrates legacy rows, purges disk on protected-store failure, and hydrates only in memory', () => {
    expect(body).toContain('const legacy = legacySecretPayload(raw);');
    expect(body).toContain('await saveSecretPayload(metadata.id, legacy);');
    expect(body).toContain('volatileSecrets.set(metadata.id, legacy);');
    expect(body).toContain('await saveSecretEnvelope(metadata.id, parsed);');
    expect(body).toContain("await invoke('secret_delete', { key: secretName(metadata.id) });");
    expect(body).toContain('if (rewriteDisk) await persist(hydrated);');
    expect(body).toContain('hydrated.push(hydrateProxy(metadata, secret));');
    expect(body).toMatch(
      /function hasLegacySecretFields[\s\S]*?'password'[\s\S]*?'openvpn'[\s\S]*?'wireguard'/,
    );
  });

  it('serializes first-load migration with CRUD and rejects malformed protected values', () => {
    expect(body).toContain('return writeLock(listProxiesUnlocked);');
    expect(body).toContain('const all = await listProxiesUnlocked();');
    expect(body).toContain('if (!Array.isArray(value))');
    expect(body).toContain('if (seenIds.has(raw.id))');
    expect(body).toContain('/^[A-Za-z0-9_-]{1,128}$/.test(value)');
    expect(body).toContain("throw new Error('Protected proxy credentials are corrupted.');");
    expect(body).toContain(
      "throw new Error('Protected proxy credentials have an unsupported format.');",
    );
    expect(body).toContain(
      "throw new Error('Protected proxy credentials do not match proxy metadata.');",
    );
  });

  it('keeps count-only reads out of Keychain and suppresses repeated authorization prompts', () => {
    expect(body).toContain('export async function listProxyMetadata()');
    expect(body).toContain('if (requiresSecretMigration)');
    expect(body).toContain('return (await listProxiesUnlocked()).map(toPersistedProxy);');
    expect(body).toContain('const cached = volatileSecrets.get(metadata.id);');
    expect(body).toContain('if (cached !== undefined) return cached;');
    expect(body).toContain('if (vaultKeyPromise !== null) return vaultKeyPromise;');
    expect(body).toContain('const protectedLoadFailures = new Map');
    expect(body).toContain('vaultKeyFailure');
    expect(body).toContain('Date.now() + PROTECTED_LOAD_RETRY_MS');
  });

  it('retains public validation and server-id sync contracts', () => {
    expect(body).toContain('export async function setProxyServerId(');
    expect(body).toContain('export function validateDraft(d: ProxyDraft): DraftValidation');
    expect(body).toContain("errors.port = 'Port must be 1–65535.';");
    expect(body).toContain("d.scheme === 'openvpn'");
    expect(body).toContain("d.scheme === 'wireguard'");
  });
});
