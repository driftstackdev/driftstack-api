// Proxy registry — metadata/ciphertext in tauri-plugin-store, vault key in Keychain.
//
// Stored under the same store file as settings (settings.json) but
// keyed separately so a settings reset doesn't blow away proxies and
// vice versa. IDs are random uuid-shaped strings minted at create
// time; they're stable across edits so any future "session created
// with this proxy" reference can stay valid.
//
// The settings file contains only non-secret display/routing metadata. SOCKS
// passwords, OpenVPN profiles, and WireGuard private keys are AES-GCM encrypted
// per proxy in the plugin store. The one random vault key lives in the OS
// credential store and is loaded once per process. listProxies hydrates secret
// fields only in memory. Legacy plaintext rows and per-proxy Keychain entries
// migrate ciphertext-first and are removed only after the encrypted write is
// durable.

import { invoke } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import type {
  AccountProxyScheme,
  OpenVpnConfigInput,
  WireGuardConfigInput,
} from './account-proxies';
import { makeWriteLock } from './store-write-lock';

export interface ProxyConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** ISO8601 created timestamp. Hand-set by the GUI; not server-authoritative. */
  createdAt: string;
  /** ARC A — the id of this proxy's server-side account_proxies row, set the
   *  first time it's synced (on launch). Lets a session pass proxy_id so the
   *  server routes egress through it. Absent until first synced. */
  serverId?: string;
  /** OVPN/WG — proxy type. Absent/undefined = socks5 (back-compat). host/port
   *  are the (display) endpoint for VPN schemes too. */
  scheme?: AccountProxyScheme;
  /** OVPN/WG config blocks — present only for the matching scheme. These are
   *  hydrated from protected storage and never serialized to settings.json. */
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

/** Non-secret proxy fields safe for counts, pickers, and fleet summaries.
 * Reading these must not wake the OS credential store. */
export type ProxyMetadata = Omit<ProxyConfig, 'password' | 'openvpn' | 'wireguard'>;

export interface ProxyDraft {
  label: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  scheme?: AccountProxyScheme;
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

const STORE_FILE = 'settings.json';
const PROXIES_KEY = 'proxies';
const SECRET_ENVELOPES_KEY = 'proxy_secret_envelopes_v2';
const VAULT_KEY_NAME = 'proxy_vault_key';
const VAULT_KEY_PREFIX = 'v1:';
const VAULT_AAD_PURPOSE = 'driftstack-gui-proxy-secret';
const MAX_PROXY_SECRET_BYTES = 128 * 1024;
const AES_GCM_IV_BYTES = 12;
// Read-only legacy namespace. New and updated secrets never write here.
const SECRET_PREFIX = 'proxy_secret:';

interface PersistedProxyConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string | null;
  createdAt: string;
  serverId?: string;
  scheme?: AccountProxyScheme;
}

interface ProxySecretPayload {
  version: 1;
  binding: {
    host: string;
    port: number;
    username: string | null;
    scheme: AccountProxyScheme | null;
  };
  password: string | null;
  openvpn?: OpenVpnConfigInput;
  wireguard?: WireGuardConfigInput;
}

interface ProxySecretEnvelope {
  version: 2;
  iv: string;
  ciphertext: string;
}

let store: LazyStore | null = null;
// A protected value only needs to cross the native boundary once per process.
// Apart from avoiding redundant IPC, this prevents multiple mounted views and
// background polls from replaying the same macOS Keychain authorization prompt.
const volatileSecrets = new Map<string, ProxySecretPayload>();
const protectedLoadFailures = new Map<string, { message: string; retryAfter: number }>();
let vaultKeyPromise: Promise<CryptoKey> | null = null;
let vaultKeyFailure: { message: string; retryAfter: number } | null = null;
const PROTECTED_LOAD_RETRY_MS = 30_000;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

// Serialize migration and all read-modify-write operations. In particular, a
// first-load plaintext purge must not race a concurrent add/edit and persist its
// stale snapshot over the newer metadata.
const writeLock = makeWriteLock();

export async function listProxies(): Promise<ProxyConfig[]> {
  return writeLock(listProxiesUnlocked);
}

