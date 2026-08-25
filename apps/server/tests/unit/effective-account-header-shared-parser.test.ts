// V-326c — shared `X-Driftstack-Account` parser tests + drift-guard.
//
// 7 routes consumed an identical hand-rolled `readEffectiveAccountHeader`
// helper before this slice. The shared lib at
// apps/server/src/lib/effective-account-header.ts is now the single
// source of truth; every route imports it. The slice also added
// empty-string normalisation (matches the slice 105 BYOK fix pattern)
// — a stray `X-Driftstack-Account:` header from an over-eager proxy
// is now treated as absent at the read site instead of relying on
// downstream `resolveEffectiveAccount` to handle empty correctly.
//
// Test pins:
//   - absent / empty / whitespace-only → undefined
//   - header sent twice → joined by Node, NOT resolved to the first value
//   - valid acc_<uuid> → returned trimmed
//
// Drift-guard: every consumer route imports from the shared lib and the
// legacy hand-rolled helper MUST NOT come back. The consumer list is
// discovered from routes/ rather than trusted, because it had already drifted
// (7 listed, 11 real).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import {
  EFFECTIVE_ACCOUNT_HEADER,
  readEffectiveAccountHeader,
} from '../../src/lib/effective-account-header.js';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const CONSUMER_ROUTES = [
  'apps/server/src/routes/admin.ts',
  'apps/server/src/routes/webhooks.ts',
  'apps/server/src/routes/profiles.ts',
  'apps/server/src/routes/profile-snapshots.ts',
  'apps/server/src/routes/account-audit.ts',
  'apps/server/src/routes/sessions.ts',
  'apps/server/src/routes/email-preferences.ts',
  'apps/server/src/routes/account-me.ts',
  'apps/server/src/routes/agent-sessions.ts',
  'apps/server/src/routes/billing.ts',
];

/**
 * Routes that touch the header WITHOUT the shared parser, each with the reason.
 *
 * `billing-crypto` does not resolve an effective account at all — it REJECTS the
 * header, because crypto checkout is self-workspace only. Its own test is
 * deliberately stricter than `readEffectiveAccountHeader`: the shared parser
 * takes the first value and trims, so `'   '` and `['', 'acc_x']` both read as
 * ABSENT, while the rejection guard treats either as present and returns 400.
 * For a guard, stricter is the safe direction, and routing it through the shared
 * parser would LOOSEN it. Verified below rather than asserted.
 */
const DELIBERATE_NON_CONSUMERS = ['apps/server/src/routes/billing-crypto.ts'];

function fakeRequest(headerValue: string | string[] | undefined): FastifyRequest {
  return {
    headers: { [EFFECTIVE_ACCOUNT_HEADER]: headerValue },
  } as unknown as FastifyRequest;
}

