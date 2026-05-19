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
//   - duplicate header → first wins
//   - valid acc_<uuid> → returned trimmed
//
// Drift-guard: all 7 consumer routes import from the shared lib
// and the legacy hand-rolled helper MUST NOT come back.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import {
  EFFECTIVE_ACCOUNT_HEADER,
  readEffectiveAccountHeader,
} from '../../src/lib/effective-account-header.js';

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
];

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

    it('returns undefined for an empty duplicate-header array', () => {
      // Defensive — Fastify rarely emits an empty array, but the
      // shared parser must not crash on it.
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

    it('first wins on duplicate headers (Fastify presents as array)', () => {
      const a = 'acc_11111111-1111-4111-8111-111111111111';
      const b = 'acc_22222222-2222-4222-8222-222222222222';
      expect(readEffectiveAccountHeader(fakeRequest([a, b]))).toBe(a);
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

  describe('drift-guard: 7 consumer routes import from the shared lib', () => {
    for (const route of CONSUMER_ROUTES) {
      it(`${route} uses the shared readEffectiveAccountHeader`, () => {
        const body = readFileSync(resolve(REPO_ROOT, route), 'utf8');
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
