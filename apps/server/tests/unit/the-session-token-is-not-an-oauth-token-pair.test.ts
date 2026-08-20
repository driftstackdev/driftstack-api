// V-1092 — the session surface is one opaque token, and nothing may describe it as two.
//
// `POST /v1/auth/refresh` takes a body with the single key `token` and returns a new
// session. Two pin titles described it instead as an OAuth exchange: "exchange
// refresh_token for new access_token + rotated refresh_token". The TypeScript one added
// that logout "revokes calling session", which is also false — the handler revokes
// `parsed.data.token`, the token in the BODY, so a caller can revoke any session whose
// token it holds.
//
// Neither field exists. `refresh_token` appears nowhere in the product except redaction
// denylists (which list it defensively, alongside other vendors' field names) and
// `docs/decisions.md`, where it is explicitly the thing v1 does NOT do. A reader of the
// Python resource is the one who pays: the body is `dict[str, Any]` in and out, so the
// prose around it is the only place the key name appears at all.
//
// ── Why a guard rather than two corrected titles ──────────────────────────
//
// The wrong description is the plausible one. Every OAuth surface a developer has met
// works the way those titles said, and nothing in the SDK types contradicts it — the
// Python body is untyped and the Go and TypeScript ones are named for the operation,
// not the field. So this will be re-derived by whoever documents these next unless the
// schema itself refuses it.
//
// This ties the vocabulary to the schema: as long as the request carries one key, no
// SDK auth surface or auth pin may name the OAuth pair. If a refresh-token grant is
// ever actually built, the schema gains a key and this file stops objecting.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogoutRequestSchema, RefreshSessionRequestSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Every surface that describes the refresh/logout contract to a customer, plus the
 * pins that assert what those surfaces say.
 *
 * Pinned as a list rather than globbed. A glob that stopped matching would empty the
 * population and report the vocabulary clean everywhere, which is the failure V-1069
 * and V-1070 were both corrected for.
 */
const SURFACES = [
  'packages/sdk-python/src/driftstack/resources/auth.py',
  'packages/sdk-typescript/src/resources/auth.ts',
  'packages/sdk-go/auth.go',
  'apps/server/tests/unit/sdk-python-resources-auth-content-parity.test.ts',
  'apps/server/tests/unit/sdk-typescript-resources-auth-content-parity.test.ts',
  'apps/server/tests/unit/sdk-go-auth-content-parity.test.ts',
] as const;

/**
 * The OAuth field names the SESSION surface does not have.
 *
 * V-1108 — scope matters here, and the V-1092 write-up overstated it. These
 * words are not absent from the product: `/v1/oauth/revoke` accepts
 * `token_type_hint: z.enum(['access_token', 'refresh_token'])` per RFC 7009,
 * and `lib/oauth-client-exchange.ts` reads `refresh_token` off an upstream
 * provider's token response. Both are correct usage of someone else's
 * vocabulary. What does not exist is a Driftstack SESSION refresh token —
 * `/v1/auth/refresh` takes one opaque `token` and returns a session.
 *
 * So this list is applied only to SURFACES above, none of which expose an
 * OAuth-provider method today. If an SDK ever adds `oauth.revoke(...)`, its
 * `token_type_hint` argument is legitimate and belongs on that surface: widen
 * the exemption rather than renaming the RFC field.
 */
const ABSENT_FIELDS = ['refresh_token', 'access_token'] as const;

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

describe('V-1092 the session token is not an OAuth token pair', () => {
  it('CRITICAL the request schemas carry exactly one key each, which is what makes the OAuth vocabulary wrong. If a refresh-token grant is ever built these shapes gain a key, and the arm below should stop objecting rather than be edited around.', () => {
    expect(Object.keys(RefreshSessionRequestSchema.shape), 'refresh request keys').toEqual([
      'token',
    ]);
    expect(Object.keys(LogoutRequestSchema.shape), 'logout request keys').toEqual(['token']);
  });

  it('CRITICAL every surface that describes the contract was actually read. A path that moved leaves this file asserting a vocabulary over nothing, and the report reads identically to a clean sweep.', () => {
    for (const rel of SURFACES) {
      const body = read(rel);
      expect(body.length, `${rel} is empty or unreadable`).toBeGreaterThan(200);
      expect(body, `${rel} no longer mentions the refresh route it is listed for`).toMatch(
        /auth\/refresh/,
      );
    }
  });

  it('CRITICAL no SDK auth surface or auth pin names an OAuth token field the product does not have. The wrong description is the plausible one — every OAuth surface a developer has met works that way, and the untyped Python body contradicts nothing — so this is re-derived rather than noticed. The only correct account of refresh is that one opaque session token is exchanged for another.', () => {
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        // The retraction in a pin title has to be able to name the wrong thing in
        // order to retract it, so lines carrying the finding id are exempt. Nothing
        // else may use these words.
        if (line.includes('V-1092')) return;
        for (const field of ABSENT_FIELDS) {
          if (line.includes(field)) offenders.push(`${rel}:${String(i + 1)} names ${field}`);
        }
      });
    }
    expect(
      offenders.sort(),
      'these describe the session surface as an OAuth token pair — the request schema carries ' +
        'one key, `token`, and refresh exchanges that single opaque token for a new one:',
    ).toEqual([]);
  });

  it('CRITICAL the logout surfaces say which token is revoked. The handler revokes the token in the BODY, not the session the call authenticated with, and the difference is the whole magic-link revoke-from-email flow — a customer told otherwise assumes it can only end the session it is calling from.', () => {
    expect(read('packages/sdk-go/auth.go') + read(SURFACES[5]), 'the Go surface').toMatch(
      /supplied|SUPPLIED/,
    );
    expect(
      read('packages/sdk-python/src/driftstack/resources/auth.py'),
      'the Python logout docstring no longer distinguishes the supplied token',
    ).toMatch(/revokes THAT token,\s*\n\s*not the session the call authenticated with/);
  });
});
