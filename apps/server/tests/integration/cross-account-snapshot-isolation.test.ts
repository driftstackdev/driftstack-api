// Account B cannot reach account A's profile snapshot.
//
// Measured like the other resources, and profile snapshots came out at ZERO:
// neutralising both account predicates in the snapshots repo (together with the
// recipes one) reds a single test in the whole integration suite, and that test
// is `recipes-routes`. Nothing anywhere covered snapshot ownership.
//
// A snapshot is a point-in-time copy of a browser profile — cookies, storage,
// the logged-in state of whatever the customer was using. Handing one to
// another account is equivalent to handing over the sessions inside it.
//
// Coverage tally for the rest of the surface, so nobody re-measures: sessions,
// profiles and agent sessions have their own suites; webhooks and api-keys are
// already well covered (23 tests notice when their predicates are disabled), so
// no suite was added for them rather than adding redundant ones.

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

/** Full rights over B's OWN account, so the scope gate cannot mask ownership. */
const FULL_SCOPES = ['read', 'write', 'account_owner'] as const;

const SNAPSHOT_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST' | 'DELETE';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'DELETE', suffix: '' },
  { method: 'POST', suffix: '/restore', payload: { name: 'restored-by-b' } },
];

async function seedSnapshotOwnedByA(fixture: TestAppFixture): Promise<string> {
  const profile = await fixture.app.inject({
    method: 'POST',
    url: '/v1/profiles',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { name: 'snapshot-owner' },
  });
  expect(profile.statusCode, 'account A must be able to create a profile').toBe(200);
  const profileId = profile.json<{ id: string }>().id;

  const snap = await fixture.app.inject({
    method: 'POST',
    url: `/v1/profiles/${profileId}/snapshots`,
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { label: 'owned-by-a' },
  });
  expect(
    [200, 201],
    `snapshot create returned ${snap.statusCode}: ${snap.body.slice(0, 200)}`,
  ).toContain(snap.statusCode);
  return snap.json<{ id: string }>().id;
}

describe("account B cannot reach account A's profile snapshot", () => {
  it.each(
    SNAPSHOT_ROUTES.map((r) => [`${r.method} /v1/profile-snapshots/:id${r.suffix}`, r] as const),
  )(
    'CRITICAL %s refuses an unrelated account. A snapshot carries the cookies and logged-in state of a browser profile, so a 2xx here hands another customer those sessions.',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder' });
      const snapshotId = await seedSnapshotOwnedByA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@snapshot-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/profile-snapshots/${snapshotId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/profile-snapshots/:id${route.suffix} returned ${res.statusCode} for an unrelated account`,
      ).toBe(404);
    },
  );
});
