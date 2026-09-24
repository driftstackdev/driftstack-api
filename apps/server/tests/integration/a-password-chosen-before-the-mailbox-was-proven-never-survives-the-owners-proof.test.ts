// A password chosen before anyone proved the mailbox never survives the mailbox
// owner's proof.
//
// Sign-in audit, finding 1 (HIGH, pre-account-takeover). Anyone could sign up
// with someone else's address and a password of their own. The account stayed
// unverified — until the real owner of the mailbox proved it, by a magic link or
// by the "Verify your Driftstack account" email (which the attacker can trigger
// at will through resend-verification or magic-link/request). From then on the
// attacker's password signed in with account-owner rights:
//
//   PREHIJACK-MAGIC  before-verify login=403; after magic-link verify attacker login=200
//   PREHIJACK-VERIFY attacker login after victim verified = 200
//
// What holds now, and what this file proves on a real database through the whole
// app (`buildRealApp`):
//
//   - a magic link that performs the account's first verification drops the
//     password and advances the auth epoch in the same update, so the attacker's
//     password is refused and any session minted under it ends; the owner sets a
//     password with a reset;
//   - the verification link asks for the account's password when it has one, so a
//     person who never signed up cannot verify an account somebody else made in
//     their name — it stays unverified and useless to whoever holds its password;
//   - a completed password reset proves the mailbox, so it verifies the address
//     (finding 7) — which is the safe way out for that person, and replaces the
//     password;
//   - a magic-link sign-in is recorded as a sign-in (finding 9).
//
// The person who really signed up keeps a working path: they verify with the
// password they chose.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  accountAuditRows,
  buildRealApp,
  seedWebSession,
  send,
  type RealApp,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_signin_prehijack';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ATTACKER_PASSWORD = 'the attacker chose this one';
const OWNER_NEW_PASSWORD = 'the owner reset to this one';
const SIGNUP_PASSWORD = 'the person who signed up chose this';

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}

// Every request comes from its own address, so the per-IP gates on the auth
// routes never decide an outcome here.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.61.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

async function post(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await theApp().inject({
    method: 'POST',
    url,
    payload,
    remoteAddress: nextIp(),
  });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
  };
}