/** Read sanitized proxy metadata without touching Keychain. Legacy rows that
 * still contain plaintext deliberately fall back to the full migration path so
 * their secrets are protected before the disk copy is purged. */
export async function listProxyMetadata(): Promise<ProxyMetadata[]> {
  return writeLock(listProxyMetadataUnlocked);
}

export async function addProxy(draft: ProxyDraft): Promise<ProxyConfig> {
  return writeLock(async () => {
    const all = await listProxiesUnlocked();
    const next: ProxyConfig = {
      id: mintId(),
      label: draft.label,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      password: draft.password,
      createdAt: new Date().toISOString(),
      ...(draft.scheme !== undefined ? { scheme: draft.scheme } : {}),
      ...(draft.openvpn !== undefined ? { openvpn: draft.openvpn } : {}),
      ...(draft.wireguard !== undefined ? { wireguard: draft.wireguard } : {}),
    };
    await saveSecret(next);
    try {
      await persist([...all, next]);
    } catch (error) {
      await deleteSecret(next.id).catch(() => undefined);
      throw error;
    }
    return next;
  });
}

export async function updateProxy(id: string, patch: ProxyDraft): Promise<ProxyConfig | null> {
  return writeLock(async () => {
    const all = await listProxiesUnlocked();
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const prior = all[idx] as ProxyConfig;
    const scheme = patch.scheme ?? prior.scheme;
    const updated: ProxyConfig = {
      ...prior,
      label: patch.label,
      host: patch.host,
      port: patch.port,
      username: patch.username,
      password: patch.password,
      ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
      // Retain an omitted block only while editing the same VPN scheme. Switching
      // schemes must delete the old private configuration from protected storage.
      ...(scheme === 'openvpn'
        ? { openvpn: patch.openvpn ?? prior.openvpn, wireguard: undefined }
        : {}),
      ...(scheme === 'wireguard'
        ? { wireguard: patch.wireguard ?? prior.wireguard, openvpn: undefined }
        : {}),
      ...(scheme !== 'openvpn' && scheme !== 'wireguard'
        ? { openvpn: undefined, wireguard: undefined }
        : {}),
    };
    const next = [...all];
    next[idx] = updated;
    const previousSecret = secretPayload(all[idx] as ProxyConfig);
    await saveSecret(updated);
    try {
      await persist(next);
    } catch (error) {
      await saveSecretPayload(id, previousSecret).catch(() => undefined);
      throw error;
    }
    return updated;
  });
}

export async function removeProxy(id: string): Promise<void> {
  return writeLock(async () => {
    const all = await listProxiesUnlocked();
    await persist(all.filter((p) => p.id !== id));
    await deleteSecret(id).catch(() => undefined);
  });
}

/** Record the server-side account_proxies id for a local proxy (set on first
 *  launch-sync). No-op if the local proxy is gone. Returns the updated row. */
export async function setProxyServerId(id: string, serverId: string): Promise<ProxyConfig | null> {
  return writeLock(async () => {
    const all = await listProxiesUnlocked();
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const updated: ProxyConfig = { ...(all[idx] as ProxyConfig), serverId };
    const next = [...all];
    next[idx] = updated;
    await persist(next);
    return updated;
  });
}

async function persist(proxies: readonly PersistedProxyConfig[]): Promise<void> {
  await getStore().set(PROXIES_KEY, proxies.map(toPersistedProxy));
  await getStore().save();
}

async function listProxyMetadataUnlocked(): Promise<ProxyMetadata[]> {
  const value = await getStore().get<unknown>(PROXIES_KEY);
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      await getStore().set(PROXIES_KEY, []);
      await getStore().save();
    }
    return [];
  }

  const metadata: ProxyMetadata[] = [];
  const seenIds = new Set<string>();
  let rewriteDisk = false;
  let requiresSecretMigration = false;
  for (const raw of value) {
    if (!isPersistedProxyConfig(raw)) {
      rewriteDisk = true;
      continue;
    }
    if (seenIds.has(raw.id)) {
      rewriteDisk = true;
      continue;
    }
    seenIds.add(raw.id);
    if (hasLegacySecretFields(raw)) requiresSecretMigration = true;
    const clean = toPersistedProxy(raw);
    if (!samePersistedShape(raw, clean)) rewriteDisk = true;
    metadata.push(clean);
  }

  if (requiresSecretMigration) {
    return (await listProxiesUnlocked()).map(toPersistedProxy);
  }
  if (rewriteDisk) await persist(metadata);
  return metadata;
}

