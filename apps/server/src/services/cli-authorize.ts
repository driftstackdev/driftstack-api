// V-266 — Browser-OAuth-style activation flow for the CLI / GUI client.
//
// State storage: pure Redis with a 5-minute TTL on every code. Keys use
// `cli-auth:code:<sha256(code)>`, keeping the live wire credential out of
// Redis key scans/slowlogs. The JSON value carries state, status, and the
// (post-bind) encrypted API key + accountId the GUI pulls on its next poll.
//
// One-shot semantics: `exchange` deletes the key on successful
// retrieval, so a second call returns `expired`. A code that's still
// `pending` after TTL expiry naturally returns `expired` because
// Redis evicted it.
//
// Public-facing browser URL: built from the configured
// `dashboardOrigin` (e.g. `https://app.driftstack.dev`) so dev /
// staging / production all wire correctly.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ApiKeyScope } from '@driftstack/api-types';
import { decryptPlatformSecret, encryptPlatformSecret } from '../lib/platform-secret-encryption.js';

const REDIS_KEY_PREFIX = 'cli-auth:code:';
// Pre-bind window: the user may take up to ~5 min to open the browser,
// log in, and click Authorize, so the code lives 5 min from initiate.
const TTL_SECONDS = 5 * 60;
// Post-bind window (D1): once the key is minted the CLI / GUI is
// actively polling and collects within seconds. A tighter 2-minute
// ceiling caps how long the (encrypted) API key sits in Redis while
// still comfortably covering a slow poll loop.
const BIND_TTL_SECONDS = 2 * 60;
// RFC 8628 recommends at least 27 bits of entropy for a user code. Eight
// unambiguous base32 symbols provide 40 bits while remaining easy to compare
// and type as `XXXX-XXXX` from the desktop into the dashboard.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_HASH_DOMAIN = 'driftstack:cli-authorize:user-code:v1\0';

export function cliAuthorizeRedisKey(code: string): string {
  return `${REDIS_KEY_PREFIX}${createHash('sha256').update(code).digest('hex')}`;
}

/**
 * Minimal KV-store contract the service needs. Production wires the
 * Redis backend below; tests pass an in-memory implementation.
 */
export interface CliAuthorizeStore {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Atomically replace `expectedValue` with `value` and reset its TTL.
   * Returns false when the key expired or another writer changed it first.
   */
  compareAndSetEx(
    key: string,
    expectedValue: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  del(key: string): Promise<void>;
  /**
   * C2 — atomic read-and-delete. Returns the value and removes the key
   * in a single indivisible step so that of two concurrent exchange
   * polls on the same bound code, exactly ONE observes the plaintext;
   * the loser sees `null`. A non-atomic get-then-del would let both
   * polls read `bound` before either deletes and double-deliver the
   * one-shot key.
   */
  getDel(key: string): Promise<string | null>;
}

class RedisStore implements CliAuthorizeStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
  async compareAndSetEx(
    key: string,
    expectedValue: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      "local current = redis.call('get', KEYS[1]); if current ~= ARGV[1] then return 0 end; redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1",
      1,
      key,
      expectedValue,
      value,
      ttlSeconds,
    );
    return result === 1;
  }
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
  async getDel(key: string): Promise<string | null> {
    // GETDEL is a single Redis command but requires server >= 6.2. A
    // Lua EVAL of get+del is equally atomic (Redis runs the script
    // indivisibly) and works on every server version, so we never
    // depend on the deployed Redis version here.
    const result = await this.redis.eval(
      "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]) end; return v",
      1,
      key,
    );
    return (result as string | null) ?? null;
  }
}

export class InMemoryCliAuthorizeStore implements CliAuthorizeStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async compareAndSetEx(
    key: string,
    expectedValue: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now() || entry.value !== expectedValue) {
      if (entry && entry.expiresAt <= Date.now()) this.entries.delete(key);
      return false;
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getDel(key: string): Promise<string | null> {
    // Atomic by construction: Node is single-threaded and there is no
    // await between the read and the delete, so two concurrent callers
    // cannot both observe a non-null value.
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }
}

