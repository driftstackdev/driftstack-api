// A person whose password a first magic link removes is told, and can set one
// again.
//
// Sign-in re-audit, round 1, new defect 2 (MEDIUM). A magic link that is an
// account's first proof of its address drops any password set before then (the
// pre-account-takeover fix: whoever registered the address never proved it). But
// the person who really signed up with their own password, then signed in by
// magic link before verifying, lost that password without a word:
//
//   consume response carries only `session`; own password -> 401 "Email or
//   password is incorrect."; the only trace an audit row the audit-log page
//   shows as "Email verified"; no email, nothing on the magic-link page
//
// Now the consume response says `password_removed: true`, the account is emailed
// once, and the audit row is labelled distinctly on the dashboard (a separate
// page test). The password is gone — that is the fix and it stays — and a reset
// sets a new one.
//
// Real database, whole app (`buildRealApp`), with a recording email service.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { createEmailService, type EmailService } from '../../src/services/email.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  accountAuditRows,
  buildRealApp,
  type RealApp,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_signin_password_removed';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const OWN_PASSWORD = 'the password I chose at signup';
const NEW_PASSWORD = 'the password I set afterwards';

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;

/** Every email the auth flows asked to send: the method called and its arguments. */
const sends: Array<{ method: string; args: Record<string, unknown> }> = [];

/** A no-op email service that records each send before passing it on. */
function recordingEmail(): EmailService {
  const inner = createEmailService({ config: null, logger: createTestLogger() });
  return new Proxy(inner, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (args: Record<string, unknown>): unknown => {
        sends.push({ method: String(prop), args });
        return (value as (a: Record<string, unknown>) => unknown).call(target, args);
      };
    },
  });
}

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.64.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

async function post(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await theApp().inject({ method: 'POST', url, payload, remoteAddress: nextIp() });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
  };
}

async function magicLinkSignIn(
  email: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requested = await post('/v1/auth/magic-link/request', { email });
  expect(requested.status).toBe(200);
  return post('/v1/auth/magic-link/consume', { token: requested.body.debug_token });
}

function removalNotices(to: string): Array<Record<string, unknown>> {
  return sends
    .filter((s) => s.method === 'sendPasswordRemoved' && s.args.to === to)
    .map((s) => s.args);
}

async function accountId(email: string): Promise<string> {
  const [row] = await sql()<Array<{ id: string }>>`
    SELECT id::text FROM accounts WHERE email = ${email}`;
  if (row === undefined) throw new Error(`no account for ${email}`);
  return row.id;
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  app = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set(),
    email: recordingEmail(),
  });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a person whose password a first magic link removes is told, and can set one again',
  () => {
    it('the isolated database is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL sign up with a password, sign in by magic link before verifying: the response says password_removed, one email goes to the account, the old password is refused, and a reset sets a new one that signs in', async () => {
      const email = `signed-up-myself-${randomUUID()}@example.test`;
      const signup = await post('/v1/auth/signup', { email, password: OWN_PASSWORD });
      expect(signup.status, JSON.stringify(signup.body)).toBe(200);

      const consumed = await magicLinkSignIn(email);
      expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
      expect(consumed.body.password_removed).toBe(true);
      expect(typeof (consumed.body.session as { token?: unknown } | undefined)?.token).toBe(
        'string',
      );

      const notices = removalNotices(email);
      expect(notices).toHaveLength(1);
      expect(String(notices[0]?.resetUrl)).toMatch(/\/forgot-password\/?$/);
      expect(notices[0]?.removedAt).toBeInstanceOf(Date);

      expect((await post('/v1/auth/login', { email, password: OWN_PASSWORD })).status).toBe(401);

      const requested = await post('/v1/auth/password-reset/request', { email });
      expect(requested.status).toBe(200);
      const reset = await post('/v1/auth/password-reset/confirm', {
        token: requested.body.debug_token,
        new_password: NEW_PASSWORD,
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect((await post('/v1/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200);

      const rows = await accountAuditRows(sql(), await accountId(email), 'account.email_verified');
      expect(rows.map((r) => [r.payload?.via, r.payload?.password_removed])).toEqual([
        ['magic_link', true],
      ]);
    });

    it('a magic link that removes nothing says nothing: a later sign-in on the verified account, and a first one on an account with no password, carry no password_removed and send no email', async () => {
      const email = `already-verified-${randomUUID()}@example.test`;
      const signup = await post('/v1/auth/signup', { email, password: OWN_PASSWORD });
      const verified = await post('/v1/auth/verify-email', {
        token: signup.body.debug_token,
        password: OWN_PASSWORD,
      });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);

      const later = await magicLinkSignIn(email);
      expect(later.status, JSON.stringify(later.body)).toBe(200);
      expect(later.body).not.toHaveProperty('password_removed');
      expect(removalNotices(email)).toEqual([]);
      expect((await post('/v1/auth/login', { email, password: OWN_PASSWORD })).status).toBe(200);

      // An unverified account that holds no password (the '' marker).
      const bare = `no-password-${randomUUID()}@example.test`;
      await post('/v1/auth/signup', { email: bare, password: OWN_PASSWORD });
      await sql()`UPDATE accounts SET password_hash = '' WHERE email = ${bare}`;
      const first = await magicLinkSignIn(bare);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).not.toHaveProperty('password_removed');
      expect(removalNotices(bare)).toEqual([]);
    });

    it('the second of two magic links racing on one unverified account removes nothing more: exactly one response says password_removed and exactly one email is sent', async () => {
      const email = `raced-${randomUUID()}@example.test`;
      await post('/v1/auth/signup', { email, password: OWN_PASSWORD });
      const [a, b] = await Promise.all([
        post('/v1/auth/magic-link/request', { email }),
        post('/v1/auth/magic-link/request', { email }),
      ]);
      const [first, second] = await Promise.all([
        post('/v1/auth/magic-link/consume', { token: a.body.debug_token }),
        post('/v1/auth/magic-link/consume', { token: b.body.debug_token }),
      ]);
      const told = [first, second].filter((r) => r.body.password_removed === true);
      expect(told, JSON.stringify([first.body, second.body])).toHaveLength(1);
      expect(removalNotices(email)).toHaveLength(1);
    });
  },
);