async function signUp(email: string, password: string): Promise<string> {
  const res = await post('/v1/auth/signup', { email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const token = res.body.debug_token;
  if (typeof token !== 'string') throw new Error('signup returned no debug token');
  return token;
}

async function login(email: string, password: string): Promise<number> {
  return (await post('/v1/auth/login', { email, password })).status;
}

async function accountRow(email: string): Promise<{
  id: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  auth_epoch: number;
}> {
  const [row] = await sql()<
    Array<{
      id: string;
      password_hash: string | null;
      email_verified_at: Date | null;
      auth_epoch: number;
    }>
  >`SELECT id::text, password_hash, email_verified_at, auth_epoch FROM accounts WHERE email = ${email}`;
  if (row === undefined) throw new Error(`no account for ${email}`);
  return row;
}

async function resetPassword(email: string, newPassword: string): Promise<string> {
  const requested = await post('/v1/auth/password-reset/request', { email });
  expect(requested.status).toBe(200);
  const token = requested.body.debug_token;
  if (typeof token !== 'string') throw new Error('reset request returned no debug token');
  const confirmed = await post('/v1/auth/password-reset/confirm', {
    token,
    new_password: newPassword,
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const session = confirmed.body.session as { token?: unknown } | undefined;
  if (typeof session?.token !== 'string') throw new Error('the reset issued no session');
  return session.token;
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  app = await buildRealApp(database, harness, catalog, { staffEmails: new Set() });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a password chosen before the mailbox was proven never survives the owner’s proof',
  () => {
    it('the isolated database is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL by magic link: the owner’s first sign-in drops the password set before it and ends every session minted under it; the attacker’s password is refused afterwards and the owner signs in', async () => {
      const email = `magic-victim-${randomUUID()}@example.test`;
      await signUp(email, ATTACKER_PASSWORD);
      expect(
        await login(email, ATTACKER_PASSWORD),
        'the unverified account refuses the password',
      ).toBe(403);
      const before = await accountRow(email);
      expect(before.email_verified_at).toBeNull();
      // A session minted at the account's current epoch — what the password's
      // holder would carry. The proof must end it, not only refuse new sign-ins.
      const heldSession = await seedWebSession(sql(), before.id);
      expect((await send(theApp(), heldSession.token, 'GET', '/v1/whoami')).status).toBe(200);

      const requested = await post('/v1/auth/magic-link/request', { email });
      expect(requested.status).toBe(200);
      const consumed = await post('/v1/auth/magic-link/consume', {
        token: requested.body.debug_token,
      });
      expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
      const ownerSession = (consumed.body.session as { token: string }).token;

      expect(
        await login(email, ATTACKER_PASSWORD),
        'the password chosen before the mailbox was proven still signs in',
      ).toBe(401);
      expect(
        (await send(theApp(), heldSession.token, 'GET', '/v1/whoami')).status,
        'a session minted under the unproven password survived the proof',
      ).toBe(401);
      expect((await send(theApp(), ownerSession, 'GET', '/v1/whoami')).status).toBe(200);

      const after = await accountRow(email);
      expect(after.email_verified_at).not.toBeNull();
      expect(after.password_hash, 'the "no password" marker').toBe('');
      expect(after.auth_epoch).toBe(before.auth_epoch + 1);
    });

    it('a magic link on an address that is ALREADY verified leaves the password and the other sessions alone — only the first proof drops what came before it', async () => {
      const email = `magic-verified-${randomUUID()}@example.test`;
      const verifyToken = await signUp(email, SIGNUP_PASSWORD);
      const verified = await post('/v1/auth/verify-email', {
        token: verifyToken,
        password: SIGNUP_PASSWORD,
      });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      const verifiedSession = (verified.body.session as { token: string }).token;
      const before = await accountRow(email);

      const requested = await post('/v1/auth/magic-link/request', { email });
      const consumed = await post('/v1/auth/magic-link/consume', {
        token: requested.body.debug_token,
      });
      expect(consumed.status).toBe(200);

      expect(await login(email, SIGNUP_PASSWORD)).toBe(200);
      expect((await send(theApp(), verifiedSession, 'GET', '/v1/whoami')).status).toBe(200);
      const after = await accountRow(email);
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.auth_epoch).toBe(before.auth_epoch);
    });

    it('a magic-link sign-in is recorded as a sign-in, once, with its method (finding 9)', async () => {
      const email = `magic-login-row-${randomUUID()}@example.test`;
      await signUp(email, ATTACKER_PASSWORD);
      const requested = await post('/v1/auth/magic-link/request', { email });
      const consumed = await post('/v1/auth/magic-link/consume', {
        token: requested.body.debug_token,
      });
      expect(consumed.status).toBe(200);
      const { id } = await accountRow(email);
      const logins = await accountAuditRows(sql(), id, 'account.login');
      expect(logins.map((row) => row.payload?.method)).toEqual(['magic_link']);
      expect(logins[0]?.actor_type).toBe('customer');
      expect(logins[0]?.actor_account_id).toBe(id);
    });

    it('CRITICAL by verification link: a person who never signed up cannot verify the account, so the attacker’s password keeps getting "not verified" — and the link is not used up by the refusal', async () => {
      const email = `verify-victim-${randomUUID()}@example.test`;
      const verifyToken = await signUp(email, ATTACKER_PASSWORD);

      // The victim clicks the link in the email they never asked for.
      const clicked = await post('/v1/auth/verify-email', { token: verifyToken });
      expect(clicked.status, JSON.stringify(clicked.body)).toBe(401);
      expect(clicked.body.password_required).toBe(true);
      expect(clicked.body.session).toBeUndefined();
      const guessed = await post('/v1/auth/verify-email', {
        token: verifyToken,
        password: 'a guess at what the attacker chose',
      });
      expect(guessed.status).toBe(401);
      expect(guessed.body.password_required).toBe(true);

      expect((await accountRow(email)).email_verified_at).toBeNull();
      expect(
        await login(email, ATTACKER_PASSWORD),
        'the attacker’s password signs in to the account the victim clicked',
      ).toBe(403);
    });

    it('CRITICAL the victim’s way out: a password reset verifies the address and replaces the attacker’s password (finding 7) — the attacker is refused, the owner signs in with the new one', async () => {
      const email = `reset-victim-${randomUUID()}@example.test`;
      await signUp(email, ATTACKER_PASSWORD);

      const ownerSession = await resetPassword(email, OWNER_NEW_PASSWORD);
      expect((await send(theApp(), ownerSession, 'GET', '/v1/whoami')).status).toBe(200);

      const account = await accountRow(email);
      expect(account.email_verified_at, 'the reset proved the mailbox').not.toBeNull();
      expect(await login(email, ATTACKER_PASSWORD)).toBe(401);
      expect(
        await login(email, OWNER_NEW_PASSWORD),
        'a completed reset leaves the new password refused as "not verified"',
      ).toBe(200);

      const verifiedRows = await accountAuditRows(sql(), account.id, 'account.email_verified');
      expect(verifiedRows.map((row) => row.payload?.via)).toEqual(['password_reset']);
    });

    it('the person who really signed up verifies with the password they chose; a wrong one is refused without using up the link', async () => {
      const email = `real-signup-${randomUUID()}@example.test`;
      const verifyToken = await signUp(email, SIGNUP_PASSWORD);

      const wrong = await post('/v1/auth/verify-email', {
        token: verifyToken,
        password: 'not the one I chose',
      });
      expect(wrong.status).toBe(401);
      expect((await accountRow(email)).email_verified_at).toBeNull();

      const right = await post('/v1/auth/verify-email', {
        token: verifyToken,
        password: SIGNUP_PASSWORD,
      });
      expect(right.status, JSON.stringify(right.body)).toBe(200);
      const session = (right.body.session as { token: string }).token;
      expect((await send(theApp(), session, 'GET', '/v1/whoami')).status).toBe(200);
      expect((await accountRow(email)).email_verified_at).not.toBeNull();
      expect(await login(email, SIGNUP_PASSWORD)).toBe(200);

      // Single use still holds once the link has been used.
      const again = await post('/v1/auth/verify-email', {
        token: verifyToken,
        password: SIGNUP_PASSWORD,
      });
      expect(again.status).toBe(400);
    });
  },
);
