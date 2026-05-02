// Authenticate a Bearer API key against the account/api_keys store.
//
// The service is decoupled from Drizzle via an `AccountAuthRepo` interface
// so unit tests can use an in-memory fake. The real implementation lives in
// `apps/server/src/db/auth-repo.ts`.

import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
  UnauthorizedError,
} from '../lib/errors.js';
import { keyPrefixFromPlaintext, verifyApiKey } from '../lib/api-keys.js';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountTier } from '@driftstack/api-types';

// ───────────────────────────────────────────────────────────────────────────
// Repository interface (implemented by Drizzle in prod, by a Map in tests)
// ───────────────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRow {
  id: string;
  accountId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AccountAuthRepo {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  getAccount(id: string): Promise<AccountRow | null>;
  touchApiKeyLastUsed(id: string, at: Date): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// Context attached to authenticated requests
// ───────────────────────────────────────────────────────────────────────────

export interface AccountContext {
  account: AccountRow;
  apiKey: ApiKeyRow;
}

// ───────────────────────────────────────────────────────────────────────────
// Authentication entrypoint
// ───────────────────────────────────────────────────────────────────────────

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError('Missing Authorization header.');
  }
  const match = BEARER_RE.exec(authorizationHeader);
  if (!match || !match[1]) {
    throw new UnauthorizedError('Malformed Authorization header. Expected "Bearer <key>".');
  }
  return match[1];
}

export async function authenticate(
  repo: AccountAuthRepo,
  plaintext: string,
  now: Date = new Date(),
): Promise<AccountContext> {
  if (plaintext.length < 24) throw new InvalidKeyError();

  const prefix = keyPrefixFromPlaintext(plaintext);
  const apiKey = await repo.findApiKeyByPrefix(prefix);
  if (!apiKey) throw new InvalidKeyError();

  const matches = await verifyApiKey(plaintext, apiKey.keyHash);
  if (!matches) throw new InvalidKeyError();

  if (apiKey.revokedAt !== null) throw new RevokedKeyError();
  if (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now.getTime()) {
    throw new ExpiredKeyError();
  }

  const account = await repo.getAccount(apiKey.accountId);
  if (!account) throw new InvalidKeyError(); // FK invariant — treat as invalid
  if (account.status === 'suspended') {
    throw new ForbiddenError('Account is suspended.');
  }
  if (account.status === 'deleted') {
    throw new InvalidKeyError();
  }

  await repo.touchApiKeyLastUsed(apiKey.id, now);

  return { account, apiKey };
}

// ───────────────────────────────────────────────────────────────────────────
// Scope check
// ───────────────────────────────────────────────────────────────────────────

export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (!ctx.apiKey.scopes.includes(required)) {
    throw new ForbiddenError(`This action requires the "${required}" scope.`);
  }
}