describe('readEffectiveAccountHeader — shared parser', () => {
  describe('absent', () => {
    it('returns undefined when no header is present', () => {
      expect(readEffectiveAccountHeader(fakeRequest(undefined))).toBeUndefined();
    });

    it('returns undefined for an empty-string value (normalised at read site)', () => {
      // A stray `X-Driftstack-Account:` empty header (e.g. from a
      // misconfigured proxy) is treated as absent. Before this slice,
      // the empty string was passed through to resolveEffectiveAccount
      // which fortuitously handled it — but relying on downstream
      // behaviour for safety is fragile.
      expect(readEffectiveAccountHeader(fakeRequest(''))).toBeUndefined();
    });

    it('returns undefined for a whitespace-only value (trimmed)', () => {
      expect(readEffectiveAccountHeader(fakeRequest('  \t  '))).toBeUndefined();
    });

    it('returns undefined for an empty header array', () => {
      // Defensive — the header type admits an array and the shared parser
      // must not crash on an empty one.
      expect(readEffectiveAccountHeader(fakeRequest([]))).toBeUndefined();
    });
  });

  describe('valid', () => {
    it('returns the canonical acc_<uuid> form unchanged', () => {
      const id = 'acc_7b3f2e0c-1b6a-4cf3-aa6d-9c2c1f8a1b22';
      expect(readEffectiveAccountHeader(fakeRequest(id))).toBe(id);
    });

    it('trims surrounding whitespace', () => {
      const id = 'acc_7b3f2e0c-1b6a-4cf3-aa6d-9c2c1f8a1b22';
      expect(readEffectiveAccountHeader(fakeRequest(`  ${id}  `))).toBe(id);
    });

    it('takes the first element when the header type hands over an array', () => {
      const a = 'acc_11111111-1111-4111-8111-111111111111';
      const b = 'acc_22222222-2222-4222-8222-222222222222';
      expect(readEffectiveAccountHeader(fakeRequest([a, b]))).toBe(a);
    });

    // V-1365 — the array above is the `string | string[]` header TYPE. It is not what
    // a header sent twice produces: Node arrays only `set-cookie`, and a repeated
    // `X-Driftstack-Account` arrives already joined. The parser is transport-level, so
    // it hands the joined string on unchanged and `resolveEffectiveAccount` refuses it
    // at the membership lookup — executed end to end over a socket in
    // tests/integration/a-header-sent-twice-does-not-arrive-as-an-array.test.ts.
    it('CRITICAL passes a header sent twice through JOINED, rather than resolving it to the first account id. Returning the first value here would silently honour a scope the caller shares the header with, instead of refusing an ambiguous request.', () => {
      const a = 'acc_11111111-1111-4111-8111-111111111111';
      const b = 'acc_22222222-2222-4222-8222-222222222222';
      expect(readEffectiveAccountHeader(fakeRequest(`${a}, ${b}`))).toBe(`${a}, ${b}`);
    });

    it('does NOT validate the acc_<uuid> shape — resolveEffectiveAccount owns that branch', () => {
      // The shared parser is purely transport-level (header → string
      // | undefined). Format validation lives downstream in
      // resolveEffectiveAccount which throws ForbiddenError on
      // malformed input. This keeps the read-site narrow + the
      // validation error message in one place.
      expect(readEffectiveAccountHeader(fakeRequest('not-an-account-id'))).toBe(
        'not-an-account-id',
      );
    });
  });

  describe('drift-guard: every consumer route imports from the shared lib', () => {
    // The hand roster listed seven. Eleven route files consume this header now —
    // account-me, agent-sessions, billing and billing-crypto arrived later and
    // were never checked. All four already import the shared parser, so this was
    // an unenforced state rather than a live defect; but the header decides WHICH
    // ACCOUNT a request acts on, so a route quietly reintroducing its own parse
    // (and with it the empty-string handling this slice fixed) is the kind of
    // drift that ends in acting on the wrong account.
    it('CRITICAL the roster covers every route that consumes the header', () => {
      const discovered = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
        .filter((f) => f.endsWith('.ts'))
        .filter((f) =>
          /readEffectiveAccountHeader|EFFECTIVE_ACCOUNT_HEADER/.test(
            codeOnly(readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes', f), 'utf8')),
          ),
        )
        .map((f) => `apps/server/src/routes/${f}`);
      expect(
        discovered.length,
        'discovery found no consumers — the convention changed',
      ).toBeGreaterThanOrEqual(11);
      const accounted = new Set<string>([...CONSUMER_ROUTES, ...DELIBERATE_NON_CONSUMERS]);
      expect(
        discovered.filter((d) => !accounted.has(d)),
        'a route consumes the effective-account header but is in neither CONSUMER_ROUTES nor ' +
          'DELIBERATE_NON_CONSUMERS, so nothing checks that it uses the shared parser — a ' +
          'hand-rolled copy there would parse the header that decides which account the request ' +
          'acts on. Add it to the roster, or to the exceptions WITH a reason',
      ).toEqual([]);
    });

    it('CRITICAL a route bypassing the shared parser is a NAMED exception, not an accident', () => {
      // The property the roster is a proxy for, asserted over every route rather
      // than over a list someone maintains. Reads the header via the canonical
      // constant too — checking only for the raw string would miss exactly the
      // route this arm was written for.
      const bypassing = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => {
          const body = codeOnly(
            readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes', f), 'utf8'),
          );
          const touches =
            body.includes('x-driftstack-account') || body.includes('EFFECTIVE_ACCOUNT_HEADER');
          return touches && !body.includes('readEffectiveAccountHeader(');
        })
        .map((f) => `apps/server/src/routes/${f}`);
      expect(
        bypassing.filter((b) => !DELIBERATE_NON_CONSUMERS.includes(b)),
        'a route reaches for the effective-account header without the shared parser and without ' +
          'being a documented exception, so its empty/duplicate/whitespace handling can differ ' +
          'from every other route',
      ).toEqual([]);
    });

    it('CRITICAL the crypto-checkout rejection guard stays at least as strict as the parser', () => {
      // V-1366 — this used to say the route is an exception because it is STRICTER,
      // naming `'   '` and `['', 'acc_x']` as inputs that would start reading as absent
      // if it were "tidied" into the shared parser. Measured on a socket, neither shape
      // can arrive. Node strips optional whitespace off a field value, so `'   '` is
      // already `''` before any of our code runs, and only `set-cookie` reaches a handler
      // as an array — a header sent twice arrives JOINED, as `', acc_x'`, which the
      // shared parser would also report as present.
      //
      // So no reachable input distinguishes the two today. The exception is kept for what
      // the route MEANS rather than for a behavioural gap: its rule is refuse-on-presence,
      // not resolve, and that must not become contingent on the shared parser's trimming
      // staying exactly as it is. Both reachable shapes are executed end to end in
      // tests/integration/a-header-sent-twice-does-not-arrive-as-an-array.test.ts —
      // `', acc_x'` is a 400 with no order persisted, `''` is a self-workspace 201.
      const body = codeOnly(
        readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'), 'utf8'),
      );
      expect(
        body,
        'the crypto-checkout guard no longer tests EVERY duplicate header value, so a request ' +
          'sending an empty first value and a real second one would slip the self-workspace check',
      ).toMatch(/Array\.isArray\(rawActAsAccount\)\s*\?\s*rawActAsAccount\.some\(/);
      expect(
        body,
        'the crypto-checkout guard no longer rejects on a present header, so an impersonation ' +
          'header would be silently ignored on a money path rather than returning 400',
      ).toMatch(/if \(hasActAsAccount\) \{/);
    });

    for (const route of CONSUMER_ROUTES) {
      it(`${route} uses the shared readEffectiveAccountHeader`, () => {
        const body = codeOnly(readFileSync(resolve(REPO_ROOT, route), 'utf8'));
        expect(body).toMatch(
          /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js'/,
        );
        // Legacy hand-rolled copy MUST NOT come back.
        expect(body).not.toMatch(/function readEffectiveAccountHeader\(request: FastifyRequest\)/);
        // Local EFFECTIVE_ACCOUNT_HEADER constant MUST NOT come back
        // either — the shared lib exports the canonical constant.
        expect(body).not.toMatch(/^const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/m);
      });
    }
  });
});
