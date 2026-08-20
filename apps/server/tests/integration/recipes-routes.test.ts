// AI-B4 — integration tests for POST /v1/recipes.
//
// Two postures:
//   1. Wired (recipesRepo + agentSessionsRepo both in AppDeps via
//      the test fixture) — the route fires + snapshots the source
//      agent-session.
//   2. Cross-account auth check — the source agent_session_id must be a
//      session the caller can ACCESS: one their own account owns, or one
//      owned by a team they hold admin on. Anything else is a 404 (no
//      existence disclosure).
//
// V-1101 — this said "must belong to the calling account", the claim V-812
// retracted from the customer docs and the TypeScript SDK. It survived here
// because the sweep that fixed those greppped the doc surfaces, and this is
// a test header. The route gates on callerCanAccessAgentSession, so a team
// admin snapshotting the owner's session gets a 201.
//
// POST (create) + GET (list + detail) + DELETE are wired; recipe
// EXECUTION stays v1.1 (harness-executor-gated). These tests exercise
// the create + list + get/delete surfaces.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('AI-B4 POST /v1/recipes — wired', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createAgentSession(opts?: { mode?: 'ai' | 'manual' | 'pair' }): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: opts?.mode !== undefined ? { mode: opts.mode } : {},
    });
    return res.json<{ id: string }>().id;
  }

  it('CRITICAL a malformed pagination query is refused rather than silently coerced. Coverage showed this refusal executed by no test while the `if` guarding it ran 9 times — the surrounding handler is heavily exercised, so the file reads as covered while the only check on a caller-supplied `limit` never fires. `limit` is bounded 1..100 with a default of 50, so a zero, an over-cap value or a non-number each fail the parse.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    for (const [label, qs] of [
      ['a limit below the floor', '?limit=0'],
      ['a limit past the cap', '?limit=999'],
      ['a non-numeric limit', '?limit=abc'],
      ['an empty cursor', '?cursor='],
    ] as const) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/recipes${qs}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode, `${label} is refused`).toBe(400);
    }
    // And a well-formed query is still served, so the arm refuses malformed input
    // rather than everything.
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes?limit=5',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ok.statusCode, 'a valid limit is accepted').toBe(200);
  });

  it('happy path: snapshots a fresh agent-session into a recipe, returns intent_count=0 + 201', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        agent_session_id: agentSessionId,
        label: 'my first recipe',
        description: 'snapshot of the example.com flow',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      account_id: string;
      agent_session_id: string;
      label: string;
      description: string;
      intent_count: number;
    }>();
    expect(body.id).toMatch(/^rec_inmem_/);
    expect(body.agent_session_id).toBe(agentSessionId);
    expect(body.label).toBe('my first recipe');
    expect(body.description).toBe('snapshot of the example.com flow');
    expect(body.intent_count).toBe(0);
  });

  // Item 6 — the wiring, not the helper. The helper has its own unit arms, but
  // nothing notices if a ROUTE stops calling it: silent stripping and reporting
  // produce identical bodies and status codes, so only a header assertion can
  // tell them apart.
  it('CRITICAL reports a mistyped field on create, and says nothing when all are known', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();

    const typo = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'r1', descrption: 'mistyped' },
    });
    // Unchanged for the caller — reporting, not rejecting.
    expect(typo.statusCode).toBe(201);
    expect(typo.headers['x-driftstack-unknown-fields']).toBe('descrption');

    const clean = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'r2', description: 'spelled right' },
    });
    expect(clean.statusCode).toBe(201);
    expect(clean.headers['x-driftstack-unknown-fields']).toBeUndefined();
  });

  it('403 when the key lacks write scope (read-only key)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: 'ags_whatever', label: 'x' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('write');
  });

  it('description omitted → recipe.description is null on the wire', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'unlabelled' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ description: string | null }>().description).toBeNull();
  });

  it('snapshots after a real plan-executed turn — intent_count reflects the flattened intent_log', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    // Drive a real turn so the transcript has a plan-executed entry
    // with structured intents. Deterministic decomposer parses
    // "open <url> and capture" as [navigate, capture] = 2 intents.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${agentSessionId}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'flow-with-intents' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ intent_count: number }>().intent_count).toBeGreaterThan(0);
  });

  // V-736 — a team ADMIN who launched a session ON the owner must be able to
  // snapshot it as a recipe.
  //
  // Both recipes routes hand-rolled `source.accountId !== ctx.account.id`, the
  // last two raw owner-equality sites in routes/. Every agent-session route uses
  // callerCanAccessAgentSession instead, and its own comment records this exact
  // bug being fixed across the rest of that surface: "a team admin who launched
  // on an owner was locked out of every session-scoped route because they all
  // compared against ctx.account.id only". So the admin could read the session,
  // stream its entire transcript and delete it — but got a bare 404 when saving
  // it as a recipe.
  //
  // Fails CLOSED (a 404, nothing leaked), so this is availability, not exposure.
  it('a team admin can snapshot a session they launched on the OWNER', async () => {
    const RECIPE_OWNER_ID = '00000000-0000-4000-8000-000000000e01';
    fx = await buildTestApp({ enableAgentRuntime: true });
    fx.authRepo.upsertAccount({
      id: RECIPE_OWNER_ID,
      email: 'owner-recipes@driftstack.local',
      name: 'Owner',
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-000000000e02',
        ownerAccountId: RECIPE_OWNER_ID,
        role: 'admin',
      },
    ]);
    const teamHeaders = {
      authorization: `Bearer ${fx.plaintext}`,
      'x-driftstack-account': `acc_${RECIPE_OWNER_ID}`,
    };

    // Launch on the OWNER — the create route honours the header, so the session
    // row is filed under the owner, not the acting member.
    const launched = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: teamHeaders,
      payload: {},
    });
    expect(launched.statusCode).toBe(201);
    const agentSessionId = launched.json<{ id: string }>().id;

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { ...teamHeaders, 'content-type': 'application/json' },
      payload: { agent_session_id: agentSessionId, label: 'owners flow' },
    });

    // Was a bare 404 for a session this caller launched.
    expect(res.statusCode).toBe(201);
  });

  it('a NON-admin member still gets a 404 — the predicate widens for admins only', async () => {
    const RECIPE_OWNER_ID = '00000000-0000-4000-8000-000000000e03';
    fx = await buildTestApp({ enableAgentRuntime: true });
    // A session that genuinely belongs to the OWNER, seeded directly.
    const owned = await fx.agentSessionsRepo!.create({
      accountId: RECIPE_OWNER_ID,
      tokenBudgetTotal: 50_000,
    });
    // Member role, not admin: callerCanAccessAgentSession must still refuse.
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-000000000e04',
        ownerAccountId: RECIPE_OWNER_ID,
        role: 'member',
      },
    ]);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { agent_session_id: `agt_${owned.id}`, label: 'not mine' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-account: agent_session_id belongs to another account → 404 (no existence disclosure)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    // Use a forged session id that doesn't exist anywhere.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: 'agt_not_owned', label: 'snooped' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/agent-sessions/:id/recipe-suggestion — real wired path: derives a label/description from a real plan-executed turn', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${agentSessionId}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${agentSessionId}/recipe-suggestion`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      suggested_label: string;
      suggested_description: string;
      intent_count: number;
    }>();
    expect(body.suggested_label).toContain('example.com');
    expect(body.intent_count).toBeGreaterThan(0);
  });

  it('GET recipe-suggestion cross-account → 404 (no existence disclosure)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_not_owned/recipe-suggestion',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('validation: missing label → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validation: label exceeds 120 chars → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'a'.repeat(121) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validation: description exceeds 2000 chars → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        agent_session_id: agentSessionId,
        label: 'too long',
        description: 'x'.repeat(2001),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('auth required: missing bearer → 401', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      payload: { agent_session_id: 'agt_anything', label: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validation: agent_session_id exceeds 100 chars → 400 (defensive cap added in slice 116 — prevents problem+json body bloat on the NotFoundError path)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        // Canonical agent_session_id is 40 chars; in-memory test
        // fixtures use ~19 chars. 1KB is clearly out of bounds.
        agent_session_id: 'agt_' + 'a'.repeat(1024),
        label: 'should reject',
      },
    });
    expect(res.statusCode).toBe(400);
    // The validation issue mentions the agent_session_id field
    // (extension.issues.fieldErrors carries the per-field detail).
    const body = res.json<{ issues?: { fieldErrors?: Record<string, string[]> } }>();
    expect(body.issues?.fieldErrors?.agent_session_id).toBeDefined();
  });
});

