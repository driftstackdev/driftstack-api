// V-266 — Browser-OAuth-style activation flow for the CLI / GUI client.
//
// State storage: pure Redis with a 5-minute TTL on every code. Keys
// follow `cli-auth:code:{codeId}`. JSON-serialised value carries the
// state, status, and (post-bind) the API key plaintext + accountId
// the GUI will pull on its next poll.
//
// One-shot semantics: `exchange` deletes the key on successful
// retrieval, so a second call returns `expired`. A code that's still
// `pending` after TTL expiry naturally returns `expired` because
// Redis evicted it.
//
// Public-facing browser URL: built from the configured
// `dashboardOrigin` (e.g. `https://app.driftstack.dev`) so dev /
// staging / production all wire correctly.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ApiKeyScope } from '@driftstack/api-types';

const REDIS_KEY_PREFIX = 'cli-auth:code:';
const TTL_SECONDS = 5 * 60;

/**
 * Minimal KV-store contract the service needs. Production wires the
 * Redis backend below; tests pass an in-memory implementation.
 */
export interface CliAuthorizeStore {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

class RedisStore implements CliAuthorizeStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
  async del(key: string): Promise<void> {
    await this.redis.del(key);
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
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export type CliCodeStatus = 'pending' | 'bound';

interface StoredCode {
  state: string;
  status: CliCodeStatus;
  client_label: string | null;
  /** Set when status='bound'. Plaintext API key the CLI / GUI receives. */
  plaintext: string | null;
  /** Set when status='bound'. */
  account_id: string | null;
  created_at: number;
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
}

export interface InitiateInput {
  state: string;
  client_label?: string | null;
}

export interface InitiateResult {
  code: string;
  browser_url: string;
  expires_at: Date;
}

export interface BindInput {
  code: string;
  state: string;
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
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    // 32 bytes → 43 url-safe chars (base64url, no padding). Plenty of
    // entropy for a 5-minute one-shot code.
    const code = randomBytes(32).toString('base64url');
    const stored: StoredCode = {
      state: input.state,
      status: 'pending',
      client_label: input.client_label ?? null,
      plaintext: null,
      account_id: null,
      created_at: Date.now(),
    };
    await this.store.setEx(this.key(code), JSON.stringify(stored), TTL_SECONDS);

    const browserUrl = new URL(this.dashboardPath, this.dashboardOrigin);
    browserUrl.searchParams.set('code', code);
    browserUrl.searchParams.set('state', input.state);

    return {
      code,
      browser_url: browserUrl.toString(),
      expires_at: new Date(stored.created_at + TTL_SECONDS * 1000),
    };
  }

  async bind(input: BindInput): Promise<BindResult> {
    const raw = await this.store.get(this.key(input.code));
    if (raw === null) {
      throw new CliAuthorizeError('not_found', 'Authorization code not found or expired.');
    }
    const stored = JSON.parse(raw) as StoredCode;

    if (!constantTimeStringEqual(stored.state, input.state)) {
      throw new CliAuthorizeError('state_mismatch', 'State parameter does not match.');
    }
    if (stored.status === 'bound') {
      throw new CliAuthorizeError(
        'already_bound',
        'Authorization code has already been bound to an account.',
      );
    }

    const updated: StoredCode = {
      ...stored,
      status: 'bound',
      plaintext: input.api_key_plaintext,
      account_id: input.account_id,
    };
    // Reset TTL so the GUI has the full 5 minutes from bind time to
    // poll exchange — covers the case where the user took 4:30 to log
    // in + click Authorize, then the GUI polls 30s later only to find
    // an expired code.
    await this.store.setEx(this.key(input.code), JSON.stringify(updated), TTL_SECONDS);

    return {
      account_id: input.account_id,
      expires_at: new Date(Date.now() + TTL_SECONDS * 1000),
    };
  }

  async exchange(input: ExchangeInput): Promise<ExchangeResult> {
    const raw = await this.store.get(this.key(input.code));
    if (raw === null) {
      // Either never existed OR Redis evicted on TTL — treat both as
      // expired from the CLI / GUI's perspective.
      return { status: 'expired' };
    }
    const stored = JSON.parse(raw) as StoredCode;

    if (!constantTimeStringEqual(stored.state, input.state)) {
      throw new CliAuthorizeError('state_mismatch', 'State parameter does not match.');
    }

    if (stored.status === 'pending') {
      return { status: 'pending' };
    }

    if (stored.status === 'bound') {
      // One-shot: delete the entry so subsequent calls return expired.
      // Done before returning so an exception during JSON.stringify on
      // the response side can't leak a re-deliverable plaintext.
      if (stored.plaintext === null || stored.account_id === null) {
        throw new CliAuthorizeError(
          'invalid_code',
          'Internal: bound code missing plaintext or account_id.',
        );
      }
      await this.store.del(this.key(input.code));
      return {
        status: 'bound',
        api_key: stored.plaintext,
        account_id: stored.account_id,
      };
    }

    return { status: 'expired' };
  }

  private key(code: string): string {
    return `${REDIS_KEY_PREFIX}${code}`;
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
