// Password sign-in stops taking guesses for an email after ten wrong passwords,
// from anywhere.
//
// Sign-in audit, finding 3 (MEDIUM). Password sign-in was throttled per IP
// address only, so guesses spread over many addresses were never refused:
//
//   BRUTE  40 wrong guesses from 40 IPs: 40x401, 0 refused; then correct password -> 200
//
// Now the email itself carries a limit, keyed on its CANONICAL form (the same
// form signup dedup uses, so Gmail dot and +tag spellings share one limit): ten
// wrong passwords within fifteen minutes and that email's password sign-in is
// refused for fifteen minutes with a 429 and Retry-After. It is applied the same
// way whether or not an account exists, so it reveals nothing about which emails
// are registered. A correct password clears the count. The per-IP limit stays.
//
// Real database, whole app (`buildRealApp`).

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
import { buildRealApp, type RealApp } from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_signin_email_limit';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PASSWORD = 'the right password for this account';
const WRONG = 'a wrong guess at the password';

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;

function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}

let ipCounter = 0;
/** A fresh source address per request: the per-IP gate never decides here. */
function nextIp(): string {
  ipCounter += 1;
  return `10.62.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | undefined;
  bucket: string | undefined;
}

async function post(url: string, payload: Record<string, unknown>, ip = nextIp()): Promise<Answer> {
  const res = await theApp().inject({ method: 'POST', url, payload, remoteAddress: ip });
  const retryAfter = res.headers['retry-after'];
  const bucket = res.headers['x-ratelimit-bucket'];
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
    bucket: typeof bucket === 'string' ? bucket : undefined,
  };
}

function login(email: string, password: string, ip?: string): Promise<Answer> {
  return post('/v1/auth/login', { email, password }, ip);
}

/** A verified account with PASSWORD. */
async function account(email: string): Promise<void> {
  const signup = await post('/v1/auth/signup', { email, password: PASSWORD });
  expect(signup.status, JSON.stringify(signup.body)).toBe(200);
  const verified = await post('/v1/auth/verify-email', {
    token: signup.body.debug_token,
    password: PASSWORD,
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
}

/** The part of a refusal a caller can read — every field but the request's own id. */
function problem(answer: Answer): Record<string, unknown> {
  const { type, title, status, detail, retry_after_seconds } = answer.body;
  return { httpStatus: answer.status, type, title, status, detail, retry_after_seconds };
}

function expectLockedOut(answer: Answer): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(429);
  const seconds = Number(answer.retryAfter);
  expect(Number.isInteger(seconds), `Retry-After ${String(answer.retryAfter)}`).toBe(true);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(15 * 60);
  expect(answer.body.retry_after_seconds).toBe(seconds);
  expect(String(answer.body.detail)).toMatch(/reset your password/i);
  expect(answer.body.session).toBeUndefined();
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
  'password sign-in stops taking guesses for an email after ten wrong passwords from anywhere',
  () => {
    it('the isolated database is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL ten wrong passwords from ten addresses, then the RIGHT password from an eleventh is refused with 429 and Retry-After — the guesses no longer reach the account', async () => {
      const email = `guessed-${randomUUID()}@example.test`;
      await account(email);
      for (let i = 0; i < 10; i++) {
        const wrong = await login(email, WRONG);
        expect(wrong.status, `wrong guess ${String(i + 1)}`).toBe(401);
      }
      expectLockedOut(await login(email, PASSWORD));
      expectLockedOut(await login(email, WRONG));
    });

    it('CRITICAL an email with no account is treated identically — same answers, same refusal on the eleventh — so the limit reveals nothing about which emails are registered', async () => {
      const known = `known-${randomUUID()}@example.test`;
      const unknown = `nobody-${randomUUID()}@example.test`;
      await account(known);
      for (let i = 0; i < 10; i++) {
        const onKnown = await login(known, WRONG);
        const onUnknown = await login(unknown, WRONG);
        expect(onKnown.status).toBe(401);
        expect(problem(onUnknown)).toEqual(problem(onKnown));
      }
      const eleventhKnown = await login(known, WRONG);
      const eleventhUnknown = await login(unknown, WRONG);
      expectLockedOut(eleventhKnown);
      expectLockedOut(eleventhUnknown);
      expect({ ...problem(eleventhUnknown), retry_after_seconds: 0 }).toEqual({
        ...problem(eleventhKnown),
        retry_after_seconds: 0,
      });
    });

    it('a correct password clears the count: nine wrong, one right, then nine more wrong are still answered 401, not 429', async () => {
      const email = `typo-prone-${randomUUID()}@example.test`;
      await account(email);
      for (let i = 0; i < 9; i++) expect((await login(email, WRONG)).status).toBe(401);
      expect((await login(email, PASSWORD)).status).toBe(200);
      for (let i = 0; i < 9; i++) {
        expect((await login(email, WRONG)).status, `after the clear, guess ${String(i + 1)}`).toBe(
          401,
        );
      }
      expect((await login(email, PASSWORD)).status).toBe(200);
    });

    it('the limit is keyed on the canonical email: guesses spread over Gmail dot, case and +tag spellings of one mailbox share it', async () => {
      const local = `first.last.${randomUUID().slice(0, 8)}`;
      const stored = `${local}@gmail.com`;
      await account(stored);
      const spellings = [
        stored,
        `${local.replace(/\./g, '')}@gmail.com`,
        `${local.toUpperCase()}@Gmail.com`,
        `${local}+tag@gmail.com`,
      ];
      for (let i = 0; i < 10; i++) {
        expect((await login(spellings[i % spellings.length] ?? stored, WRONG)).status).toBe(401);
      }
      expectLockedOut(await login(stored, PASSWORD));
    });

    it('the per-IP limit stays: eleven sign-ins for eleven different emails from ONE address — the eleventh is refused by the address’s bucket', async () => {
      const ip = '10.63.0.1';
      for (let i = 0; i < 10; i++) {
        expect((await login(`spread-${randomUUID()}@example.test`, WRONG, ip)).status).toBe(401);
      }
      const eleventh = await login(`spread-${randomUUID()}@example.test`, WRONG, ip);
      expect(eleventh.status).toBe(429);
      expect(eleventh.bucket).toBe('auth-ip:login');
    });
  },
);
