// The Google/GitHub sign-in finds the existing account however the provider
// cases a Gmail address.
//
// Sign-in audit, finding 6 (LOW). The production OAuth lookup (bootstrap's
// `findIdByEmail`) canonicalised the provider's email WITHOUT lowercasing it
// first. Gmail canonicalisation keys on the literal domain `gmail.com`, so a
// provider answering `First.Last@Gmail.com` for an account stored as
// `first.last@gmail.com` missed on both lookups, fell through to account
// creation, and died on `accounts_canonical_email_unique` — a 500 on /redeem.
// That is V-1724 again, for mixed case:
//
//   OAUTH-CASE  idp email FIRST94EF8915.Last@Gmail.com vs stored
//               first94ef8915last@gmail.com: lookup miss; createFromIdp -> 23505
//
// The test app's OAuth wiring did a literal-only lookup of its own, so the
// in-memory suites could not see this class at all. Both now call ONE function,
// `findAccountIdForSignInEmail`, which is what this file drives: on a real
// database, and through the test app's whole OAuth flow.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { findAccountIdForSignInEmail } from '../../src/services/auth-flows.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_signin_oauth_case';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

let client: postgres.Sql | null = null;
let database: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 4 });
}, 120_000);

afterAll(async () => {
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)('on a real database', () => {
  it('CRITICAL a provider email in mixed case, with the dots moved, finds the account stored in lower case — no miss, so no second account and no unique-violation 500', async () => {
    if (database === null)
      throw new Error('isolated Postgres database could not be created or reached');
    const repo = new DrizzleAuthFlowsRepo(database);
    const local = `first${randomUUID().slice(0, 8)}`;
    const stored = await repo.createAccount({
      email: `${local}.last@gmail.com`,
      name: null,
      passwordHash: 'scrypt$placeholder',
      initialTier: 'free',
    });
    for (const spelling of [
      `${local.toUpperCase()}.Last@Gmail.com`,
      `${local}last@GMAIL.COM`,
      ` ${local}.LAST+idp@gmail.com `,
      `${local}.last@gmail.com`,
    ]) {
      expect(await findAccountIdForSignInEmail(repo, spelling), spelling).toBe(stored.id);
    }
    expect(await findAccountIdForSignInEmail(repo, `someone-else-${local}@gmail.com`)).toBeNull();
  });
});

describe('the production wiring and the test app call the same lookup', () => {
  it('bootstrap’s OAuth account lookup delegates to findAccountIdForSignInEmail', () => {
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    expect(bootstrap).toMatch(
      /findIdByEmail:\s*\(e\)\s*=>\s*findAccountIdForSignInEmail\(authFlowsRepo,\s*e\)/,
    );
  });
});

describe('through the test app’s whole Google sign-in', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  it('CRITICAL Google answering First.Last@Gmail.com for an account signed up as firstlast@gmail.com reaches the existing account (merge confirmation), not a new one', async () => {
    const googleEmail = 'Pat.Example@Gmail.com';
    const idpFetch: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = /\/token$/.test(url)
        ? { access_token: 'at_live', token_type: 'bearer', scope: 'openid email' }
        : { sub: 'google-sub-case', email: googleEmail, email_verified: true, name: 'Pat' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    fx = await buildTestApp({
      oauthClient: {
        signingSecret: 'd'.repeat(32),
        callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
        dashboardOrigin: 'https://app.driftstack.test',
        google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' },
        fetch: idpFetch,
      },
    });
    const app = fx.app;
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'patexample@gmail.com', password: 'correct horse battery staple' },
    });
    expect(signup.statusCode).toBe(200);

    const secret = randomBytes(32).toString('base64url');
    const start = await app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      payload: {
        provider: 'google',
        redirect_to: 'https://app.driftstack.test/',
        binding_hash: createHash('sha256').update(secret).digest('base64url'),
      },
    });
    const state =
      new URL(start.json<{ authorize_url: string }>().authorize_url).searchParams.get('state') ??
      '';
    const top = await app.inject({
      method: 'GET',
      url: `/v1/auth/oauth/google/callback?${new URLSearchParams({ code: 'c', state }).toString()}`,
    });
    const code =
      new URLSearchParams(new URL(String(top.headers.location)).hash.slice(1)).get('code') ?? '';
    const redeemed = await app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/redeem',
      payload: { code, flow_secret: secret },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const body = redeemed.json<{ outcome: string; session_token?: string }>();
    expect(body.outcome, 'a second account was created for the same mailbox').toBe(
      'collision-pending-verification',
    );
    expect(body.session_token).toBeUndefined();
    expect(await fx.authFlowsRepo.findAccountByEmail('pat.example@gmail.com')).toBeNull();
  });
});