async function listProxiesUnlocked(): Promise<ProxyConfig[]> {
  const value = await getStore().get<unknown>(PROXIES_KEY);
  if (!Array.isArray(value)) {
    // A corrupt legacy value may itself be an object containing credentials.
    // Normalize any present non-array value so unknown plaintext is not retained.
    if (value !== undefined) {
      await getStore().set(PROXIES_KEY, []);
      await getStore().save();
    }
    return [];
  }

  const hydrated: ProxyConfig[] = [];
  const seenIds = new Set<string>();
  let rewriteDisk = false;
  for (const raw of value) {
    if (!isPersistedProxyConfig(raw)) {
      // Drop malformed rows on rewrite rather than retaining unknown fields that
      // may themselves contain credentials.
      rewriteDisk = true;
      continue;
    }
    if (seenIds.has(raw.id)) {
      // Duplicate ids alias the same protected entry and can silently attach one
      // proxy's credentials to another endpoint. Keep the first stable row only.
      rewriteDisk = true;
      continue;
    }
    seenIds.add(raw.id);

    const metadata = toPersistedProxy(raw);
    const legacy = legacySecretPayload(raw);
    let protectedValue: ProxySecretPayload | null = null;
    let protectedLoadError: unknown = null;
    try {
      protectedValue = await loadSecret(metadata);
    } catch (error) {
      // Invalid data is never a recoverable "credential store unavailable"
      // condition. Do not let a stale plaintext row override corrupted protected
      // credentials.
      if (isProtectedPayloadError(error)) throw error;
      protectedLoadError = error;
    }
    let secret: ProxySecretPayload;
    if (protectedValue !== null) {
      secret = protectedValue;
    } else if (legacy !== null) {
      // A locked Keychain must never become an excuse to retain plaintext. Keep
      // the migrated value in memory for this launch, but purge the disk row.
      try {
        await saveSecretPayload(metadata.id, legacy);
      } catch (error) {
        // Corrupt/unsupported protected storage is not a temporary lock. Keep
        // the legacy row untouched and fail closed rather than purging its only
        // recoverable copy into volatile memory.
        if (isProtectedPayloadError(error)) throw error;
        volatileSecrets.set(metadata.id, legacy);
      }
      secret = legacy;
    } else if (volatileSecrets.has(metadata.id)) {
      secret = volatileSecrets.get(metadata.id) as ProxySecretPayload;
    } else if (protectedLoadError !== null) {
      throw protectedLoadError instanceof Error
        ? protectedLoadError
        : new Error('Protected proxy credentials are unavailable.');
    } else {
      throw new Error('Protected proxy credentials are missing.');
    }

    if (hasLegacySecretFields(raw) || !samePersistedShape(raw, metadata)) {
      rewriteDisk = true;
    }
    hydrated.push(hydrateProxy(metadata, secret));
  }

  if (rewriteDisk) await persist(hydrated);
  return hydrated;
}

function isPersistedProxyConfig(v: unknown): v is PersistedProxyConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isSafeProxyId(r.id) &&
    typeof r.label === 'string' &&
    typeof r.host === 'string' &&
    Number.isInteger(r.port) &&
    (r.port as number) >= 1 &&
    (r.port as number) <= 65535 &&
    (r.username === null || typeof r.username === 'string') &&
    typeof r.createdAt === 'string' &&
    (r.serverId === undefined || typeof r.serverId === 'string') &&
    (r.scheme === undefined || isProxyScheme(r.scheme))
  );
}

function isSafeProxyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isProxyScheme(value: unknown): value is AccountProxyScheme {
  return value === 'socks5' || value === 'http' || value === 'openvpn' || value === 'wireguard';
}