export type CliCodeStatus = 'pending' | 'bound';

interface StoredCodeBase {
  state: string;
  /** Domain-separated SHA-256 of the device-displayed user code. */
  user_code_hash: string;
  client_label: string | null;
  created_at: number;
}

interface StoredPendingCode extends StoredCodeBase {
  status: 'pending';
  secret_blob: null;
  encrypted: false;
  account_id: null;
}

interface StoredBoundCode extends StoredCodeBase {
  status: 'bound';
  /**
   * The minted API key held for the CLI / GUI's next exchange poll. This is
   * base64 of the
   * AES-256-GCM `[IV|tag|ciphertext]` blob (D1 — the plaintext key never
   * sits in Redis at rest).
   */
  secret_blob: string;
  /** D1 — true for every bound entry. */
  encrypted: true;
  account_id: string;
}

type StoredCode = StoredPendingCode | StoredBoundCode;

/**
 * Redis is an external trust boundary: deploy drift, operator writes, or a
 * partial restore can leave syntactically-valid JSON whose runtime shape no
 * longer matches StoredCode. Reconstruct a normalized discriminated union
 * instead of casting so malformed values never reach constant-time comparison
 * or secret decryption with attacker-controlled types.
 */
function parseStoredCode(raw: string): StoredCode | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (
    typeof record.state !== 'string' ||
    record.state.length === 0 ||
    typeof record.user_code_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.user_code_hash) ||
    (record.client_label !== null && typeof record.client_label !== 'string') ||
    typeof record.created_at !== 'number' ||
    !Number.isFinite(record.created_at) ||
    record.created_at < 0
  ) {
    return null;
  }

  const common: StoredCodeBase = {
    state: record.state,
    user_code_hash: record.user_code_hash,
    client_label: record.client_label,
    created_at: record.created_at,
  };
  if (
    record.status === 'pending' &&
    record.secret_blob === null &&
    record.encrypted === false &&
    record.account_id === null
  ) {
    return { ...common, status: 'pending', secret_blob: null, encrypted: false, account_id: null };
  }
  if (
    record.status === 'bound' &&
    typeof record.secret_blob === 'string' &&
    record.secret_blob.length > 0 &&
    record.encrypted === true &&
    typeof record.account_id === 'string' &&
    record.account_id.length > 0
  ) {
    return {
      ...common,
      status: 'bound',
      secret_blob: record.secret_blob,
      encrypted: true,
      account_id: record.account_id,
    };
  }
  return null;
}

export interface CliAuthorizeServiceOptions {
  /** Either a Redis client (production) or an explicit store (tests). */
  redis?: Redis;
  store?: CliAuthorizeStore;
  dashboardOrigin: string;
  /** Path on the dashboard that renders the authorization confirmation
   *  screen — defaults to `/cli/authorize` so the URL becomes
   *  `${dashboardOrigin}/cli/authorize?code=…&state=…`. */
  dashboardPath?: string;
  /**
   * D1 — base64 32-byte key used to encrypt the minted API key while it
   * waits in Redis for the CLI / GUI's exchange poll. Wired from
   * MFA_ENCRYPTION_KEY (the same envelope as MFA / BYOK / platform
   * secrets). Required so a freshly minted API key can never be stored
   * in plaintext. Deployments without the key omit CLI authorization.
   */
  secretEncryptionKeyBase64: string;
}

export interface InitiateInput {
  state: string;
  client_label?: string | null;
}

export interface InitiateResult {
  code: string;
  user_code: string;
  browser_url: string;
  expires_at: Date;
}

export interface BindInput {
  code: string;
  state: string;
  /** Human verification code shown only by the initiating device. */
  user_code: string;
  account_id: string;
  api_key_plaintext: string;
  /** Recorded for observability; the actual scopes live on the minted key. */
  scopes: readonly ApiKeyScope[];
}