// Arc 4 Wave 2.B sub-slice 8.20.l (v2-#8) — activation gate posture
// pin for recipes. The route requires BOTH recipesRepo +
// agentSessionsRepo wired in AppDeps; the test fixture wires
// recipesRepo unconditionally but agentSessionsRepo only when
// enableAgentRuntime: true. Without enableAgentRuntime the route
// MUST surface the 503 stub so the SDK + dashboard get a machine-
// readable "not yet enabled" signal vs a generic 404.
describe('AI-B4 POST /v1/recipes — disabled stub (no agentSessionsRepo)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST → 503 FeatureUnavailable when enableAgentRuntime is off', async () => {
    fx = await buildTestApp(); // no enableAgentRuntime
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: 'agt_anything', label: 'x' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toMatch(/feature-unavailable/);
  });
});

describe('V-530.I GET /v1/recipes — list (wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function seedRecipe(label: string): Promise<void> {
    const session = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const agentSessionId = session.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label },
    });
    if (res.statusCode !== 201) throw new Error(`seed failed: ${res.statusCode}`);
  }

  it('empty account → { data: [], has_more: false, next_cursor: null }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; has_more: boolean; next_cursor: string | null }>();
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('lists saved recipes with the metadata shape (set-wise — within-same-ms order is the id-keyset tiebreak, not insertion)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    await seedRecipe('alpha');
    await seedRecipe('beta');
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; label: string; intent_count: number; created_at: string }>;
      has_more: boolean;
    }>();
    expect(body.data).toHaveLength(2);
    expect(new Set(body.data.map((r) => r.label))).toEqual(new Set(['alpha', 'beta']));
    expect(body.data[0]!.id).toMatch(/^rec_inmem_/);
    expect(typeof body.data[0]!.intent_count).toBe('number');
    expect(typeof body.data[0]!.created_at).toBe('string');
    expect(body.has_more).toBe(false);
  });

  it('paginates via limit + cursor — complete + gap-free across pages', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    await seedRecipe('one');
    await seedRecipe('two');
    await seedRecipe('three');
    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes?limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const firstBody = first.json<{
      data: Array<{ label: string }>;
      has_more: boolean;
      next_cursor: string;
    }>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.has_more).toBe(true);

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/recipes?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const secondBody = second.json<{ data: Array<{ label: string }>; has_more: boolean }>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.has_more).toBe(false);

    // The two pages together cover all 3 recipes with no overlap (the
    // keyset guarantee — stable + gap-free even with tied timestamps).
    const allLabels = [...firstBody.data, ...secondBody.data].map((r) => r.label);
    expect(new Set(allLabels)).toEqual(new Set(['one', 'two', 'three']));
    expect(allLabels).toHaveLength(3);
  });
});