function toPersistedProxy(proxy: PersistedProxyConfig): PersistedProxyConfig {
  return {
    id: proxy.id,
    label: proxy.label,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    createdAt: proxy.createdAt,
    ...(proxy.serverId !== undefined ? { serverId: proxy.serverId } : {}),
    ...(proxy.scheme !== undefined ? { scheme: proxy.scheme } : {}),
  };
}

function samePersistedShape(raw: PersistedProxyConfig, clean: PersistedProxyConfig): boolean {
  return JSON.stringify(raw) === JSON.stringify(clean);
}

function secretName(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function vaultAad(id: string, binding: ProxySecretPayload['binding']): ArrayBuffer {
  return exactArrayBuffer(
    new TextEncoder().encode(
      JSON.stringify([
        VAULT_AAD_PURPOSE,
        2,
        id,
        binding.host,
        binding.port,
        binding.username,
        binding.scheme,
      ]),
    ),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length === 0 || value.length > 180_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Protected proxy credentials are corrupted.');
  }
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new Error('Protected proxy credentials are corrupted.');
  }
}

async function loadVaultKey(): Promise<CryptoKey> {
  if (vaultKeyPromise !== null) return vaultKeyPromise;
  if (vaultKeyFailure !== null && Date.now() < vaultKeyFailure.retryAfter) {
    throw new Error(vaultKeyFailure.message);
  }

  vaultKeyPromise = (async () => {
    let stored = await invoke<string | null>('secret_load', { key: VAULT_KEY_NAME });
    if (stored === null) {
      const fresh = crypto.getRandomValues(new Uint8Array(32));
      stored = `${VAULT_KEY_PREFIX}${bytesToBase64(fresh)}`;
      await invoke('secret_save', { key: VAULT_KEY_NAME, value: stored });
    }
    if (!stored.startsWith(VAULT_KEY_PREFIX)) {
      throw new Error('Protected proxy vault key has an unsupported format.');
    }
    const raw = base64ToBytes(stored.slice(VAULT_KEY_PREFIX.length));
    if (raw.byteLength !== 32) {
      throw new Error('Protected proxy vault key has an unsupported format.');
    }
    return crypto.subtle.importKey('raw', exactArrayBuffer(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  })();

  try {
    const key = await vaultKeyPromise;
    vaultKeyFailure = null;
    return key;
  } catch (error) {
    vaultKeyPromise = null;
    const message =
      error instanceof Error ? error.message : 'Protected proxy credentials are unavailable.';
    vaultKeyFailure = { message, retryAfter: Date.now() + PROTECTED_LOAD_RETRY_MS };
    throw error;
  }
}

async function readSecretEnvelopes(): Promise<Record<string, unknown>> {
  const value = await getStore().get<unknown>(SECRET_ENVELOPES_KEY);
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Protected proxy credentials are corrupted.');
  }
  return { ...(value as Record<string, unknown>) };
}

function isProxySecretEnvelope(value: unknown): value is ProxySecretEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.version === 2 && typeof row.iv === 'string' && typeof row.ciphertext === 'string';
}

async function saveSecretEnvelope(id: string, secret: ProxySecretPayload): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(secret));
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_PROXY_SECRET_BYTES) {
    throw new Error('Protected proxy credentials exceed the storage limit.');
  }
  const key = await loadVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: exactArrayBuffer(iv),
      additionalData: vaultAad(id, secret.binding),
    },
    key,
    exactArrayBuffer(plaintext),
  );
  const envelopes = await readSecretEnvelopes();
  envelopes[id] = {
    version: 2,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  } satisfies ProxySecretEnvelope;
  await getStore().set(SECRET_ENVELOPES_KEY, envelopes);
  await getStore().save();
}

