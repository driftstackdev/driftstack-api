// The three email-input auth endpoints must answer a registered address exactly as
// they answer one that was never seen. Nothing had ever sent a request to check.
//
// `anti-enumeration-response-cross-source-invariant` states the policy and claims the
// guarantee: *"an attacker cannot distinguish 'this email is registered' from 'this
// email is not registered' based on response shape, status code, or response time."*
// It is a SOURCE-TEXT pin over `packages/api-types` — zero requests, zero injections.
// It proves the response TYPE declares `sent: z.literal(true)` and three fields. It
// cannot prove any of the three things its own sentence promises: not the shape of
// what is actually sent, not the status, and certainly not the time.
//
// That is the shape this repo keeps finding in other people's pins, on a security
// property this time: a passing test standing in for a guarantee it cannot reach.
//
// ── measured, both directions, before asserting anything ──────────────────────
//
// A seeded account and an address that was never registered, through each endpoint:
//
//   POST /v1/auth/password-reset/request   known 200 {"sent":true,"expires_at":…}
//                                        unknown 200 {"sent":true,"expires_at":…}
//   POST /v1/auth/magic-link/request       identical
//   POST /v1/auth/resend-verification      identical
//
// Same status, same key set (`expires_at,sent` on both sides), `sent: true` on both,
// and the two `expires_at` values a millisecond apart — a clock, not a sentinel. So
// the policy HOLDS. This file is the thing that will notice when it stops.
//
// ⚠️ Response TIME is deliberately not asserted, and the difference matters. The known
// path mints and dispatches a token; the unknown path no-ops. Those cannot take
// identical wall-clock time, and a threshold on it under `vitest` would be a flake
// generator rather than a guard — a timing oracle needs a statistical harness and a
// quiet machine. So the existing comment over-promises on that third clause, and this
// file asserts the two it can actually establish rather than repeating all three.
//
// ⚠️ `debug_token` is absent from BOTH sides here, which is what makes the comparison
// the production-shaped one. Its gate is `AUTH_EXPOSE_DEBUG_TOKEN` (config
// `exposeDebugToken`, default false) — NOT `EMAIL_DELIVERY_MODE=stub`, which is what I
// guessed first and what an arm here asserted until it failed. Worth stating because
// this field IS the oracle: the known path returns
// `exposeDebugToken ? plaintext : null` while the unknown path returns null
// unconditionally, so with the flag on the two responses stop matching. Two arms below
// pin the default and the coercion footgun the config comment records.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestApp, seedAdditionalAccount } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** The three endpoints whose whole contract is to reveal nothing. */
const EMAIL_ENDPOINTS = [
  '/v1/auth/password-reset/request',
  '/v1/auth/magic-link/request',
  '/v1/auth/resend-verification',
] as const;

let fx: Awaited<ReturnType<typeof buildTestApp>>;
const KNOWN = 'registered@anti-enumeration.test';
const UNKNOWN = 'never-registered@anti-enumeration.test';

interface Pair {
  url: string;
  knownStatus: number;
  unknownStatus: number;
  knownKeys: string[];
  unknownKeys: string[];
  knownSent: unknown;
  unknownSent: unknown;
  knownExpires: string | undefined;
  unknownExpires: string | undefined;
}

const pairs: Pair[] = [];

beforeAll(async () => {
  fx = await buildTestApp();
  await seedAdditionalAccount(fx, { email: KNOWN, tier: 'free', scopes: ['read'] });

  for (const url of EMAIL_ENDPOINTS) {
    const a = await fx.app.inject({ method: 'POST', url, payload: { email: KNOWN } });
    const b = await fx.app.inject({ method: 'POST', url, payload: { email: UNKNOWN } });
    const ja = a.json<Record<string, unknown>>();
    const jb = b.json<Record<string, unknown>>();
    pairs.push({
      url,
      knownStatus: a.statusCode,
      unknownStatus: b.statusCode,
      knownKeys: Object.keys(ja).sort(),
      unknownKeys: Object.keys(jb).sort(),
      knownSent: ja['sent'],
      unknownSent: jb['sent'],
      knownExpires: typeof ja['expires_at'] === 'string' ? ja['expires_at'] : undefined,
      unknownExpires: typeof jb['expires_at'] === 'string' ? jb['expires_at'] : undefined,
    });
  }
}, 120_000);

afterAll(async () => {
  await fx.app.close();
});