describe('V-530.J GET + DELETE /v1/recipes/:id (wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createRecipe(label: string): Promise<string> {
    const session = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const agentSessionId = session.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label },
    });
    return res.json<{ id: string }>().id;
  }

  it('GET /:id returns the public recipe including intent_log', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createRecipe('detail me');
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/recipes/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; label: string; intent_log: unknown[] }>();
    expect(body.id).toBe(id);
    expect(body.label).toBe('detail me');
    expect(Array.isArray(body.intent_log)).toBe(true);
  });

  it('GET /:id redacts sensitive type values for an ordinary read-only key', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'api_builder' });
    const session = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const agentSessionId = session.json<{ id: string }>().id;
    const agentSessionsRepo = fx.agentSessionsRepo;
    if (agentSessionsRepo === undefined) throw new Error('agent sessions repo was not wired');
    await agentSessionsRepo.appendTranscript(agentSessionId, {
      at: '2026-07-13T14:30:00.000Z',
      role: 'agent',
      body: 'plan executed',
      intents: [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: 'integration-password-secret',
          sensitive: true,
        },
        {
          kind: 'interact',
          action: 'type',
          selector: '[name=otp]',
          value: '681204',
          sensitive: false,
        },
        { kind: 'interact', action: 'type', selector: '#username', value: 'public-user' },
      ],
    });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'sensitive detail' },
    });
    const id = created.json<{ id: string }>().id;
    const readOnlyKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'recipe-reader', scopes: ['read'] },
    });
    expect(readOnlyKey.statusCode).toBe(201);
    const readOnlyPlaintext = readOnlyKey.json<{ plaintext: string }>().plaintext;
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/recipes/${id}`,
      headers: { authorization: `Bearer ${readOnlyPlaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ intent_log: unknown[] }>().intent_log).toEqual([
      { kind: 'interact', action: 'type', selector: '#password', sensitive: true },
      { kind: 'interact', action: 'type', selector: '[name=otp]', sensitive: true },
      { kind: 'interact', action: 'type', selector: '#username', value: 'public-user' },
    ]);
    expect(res.payload).not.toContain('integration-password-secret');
    expect(res.payload).not.toContain('681204');
  });

  it('GET /:id → 404 for an unknown id', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/recipes/rec_inmem_does_not_exist',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /:id removes the recipe (204), then GET → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createRecipe('delete me');
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/recipes/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);
    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/recipes/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(after.statusCode).toBe(404);
  });

  it('DELETE /:id → 404 for an unknown id', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/recipes/rec_inmem_missing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /:id → 403 with a read-only key (mutation requires write)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/recipes/rec_inmem_anything',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