async function loadSecretEnvelope(
  metadata: PersistedProxyConfig,
): Promise<ProxySecretPayload | null> {
  const envelopes = await readSecretEnvelopes();
  const stored = envelopes[metadata.id];
  if (stored === undefined) return null;
  if (!isProxySecretEnvelope(stored)) {
    throw new Error('Protected proxy credentials have an unsupported format.');
  }
  const iv = base64ToBytes(stored.iv);
  const ciphertext = base64ToBytes(stored.ciphertext);
  if (iv.byteLength !== AES_GCM_IV_BYTES || ciphertext.byteLength < 17) {
    throw new Error('Protected proxy credentials are corrupted.');
  }
  const key = await loadVaultKey();
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: exactArrayBuffer(iv),
        additionalData: vaultAad(metadata.id, secretBinding(metadata)),
      },
      key,
      exactArrayBuffer(ciphertext),
    );
    const bytes = new Uint8Array(decrypted);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROXY_SECRET_BYTES) throw new Error();
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!isProxySecretPayload(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Protected proxy credentials are corrupted.');
  }
}

async function deleteSecretEnvelope(id: string): Promise<void> {
  const envelopes = await readSecretEnvelopes();
  if (envelopes[id] === undefined) return;
  delete envelopes[id];
  await getStore().set(SECRET_ENVELOPES_KEY, envelopes);
  await getStore().save();
}

function secretPayload(proxy: ProxyConfig): ProxySecretPayload {
  return {
    version: 1,
    binding: secretBinding(proxy),
    password: proxy.password,
    ...(proxy.openvpn !== undefined ? { openvpn: proxy.openvpn } : {}),
    ...(proxy.wireguard !== undefined ? { wireguard: proxy.wireguard } : {}),
  };
}

async function saveSecret(proxy: ProxyConfig): Promise<void> {
  await saveSecretPayload(proxy.id, secretPayload(proxy));
}

async function saveSecretPayload(id: string, secret: ProxySecretPayload): Promise<void> {
  await saveSecretEnvelope(id, secret);
  volatileSecrets.set(id, secret);
  protectedLoadFailures.delete(id);
}

async function loadSecret(metadata: PersistedProxyConfig): Promise<ProxySecretPayload | null> {
  const cached = volatileSecrets.get(metadata.id);
  if (cached !== undefined) return cached;

  const encrypted = await loadSecretEnvelope(metadata);
  if (encrypted !== null) {
    volatileSecrets.set(metadata.id, encrypted);
    return encrypted;
  }

  // Read-only legacy migration path. Ciphertext is durably saved before the old
  // per-proxy credential item is deleted, so interruption can only leave a safe
  // duplicate—not lose the sole secret copy.
  const priorFailure = protectedLoadFailures.get(metadata.id);
  if (priorFailure !== undefined && Date.now() < priorFailure.retryAfter) {
    throw new Error(priorFailure.message);
  }

  let value: string | null;
  try {
    value = await invoke<string | null>('secret_load', { key: secretName(metadata.id) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Protected proxy credentials unavailable.';
    protectedLoadFailures.set(metadata.id, {
      message,
      retryAfter: Date.now() + PROTECTED_LOAD_RETRY_MS,
    });
    throw error;
  }
  protectedLoadFailures.delete(metadata.id);
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Protected proxy credentials are corrupted.');
  }
  if (!isProxySecretPayload(parsed)) {
    throw new Error('Protected proxy credentials have an unsupported format.');
  }
  if (!secretBindingMatches(parsed.binding, metadata)) {
    throw new Error('Protected proxy credentials do not match proxy metadata.');
  }
  try {
    await saveSecretEnvelope(metadata.id, parsed);
    await invoke('secret_delete', { key: secretName(metadata.id) });
  } catch {
    // Preserve the still-protected legacy item and keep this launch usable. A
    // future process retries the ciphertext-first migration.
  }
  volatileSecrets.set(metadata.id, parsed);
  return parsed;
}

async function deleteSecret(id: string): Promise<void> {
  volatileSecrets.delete(id);
  protectedLoadFailures.delete(id);
  await deleteSecretEnvelope(id);
  // Idempotent cleanup for pre-vault installations.
  await invoke('secret_delete', { key: secretName(id) });
}

function isProtectedPayloadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Protected proxy credentials') ||
      error.message.startsWith('Protected proxy vault key'))
  );
}

function hasLegacySecretFields(value: PersistedProxyConfig): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, 'password') ||
    Object.prototype.hasOwnProperty.call(value, 'openvpn') ||
    Object.prototype.hasOwnProperty.call(value, 'wireguard')
  );
}