export interface BindResult {
  account_id: string;
  expires_at: Date;
}

export interface ExchangeInput {
  code: string;
  state: string;
}

export type ExchangeResult =
  | { status: 'pending' }
  | { status: 'bound'; api_key: string; account_id: string }
  | { status: 'expired' };

export class CliAuthorizeError extends Error {
  constructor(
    public readonly code:
      | 'invalid_code'
      | 'state_mismatch'
      | 'user_code_mismatch'
      | 'already_bound'
      | 'not_found'
      | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'CliAuthorizeError';
  }
}

export class CliAuthorizeService {
  private readonly store: CliAuthorizeStore;
  private readonly dashboardOrigin: string;
  private readonly dashboardPath: string;
  private readonly secretEncryptionKey: string;

  constructor(opts: CliAuthorizeServiceOptions) {
    if (opts.store !== undefined) {
      this.store = opts.store;
    } else if (opts.redis !== undefined) {
      this.store = new RedisStore(opts.redis);
    } else {
      throw new Error('CliAuthorizeService: either `store` or `redis` must be provided.');
    }
    this.dashboardOrigin = opts.dashboardOrigin.replace(/\/+$/, '');
    this.dashboardPath = opts.dashboardPath ?? '/cli/authorize';
    this.secretEncryptionKey = opts.secretEncryptionKeyBase64;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    // 32 bytes → 43 url-safe chars (base64url, no padding). Plenty of
    // entropy for a 5-minute one-shot code.
    const code = randomBytes(32).toString('base64url');
    const userCode = generateUserCode();
    const stored: StoredCode = {
      state: input.state,
      user_code_hash: hashUserCode(userCode),
      status: 'pending',
      client_label: input.client_label ?? null,
      secret_blob: null,
      encrypted: false,
      account_id: null,
      created_at: Date.now(),
    };
    await this.store.setEx(this.key(code), JSON.stringify(stored), TTL_SECONDS);

    const browserUrl = new URL(this.dashboardPath, this.dashboardOrigin);
    browserUrl.searchParams.set('code', code);
    browserUrl.searchParams.set('state', input.state);

    return {
      code,
      user_code: userCode,
      browser_url: browserUrl.toString(),
      expires_at: new Date(stored.created_at + TTL_SECONDS * 1000),
    };
  }

  async bind(input: BindInput): Promise<BindResult> {
    const key = this.key(input.code);
    const raw = await this.store.get(key);
    if (raw === null) {
      throw new CliAuthorizeError('not_found', 'Authorization code not found or expired.');
    }
    const stored = parseStoredCode(raw);
    if (stored === null) {
      // Irrecoverable external state must not stay retryable for the rest of
      // its TTL. Consume it before returning the stable public error surface.
      await this.store.del(key);
      throw new CliAuthorizeError('invalid_code', 'Authorization code state is invalid.');
    }

    if (!constantTimeStringEqual(stored.state, input.state)) {
      throw new CliAuthorizeError('state_mismatch', 'State parameter does not match.');
    }
    if (!constantTimeStringEqual(stored.user_code_hash, hashUserCode(input.user_code))) {
      throw new CliAuthorizeError('user_code_mismatch', 'Device verification code does not match.');
    }
    if (stored.status === 'bound') {
      throw new CliAuthorizeError(
        'already_bound',
        'Authorization code has already been bound to an account.',
      );
    }

    // D1 — encrypt the minted key before it enters Redis. Construction
    // requires the envelope key, so there is no plaintext fallback.
    const secretBlob = encryptPlatformSecret(
      input.api_key_plaintext,
      this.secretEncryptionKey,
    ).toString('base64');
    const updated: StoredCode = {
      ...stored,
      status: 'bound',
      secret_blob: secretBlob,
      encrypted: true,
      account_id: input.account_id,
    };
    // Reset the TTL from bind time so the GUI has the full post-bind
    // window to poll exchange even if the user took ~4:30 to log in and
    // click Authorize. The post-bind window (D1) is deliberately shorter
    // than the pre-bind one — the client is now actively polling.
    const didBind = await this.store.compareAndSetEx(
      key,
      raw,
      JSON.stringify(updated),
      BIND_TTL_SECONDS,
    );
    if (!didBind) {
      // Another bind won between our read and write, or the pending code
      // expired. Re-read only to preserve the existing public error split.
      // The route revokes the just-minted key on either error, so a losing
      // concurrent request cannot leave an active orphaned device key.
      const latestRaw = await this.store.get(key);
      if (latestRaw === null) {
        throw new CliAuthorizeError('not_found', 'Authorization code not found or expired.');
      }
      const latest = parseStoredCode(latestRaw);
      if (latest === null) {
        await this.store.del(key);
        throw new CliAuthorizeError('invalid_code', 'Authorization code state is invalid.');
      }
      if (!constantTimeStringEqual(latest.state, input.state)) {
        throw new CliAuthorizeError('state_mismatch', 'State parameter does not match.');
      }
      throw new CliAuthorizeError(
        'already_bound',
        'Authorization code has already been bound to an account.',
      );
    }

    return {
      account_id: input.account_id,
      expires_at: new Date(Date.now() + BIND_TTL_SECONDS * 1000),
    };
  }

