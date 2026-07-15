// Record- and slot-bound encryption for customer proxy credentials. The legacy
// account-only envelope is accepted only by the bounded bootstrap converter;
// ordinary dispatch reads require the explicit v2 prefix and exact proxy tuple.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OpenVpnProxyConfigSchema, WireGuardProxyConfigSchema } from '@driftstack/api-types';
import { deriveTenantMasterKey } from './profile-key-hierarchy.js';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MIN_ENVELOPE_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + 1;
const PASSWORD_MAX_UTF8_BYTES = 4 * 1024;
const OPENVPN_MAX_UTF8_BYTES = 2 * 1024 * 1024;
const WIREGUARD_PRIVATE_KEY_UTF8_BYTES = 44;
const AAD_PURPOSE = 'driftstack.account-proxy-secret';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACCOUNT_PROXY_SECRET_V2_PREFIX = 'driftstack:account-proxy-secret:v2:';

export type AccountProxySecretSlot = 'password' | 'openvpn-config' | 'wireguard-private-key';

export interface AccountProxySecretContext {
  accountId: string;
  proxyId: string;
  slot: AccountProxySecretSlot;
}

function normalizeUuid(name: 'accountId' | 'proxyId', value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Account proxy secret ${name} must be a UUID.`);
  return value.toLowerCase();
}

function normalizeContext(context: AccountProxySecretContext): AccountProxySecretContext {
  if (!['password', 'openvpn-config', 'wireguard-private-key'].includes(context.slot)) {
    throw new Error('Account proxy secret slot is invalid.');
  }
  return {
    accountId: normalizeUuid('accountId', context.accountId),
    proxyId: normalizeUuid('proxyId', context.proxyId),
    slot: context.slot,
  };
}

function buildAad(context: AccountProxySecretContext): Buffer {
  const normalized = normalizeContext(context);
  return Buffer.from(
    JSON.stringify([AAD_PURPOSE, 2, normalized.accountId, normalized.proxyId, normalized.slot]),
    'utf8',
  );
}

function maximumPlaintextBytes(slot: AccountProxySecretSlot): number {
  switch (slot) {
    case 'password':
      return PASSWORD_MAX_UTF8_BYTES;
    case 'openvpn-config':
      return OPENVPN_MAX_UTF8_BYTES;
    case 'wireguard-private-key':
      return WIREGUARD_PRIVATE_KEY_UTF8_BYTES;
  }
}

function validateMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== AES_256_KEY_BYTES) {
    throw new Error(`Account proxy master key must be ${AES_256_KEY_BYTES.toString()} bytes.`);
  }
}

function validatePlaintext(value: string, slot: AccountProxySecretSlot): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 1 || bytes.length > maximumPlaintextBytes(slot)) {
    throw new Error(`Account proxy ${slot} plaintext is outside its byte bound.`);
  }

  if (slot === 'password') {
    if (value.length < 1 || value.length > 1024) {
      throw new Error('Account proxy password must contain 1-1024 characters.');
    }
    return value;
  }

  if (slot === 'wireguard-private-key') {
    const parsed = WireGuardProxyConfigSchema.shape.private_key.safeParse(value);
    if (!parsed.success) throw new Error('Account proxy WireGuard private key is invalid.');
    return parsed.data;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Account proxy OpenVPN secret is not valid JSON.');
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    throw new Error('Account proxy OpenVPN secret must be an object.');
  }
  const record = parsedJson as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowedKeys =
    record['password'] === undefined ? ['config_blob'] : ['config_blob', 'password'];
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) {
    throw new Error('Account proxy OpenVPN secret has an invalid shape.');
  }
  const parsed = OpenVpnProxyConfigSchema.safeParse(record);
  if (!parsed.success) throw new Error('Account proxy OpenVPN secret is invalid.');
  return JSON.stringify({
    config_blob: parsed.data.config_blob,
    ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {}),
  });
}

function decodeCanonicalEnvelope(payload: string, slot: AccountProxySecretSlot): Buffer {
  const maximumBytes = GCM_IV_BYTES + GCM_TAG_BYTES + maximumPlaintextBytes(slot);
  const maximumBase64Chars = Math.ceil(maximumBytes / 3) * 4;
  if (
    payload.length < Math.ceil(MIN_ENVELOPE_BYTES / 3) * 4 ||
    payload.length > maximumBase64Chars ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  ) {
    throw new Error('Account proxy secret is outside its canonical bounded base64 shape.');
  }
  const decoded = Buffer.from(payload, 'base64');
  if (
    decoded.length < MIN_ENVELOPE_BYTES ||
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== payload
  ) {
    throw new Error('Account proxy secret is not canonical bounded base64.');
  }
  return decoded;
}

function decryptPayload(
  masterKey: Buffer,
  context: AccountProxySecretContext,
  payload: string,
  useAad: boolean,
): string {
  validateMasterKey(masterKey);
  const normalized = normalizeContext(context);
  const blob = decodeCanonicalEnvelope(payload, normalized.slot);
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const tmk = deriveTenantMasterKey(masterKey, normalized.accountId);
  const decipher = createDecipheriv('aes-256-gcm', tmk, iv);
  if (useAad) decipher.setAAD(buildAad(normalized));
  decipher.setAuthTag(tag);
  const plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintextBytes.length > maximumPlaintextBytes(normalized.slot)) {
    throw new Error(`Account proxy ${normalized.slot} plaintext exceeds its byte bound.`);
  }
  const plaintext = plaintextBytes.toString('utf8');
  if (!Buffer.from(plaintext, 'utf8').equals(plaintextBytes)) {
    throw new Error('Account proxy secret plaintext is not exact UTF-8.');
  }
  return validatePlaintext(plaintext, normalized.slot);
}

export function encryptAccountProxySecret(
  masterKey: Buffer,
  context: AccountProxySecretContext,
  plaintext: string,
): string {
  validateMasterKey(masterKey);
  const normalized = normalizeContext(context);
  const validated = validatePlaintext(plaintext, normalized.slot);
  const iv = randomBytes(GCM_IV_BYTES);
  const tmk = deriveTenantMasterKey(masterKey, normalized.accountId);
  const cipher = createCipheriv('aes-256-gcm', tmk, iv);
  cipher.setAAD(buildAad(normalized));
  const ciphertext = Buffer.concat([cipher.update(validated, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  return `${ACCOUNT_PROXY_SECRET_V2_PREFIX}${payload}`;
}

/** Strict ordinary reader: prefixless account-only legacy envelopes fail. */
export function readAccountProxySecret(
  masterKey: Buffer,
  context: AccountProxySecretContext,
  stored: string,
): string {
  if (!stored.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) {
    throw new Error('Account proxy secret is not a v2 envelope.');
  }
  return decryptPayload(
    masterKey,
    context,
    stored.slice(ACCOUNT_PROXY_SECRET_V2_PREFIX.length),
    true,
  );
}

/** Bootstrap-only legacy converter; an existing v2 value authenticates in place. */
export function convertAccountProxySecretToV2(
  masterKey: Buffer,
  context: AccountProxySecretContext,
  stored: string,
): string {
  if (stored.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)) {
    readAccountProxySecret(masterKey, context, stored);
    return stored;
  }
  const plaintext = decryptPayload(masterKey, context, stored, false);
  return encryptAccountProxySecret(masterKey, context, plaintext);
}