function legacySecretPayload(value: PersistedProxyConfig): ProxySecretPayload | null {
  if (!hasLegacySecretFields(value)) return null;
  const row = value as PersistedProxyConfig & Record<string, unknown>;
  return {
    version: 1,
    binding: secretBinding(value),
    password: row.password === null || typeof row.password === 'string' ? row.password : null,
    ...(isOpenVpnConfig(row.openvpn) ? { openvpn: row.openvpn } : {}),
    ...(isWireGuardConfig(row.wireguard) ? { wireguard: row.wireguard } : {}),
  };
}

function hydrateProxy(metadata: PersistedProxyConfig, secret: ProxySecretPayload): ProxyConfig {
  if (!secretBindingMatches(secret.binding, metadata)) {
    throw new Error('Protected proxy credentials do not match proxy metadata.');
  }
  return {
    ...metadata,
    password: secret.password,
    ...(secret.openvpn !== undefined ? { openvpn: secret.openvpn } : {}),
    ...(secret.wireguard !== undefined ? { wireguard: secret.wireguard } : {}),
  };
}

function secretBindingMatches(
  binding: ProxySecretPayload['binding'],
  metadata: PersistedProxyConfig,
): boolean {
  const expected = secretBinding(metadata);
  return (
    binding.host === expected.host &&
    binding.port === expected.port &&
    binding.username === expected.username &&
    binding.scheme === expected.scheme
  );
}

function isProxySecretPayload(value: unknown): value is ProxySecretPayload {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    isProxySecretBinding(row.binding) &&
    (row.password === null || typeof row.password === 'string') &&
    (row.openvpn === undefined || isOpenVpnConfig(row.openvpn)) &&
    (row.wireguard === undefined || isWireGuardConfig(row.wireguard))
  );
}

function secretBinding(proxy: PersistedProxyConfig): ProxySecretPayload['binding'] {
  return {
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    scheme: proxy.scheme ?? null,
  };
}

function isProxySecretBinding(value: unknown): value is ProxySecretPayload['binding'] {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.host === 'string' &&
    Number.isInteger(row.port) &&
    (row.username === null || typeof row.username === 'string') &&
    (row.scheme === null || isProxyScheme(row.scheme))
  );
}

function isOpenVpnConfig(value: unknown): value is OpenVpnConfigInput {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.config_blob === 'string' &&
    (row.username === undefined || typeof row.username === 'string') &&
    (row.password === undefined || typeof row.password === 'string')
  );
}

function isWireGuardConfig(value: unknown): value is WireGuardConfigInput {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.private_key === 'string' &&
    typeof row.peer_public_key === 'string' &&
    typeof row.endpoint === 'string' &&
    typeof row.allowed_ips === 'string' &&
    typeof row.address === 'string' &&
    (row.dns === undefined || typeof row.dns === 'string')
  );
}

function mintId(): string {
  // crypto.randomUUID is in WebCrypto in every Tauri WebView we ship.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Cheap fallback: 16 random hex chars. Good enough for local IDs.
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ─── validation helpers (used by the form) ────────────────────────

export interface DraftValidation {
  ok: boolean;
  errors: Partial<Record<keyof ProxyDraft, string>>;
}

export function validateDraft(d: ProxyDraft): DraftValidation {
  const errors: Partial<Record<keyof ProxyDraft, string>> = {};
  if (d.label.trim().length === 0) errors.label = 'Required.';
  if (d.host.trim().length === 0) errors.host = 'Required.';
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    errors.port = 'Port must be 1–65535.';
  }
  // VPN schemes require their config block (the paste must have parsed); host/
  // port are the endpoint, validated above.
  if (d.scheme === 'openvpn' && d.openvpn === undefined) {
    errors.openvpn = 'Paste a valid .ovpn configuration.';
  }
  if (d.scheme === 'wireguard' && d.wireguard === undefined) {
    errors.wireguard = 'Paste a valid wg0.conf configuration.';
  }
  // username/password are optional; if one is set the other isn't required
  // (some SOCKS5 servers accept username-only auth).
  return { ok: Object.keys(errors).length === 0, errors };
}

// ─── live connectivity probe (native) ─────────────────────────────