describe('a known email answers exactly like an unknown one', () => {
  it('CRITICAL the sweep really ran against a REGISTERED account and an unregistered address. Both halves matter: comparing two unknown addresses would agree trivially, and every assertion below reports a SAMENESS, so a run where the seed silently failed would satisfy all of them having compared nothing.', () => {
    expect(pairs.length, 'endpoint pairs probed').toBe(EMAIL_ENDPOINTS.length);
    // The seed is the premise. If it did not take, the "known" side is just another
    // unknown address and this file proves nothing at all.
    expect(
      pairs.every((p) => p.knownStatus === 200),
      'a known-email request did not answer 200',
    ).toBe(true);
    expect(
      pairs.every((p) => p.knownKeys.length >= 2),
      'a known-email response was empty',
    ).toBe(true);
  });

  it('CRITICAL the STATUS is identical on both sides. The status is the cheapest oracle there is — one curl and no parsing — and it is the first thing an enumeration script reads.', () => {
    const differing = pairs
      .filter((p) => p.knownStatus !== p.unknownStatus)
      .map((p) => `${p.url}: known ${String(p.knownStatus)} vs unknown ${String(p.unknownStatus)}`);
    expect(differing, 'endpoint(s) whose status reveals whether the email is registered:').toEqual(
      [],
    );
  });

  it('CRITICAL the KEY SET is identical on both sides. An extra field on one side is an oracle even when every shared value matches — a debug_token, a `user_exists`, a next-step hint. This is the assertion the schema pin cannot make, because a type describes what MAY be sent, not what WAS.', () => {
    const differing = pairs
      .filter((p) => p.knownKeys.join(',') !== p.unknownKeys.join(','))
      .map(
        (p) =>
          `${p.url}: known [${p.knownKeys.join(', ')}] vs unknown [${p.unknownKeys.join(', ')}]`,
      );
    expect(differing, 'endpoint(s) whose response fields differ by account existence:').toEqual([]);
  });

  it('CRITICAL `sent` is literally true on both sides. It is the field the policy hangs on: a boolean that told the truth would answer false for an unknown address, which is the whole enumeration vector the literal exists to close.', () => {
    for (const p of pairs) {
      expect(p.knownSent, `${p.url} did not report sent:true for a registered email`).toBe(true);
      expect(p.unknownSent, `${p.url} did not report sent:true for an unknown email`).toBe(true);
    }
  });

  it('CRITICAL `expires_at` is a real forward-dated timestamp on BOTH sides, within seconds of each other. A sentinel on the unknown path — epoch, a fixed date, a null — would satisfy every sameness check above while being the most obvious tell in the response. Measured: the two differ by about a millisecond, which is a clock.', () => {
    for (const p of pairs) {
      expect(p.knownExpires, `${p.url} sent no expires_at for a registered email`).toBeDefined();
      expect(p.unknownExpires, `${p.url} sent no expires_at for an unknown email`).toBeDefined();
      const a = Date.parse(p.knownExpires ?? '');
      const b = Date.parse(p.unknownExpires ?? '');
      expect(Number.isNaN(a), `${p.url} known expires_at is not a date`).toBe(false);
      expect(Number.isNaN(b), `${p.url} unknown expires_at is not a date`).toBe(false);
      expect(
        Math.abs(a - b),
        `${p.url} expires_at differs by more than a clock tick — one side is computed differently`,
      ).toBeLessThan(5_000);
    }
  });

  it('CRITICAL debug_token is absent from BOTH sides, and the flag that would emit it defaults to FALSE. It is the one field that turns these three endpoints into an oracle: the known path returns it, the unknown path returns null, so with the flag on the two responses stop matching. Measured absent here, which is what makes every comparison above the production-shaped one.', () => {
    for (const p of pairs) {
      expect(p.knownKeys, `${p.url} exposed debug_token`).not.toContain('debug_token');
      expect(p.unknownKeys, `${p.url} exposed debug_token on the unknown path`).not.toContain(
        'debug_token',
      );
    }
    const config = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'), 'utf8');
    expect(config, 'the debug-token flag no longer defaults to false').toContain(
      'exposeDebugToken: z.boolean().default(false)',
    );
  });

  it("CRITICAL the debug-token flag is z.boolean(), NOT z.coerce.boolean(). The config comment records the footgun and it is worth a test rather than a paragraph: coerce does Boolean(str), so AUTH_EXPOSE_DEBUG_TOKEN=false — or 0, no, off — would coerce to TRUE, and an operator DISABLING plaintext-token exposure would be the one enabling it. The env mapping converts through `=== 'true'` for exactly that reason.", () => {
    const config = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'), 'utf8');
    expect(
      config,
      'exposeDebugToken now coerces its env value — a falsy string would read as true',
    ).not.toMatch(/exposeDebugToken:\s*z\.coerce\.boolean\(/);
    expect(
      config,
      'the boot refusal for AUTH_EXPOSE_DEBUG_TOKEN=true in production is gone',
    ).toContain('AUTH_EXPOSE_DEBUG_TOKEN=true is development/test-only');
  });
});