  async exchange(input: ExchangeInput): Promise<ExchangeResult> {
    const key = this.key(input.code);
    const raw = await this.store.get(key);
    if (raw === null) {
      // Either never existed OR Redis evicted on TTL — treat both as
      // expired from the CLI / GUI's perspective.
      return { status: 'expired' };
    }
    const stored = parseStoredCode(raw);
    if (stored === null) {
      await this.store.del(key);
      throw new CliAuthorizeError('invalid_code', 'Authorization code state is invalid.');
    }

    if (!constantTimeStringEqual(stored.state, input.state)) {
      throw new CliAuthorizeError('state_mismatch', 'State parameter does not match.');
    }

    if (stored.status === 'pending') {
      return { status: 'pending' };
    }

    if (stored.status === 'bound') {
      // C2 — atomic one-shot claim. getDel removes the entry and returns
      // its value indivisibly, so of two concurrent bound polls exactly
      // one wins; the loser sees `null` and gets `expired` (no
      // double-delivery of the one-shot key). Delete-before-return also
      // means a later exception can't leak a re-deliverable secret.
      const claimedRaw = await this.store.getDel(key);
      if (claimedRaw === null) {
        return { status: 'expired' };
      }
      const claimed = parseStoredCode(claimedRaw);
      // A correctly-bound record is immutable until this getDel. If the
      // claimed bytes differ from the peeked bytes, or no longer describe a
      // bound record, fail closed rather than delivering a swapped secret.
      if (claimedRaw !== raw || claimed?.status !== 'bound') {
        throw new CliAuthorizeError('invalid_code', 'Authorization code state is invalid.');
      }
      // D1 — recover the plaintext from the at-rest blob only at the
      // moment of delivery. A decrypt failure (e.g. the key rotated out
      // from under a bound code) surfaces as expired rather than a 500,
      // so the CLI simply restarts the flow.
      let apiKey: string;
      try {
        apiKey = decryptPlatformSecret(
          Buffer.from(claimed.secret_blob, 'base64'),
          this.secretEncryptionKey,
        );
      } catch {
        return { status: 'expired' };
      }
      return {
        status: 'bound',
        api_key: apiKey,
        account_id: claimed.account_id,
      };
    }

    return { status: 'expired' };
  }

  private key(code: string): string {
    return cliAuthorizeRedisKey(code);
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function normalizeUserCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

function hashUserCode(value: string): string {
  return createHash('sha256')
    .update(USER_CODE_HASH_DOMAIN)
    .update(normalizeUserCode(value))
    .digest('hex');
}

function generateUserCode(): string {
  const bytes = randomBytes(5);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code = USER_CODE_ALPHABET[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