/** Result of the native `proxy_test` Tauri command. Field names match
 *  the Rust `ProxyTestResult` serialization exactly. */
export interface ProxyTestResult {
  /** TCP connect + SOCKS5 greeting handshake succeeded. */
  reachable: boolean;
  /** Auth accepted, or none required. `false` only on rejected creds. */
  auth_ok: boolean;
  /** `UDP ASSOCIATE` answered with success — QUIC / WebRTC tunnel works. */
  udp_associate: boolean;
  /**
   * A real SOCKS5 CONNECT to a public destination succeeded.
   *
   * This is the field that answers "will traffic actually leave". Until it
   * existed, `reachable && auth_ok` was treated as healthy — and a proxy can
   * accept TCP, complete the greeting, accept credentials and STILL refuse
   * every CONNECT. Five endpoints did exactly that on 2026-08-18 while the
   * Test button called them fine.
   */
  can_route: boolean;
  /** Raw SOCKS5 reply byte from the CONNECT (0x00 ok, 0x02 ruleset, …). */
  connect_reply: number;
  /** Handshake round-trip in milliseconds. */
  latency_ms: number;
  /** Human-readable summary, safe to render verbatim. */
  message: string;
}

/** Test a SOCKS5 proxy from the desktop host. Raw sockets are
 *  unavailable inside the WebView, so the probe runs natively in Rust
 *  (see `src-tauri` `proxy_test`). Resolves to a structured result even
 *  when the proxy is unreachable — `reachable: false` carries the
 *  diagnostic in `message` rather than throwing. */
/** Result of the native `proxy_exit_probe` command (E-2). */
export interface ProxyExitProbeResult {
  ip: string;
  country: string | null;
  // Geo enrichment (2026-06-15): best-effort city/region/timezone/ASN org
  // from lumtest.com/myip.json fetched THROUGH the proxy (the exit's geo as a
  // site would infer it). All null when lumtest is unreachable/blocked — the
  // ip/country baseline is unaffected.
  city?: string | null;
  region?: string | null;
  timezone?: string | null;
  asn_org?: string | null;
}

/** Exit-geo probe: native Rust fetches /v1/egress/echo THROUGH the proxy
 *  (design doc build-order 2). The catch is deliberately bare, so null means
 *  the invoke failed for ANY reason. Both dependencies this contract used to
 *  name as the cause shipped on 2026-06-12 (V-857); in the packaged app a null
 *  therefore means the echo round-trip did not complete through the proxy.
 *  Callers must render that, and must not attribute it to a pending release. */
export async function probeProxyExit(input: {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}): Promise<ProxyExitProbeResult | null> {
  try {
    return await invoke<ProxyExitProbeResult>('proxy_exit_probe', {
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
    });
  } catch {
    return null;
  }
}

/**
 * The single definition of "this proxy is usable".
 *
 * One predicate on purpose. The count in the header, the per-row pill and the
 * decision to keep a cached exit IP each used to spell this out separately as
 * `reachable && auth_ok`, so adding routing to the verdict meant changing three
 * places that could drift — and two surfaces disagreeing about whether a proxy
 * works is exactly how a dead proxy keeps its green badge.
 */
export function isProxyUsable(result: ProxyTestResult): boolean {
  return result.reachable && result.auth_ok && result.can_route;
}

export async function testProxy(input: {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}): Promise<ProxyTestResult> {
  return invoke<ProxyTestResult>('proxy_test', {
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
  });
}

/** Result of the native `endpoint_resolve` command — a VPN-endpoint DNS pre-flight
 *  (the honest client-side check for UDP-mostly VPN endpoints; full tunnel verifies
 *  at launch). Field names match the Rust `EndpointResolveResult`. */
export interface EndpointResolveResult {
  resolved: boolean;
  ip: string;
  message: string;
}

/** DNS-resolve a VPN endpoint host:port (OpenVPN remote / WireGuard endpoint) —
 *  confirms the hostname is valid/reachable without claiming the tunnel works. */
export async function resolveEndpoint(host: string, port: number): Promise<EndpointResolveResult> {
  return invoke<EndpointResolveResult>('endpoint_resolve', { host, port });
}
