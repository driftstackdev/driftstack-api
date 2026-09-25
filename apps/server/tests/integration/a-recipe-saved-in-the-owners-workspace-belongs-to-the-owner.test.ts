// A recipe saved in the owner's workspace belongs to the owner (security sweep #15).
//
// POST /v1/recipes accepted any session the caller could access — for an admin
// member, the owner's sessions — but filed the recipe under the CALLER's account and
// ignored `X-Driftstack-Account` on create, list, detail and delete. So a recipe saved
// from the owner's session, in the owner's workspace, landed in the member's personal
// account: the owner never saw it, and it kept the owner's steps (and the encrypted
// values typed during them) after the member was removed from the team. The same
// route file already refuses exactly this cross-account copy for a continued chat.
//
// Now every recipe route acts in the workspace the header names:
//   - a recipe is saved from a session of THAT workspace and filed under it, judged by
//     its plan's recipe limit; a session of another account is not found (404);
//   - list, detail and delete read and change that workspace's recipes;
//   - in a teammate's workspace each needs the admin role, as agent sessions do: a
//     recipe is a saved copy of a session's steps.

import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWNER_ID = '00000000-0000-4000-8000-00000000d151';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000d152';
const OWNER_KEY_ID = '00000000-0000-4000-8000-00000000d153';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

interface Team {
  f: TestAppFixture;
  /** The owner's own key. */
  ownerKey: string;
  /** The member's own desktop key (the fixture key). */
  memberKey: string;
}

/**
 * A Free member of a paid owner's team, with the given role, signed in to the
 * desktop app (the key the device mint grants) — the usual team shape.
 */
async function team(role: 'admin' | 'member'): Promise<Team> {
  const f = await buildTestApp({
    enableAgentRuntime: true,
    tier: 'free',
    keyProvenance: 'cli_device',
    scopes: ['account_owner'],
  });
  f.authRepo.upsertAccount({
    id: OWNER_ID,
    email: 'recipe-owner@example.test',
    name: 'Recipe Owner',
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  f.authRepo.setTeamMemberships(f.accountId, [
    { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role },
  ]);
  const ownerKey = generateApiKey('test');
  f.authRepo.upsertApiKey({
    id: OWNER_KEY_ID,
    accountId: OWNER_ID,
    name: 'owner key',
    keyPrefix: keyPrefixFromPlaintext(ownerKey),
    keyHash: await hashApiKey(ownerKey),
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  return { f, ownerKey, memberKey: f.plaintext };
}

async function ownersSession(f: TestAppFixture): Promise<string> {
  if (f.agentSessionsRepo === undefined) throw new Error('the agent runtime is not wired');
  return (await f.agentSessionsRepo.create({ accountId: OWNER_ID, tokenBudgetTotal: 1000 })).id;
}

function as(key: string, inOwnersWorkspace = false): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    ...(inOwnersWorkspace ? { 'x-driftstack-account': `acc_${OWNER_ID}` } : {}),
  };
}

async function recipeIds(f: TestAppFixture, headers: Record<string, string>): Promise<string[]> {
  const res = await f.app.inject({ method: 'GET', url: '/v1/recipes', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id);
}

describe("a recipe saved in the owner's workspace belongs to the owner", () => {
  it("CRITICAL an admin member's save in the owner's workspace is filed under the owner, and the owner lists it", async () => {
    const t = await team('admin');
    fx = t.f;
    const session = await ownersSession(fx);

    const saved = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: as(t.memberKey, true),
      payload: { agent_session_id: session, label: 'Owner flow' },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const recipe = saved.json<{ id: string; account_id: string }>();
    // The recipe shape publishes the bare account id.
    expect(recipe.account_id).toBe(OWNER_ID);

    expect(await recipeIds(fx, as(t.ownerKey))).toEqual([recipe.id]);
    expect(await recipeIds(fx, as(t.memberKey, true))).toEqual([recipe.id]);
    // The member's own workspace holds none of the owner's recipes.
    expect(await recipeIds(fx, as(t.memberKey))).toEqual([]);

    const detail = await fx.app.inject({
      method: 'GET',
      url: `/v1/recipes/${recipe.id}`,
      headers: as(t.memberKey, true),
    });
    expect(detail.statusCode, detail.body).toBe(200);
  });

  it("CRITICAL a save in the member's own workspace from the owner's session is not found: no cross-account copy", async () => {
    const t = await team('admin');
    fx = t.f;
    const session = await ownersSession(fx);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: as(t.memberKey),
      payload: { agent_session_id: session, label: 'Copied out' },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(await recipeIds(fx, as(t.memberKey))).toEqual([]);
    expect(await recipeIds(fx, as(t.ownerKey))).toEqual([]);
  });

  it("an admin member deletes the owner's recipe in the owner's workspace, and a removed member reaches none of them", async () => {
    const t = await team('admin');
    fx = t.f;
    const [first, second] = [await ownersSession(fx), await ownersSession(fx)];
    const ids: string[] = [];
    for (const session of [first, second]) {
      const saved = await fx.app.inject({
        method: 'POST',
        url: '/v1/recipes',
        headers: as(t.memberKey, true),
        payload: { agent_session_id: session, label: 'Owner flow' },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      ids.push(saved.json<{ id: string }>().id);
    }

    const deleted = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/recipes/${ids[0]}`,
      headers: as(t.memberKey, true),
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await recipeIds(fx, as(t.ownerKey))).toEqual([ids[1]]);

    // Removed from the team: the owner's workspace is closed to them.
    fx.authRepo.setTeamMemberships(fx.accountId, []);
    await fx.authCache.invalidateAccount(fx.accountId);
    const after = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes',
      headers: as(t.memberKey, true),
    });
    expect(after.statusCode, after.body).toBe(403);
    expect(await recipeIds(fx, as(t.memberKey))).toEqual([]);
  });

  it("a recipe saved in the owner's workspace counts against the owner's plan, not the member's", async () => {
    const t = await team('admin');
    fx = t.f;
    // The member is Free (10 recipes); the owner's plan keeps far more.
    for (let i = 0; i < 11; i += 1) {
      const saved = await fx.app.inject({
        method: 'POST',
        url: '/v1/recipes',
        headers: as(t.memberKey, true),
        payload: { agent_session_id: await ownersSession(fx), label: `Flow ${i.toString()}` },
      });
      expect(saved.statusCode, `save ${i.toString()}: ${saved.body}`).toBe(201);
    }
  });

  it("a read-only member can neither save, list, read nor delete recipes in the owner's workspace", async () => {
    const t = await team('member');
    fx = t.f;
    const session = await ownersSession(fx);
    const save = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: as(t.memberKey, true),
      payload: { agent_session_id: session, label: 'Not mine to save' },
    });
    expect(save.statusCode, save.body).toBe(403);

    const owned = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: as(t.ownerKey),
      payload: { agent_session_id: session, label: "The owner's" },
    });
    expect(owned.statusCode, owned.body).toBe(201);
    const id = owned.json<{ id: string }>().id;

    for (const [method, url] of [
      ['GET', '/v1/recipes'],
      ['GET', `/v1/recipes/${id}`],
      ['DELETE', `/v1/recipes/${id}`],
    ] as const) {
      const res = await fx.app.inject({ method, url, headers: as(t.memberKey, true) });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
    }
    expect(await recipeIds(fx, as(t.ownerKey))).toEqual([id]);
  });
});
