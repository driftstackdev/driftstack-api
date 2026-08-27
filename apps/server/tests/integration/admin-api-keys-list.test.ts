// V-193 — integration tests for GET /v1/admin/api-keys cross-account list.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture, plaintext?: string): { authorization: string } => ({
  authorization: `Bearer ${plaintext ?? fixture.plaintext}`,
});

interface AdminKeyRow {
  id: string;
  account_id: string;
  revoked_at: string | null;
}

interface ListResponse {
  data: AdminKeyRow[];
  next_cursor: string | null;
}

describe('GET /v1/admin/api-keys', () => {
  it('200 lists keys across all accounts when called by admin', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await seedAdditionalAccount(fx, {
      accountId: '00000000-0000-4000-8000-0000000000b1',
      apiKeyId: '00000000-0000-4000-8000-0000000000b2',
      tier: 'team_manual',
      email: 'second@driftstack.local',
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    const accountIds = new Set(body.data.map((r) => r.account_id));
    expect(accountIds.size).toBeGreaterThanOrEqual(2);
  });

  it('filters by revoked=false to exclude revoked keys', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys?revoked=false',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListResponse>();
    expect(body.data.every((k) => k.revoked_at === null)).toBe(true);
  });

  it('rejects without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/api-keys',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── the OTHER prefixed-id parser design, and why this arm exists ──────────
//
// Two designs for one rule live in this codebase, and the census grouped them
// together because their conditions normalise alike:
//
//   A  `PROFILE_ID_RE = /^prof_(<uuid>)$/`   — the prefix is IN the regex.
//      A wrong prefix simply does not match. There is no separate clause, so
//      there is nothing to drop. Used by routes/profiles.ts and routes/team.ts.
//
//   B  `PUBLIC_ID_RE = /^[a-z]{3}_(<uuid>)$/` plus
//      `value.startsWith(`${expectedPrefix}_`)` — the regex deliberately accepts
//      ANY three-letter prefix, so correctness rests on the second condition.
//      Used by the admin routes (and, until it was covered, routes/webhooks.ts).
//
// ⚠️ Measured: dropping the clause from routes/admin.ts and from this file left
// the admin + profiles + team integration set (481 tests) entirely green. Design
// B carries a failure mode Design A cannot have, and at these sites nothing was
// watching it.
//
// Here that means an `acc_` filter is the only thing keeping this staff listing
// scoped to an ACCOUNT id. A `key_<uuid>` accepted in its place is a uuid that
// exists — it addresses an api-key row — so the query is not malformed, it is
// pointed at the wrong table's identifier.
//
// LEDGER — control 5/5:
//
//   prefix clause dropped                     1 red
//   prefix compared to the value's own slice  1 red
describe('admin api-key listing checks the id PREFIX, not just the shape', () => {
  const UUID = '00000000-0000-4000-8000-0000000000b1';

  it('CRITICAL 400 when account_id carries a non-acc prefix. The regex accepts any three-letter prefix, so this clause is the only thing tying the filter to an account id.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/api-keys?account_id=key_${UUID}`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Expected "acc_<uuid>"/);
  });

  it('the SAME uuid under the acc_ prefix is accepted, so the refusal above is the prefix and not the uuid', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/api-keys?account_id=acc_${UUID}`,
      headers: auth(fx),
    });
    expect(res.statusCode, res.body).toBe(200);
  });
  // V-2005 — the arm above refuses `not-an-id` (9 chars) and `key_<uuid>` (40), so it
  // never reached the branch that accepted a BARE uuid. That branch tested
  // `.length === 36`, and a length is not a shape: 36 dashes are 36 characters and
  // went straight into a Postgres `uuid` column, answering 500 where the boundary
  // owes 400. Both inputs here are EXACTLY 36 characters — that is the whole point
  // of them, and an arm that forgets it stops testing this the moment someone
  // "tidies" the literals.
  it('CRITICAL refuses a 36-character account_id that is not a uuid — the length that used to bypass the shape check', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    const dashes = '------------------------------------';
    const hexNoDashes = '0123456789abcdef0123456789abcdef0123';
    expect(dashes.length, 'the input must be 36 chars or it misses the branch').toBe(36);
    expect(hexNoDashes.length, 'the input must be 36 chars or it misses the branch').toBe(36);

    for (const bad of [dashes, hexNoDashes]) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/admin/api-keys?account_id=${bad}`,
        headers: auth(fx),
      });
      expect(res.statusCode, `36-char non-uuid "${bad}" must be a bad request, not a 500`).toBe(
        400,
      );
    }
  });
});
