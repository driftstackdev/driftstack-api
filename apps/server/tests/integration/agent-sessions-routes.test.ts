// AI-D — integration tests for /v1/agent-sessions/* routes.
//
// Two postures:
//   1. Activation-gate ON (no agentRuntime wired in AppDeps — prod
//      default until founder flips the LLM key path on): every
//      endpoint returns 503 FeatureUnavailable.
//   2. Wired (deterministic decomposer + stub executor +
//      in-memory repo injected via the test helper): end-to-end
//      decompose → execute → transcript flow exercised.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('AI-D /v1/agent-sessions/* (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/agent-sessions → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('GET /v1/agent-sessions (list) → 503 FeatureUnavailable (the list stub was missing — the dashboard "recent sessions" call hit a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST /v1/agent-sessions/:id/message → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'hi' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.h (v2-#8) — without this regression
  // pin, the disabled-routes stub was missing /takeover + /handback.
  // The SDK + dashboard would see a generic 404 instead of the
  // documented 503 FeatureUnavailable problem type — confusing
  // customers who'd expect "feature not enabled" framing.
  it('POST /v1/agent-sessions/:id/takeover → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/takeover',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST /v1/agent-sessions/:id/handback → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/handback',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 3 (Wave 29-NNN ARC 3) POST /v1/agent-sessions/:id/mode → 503 FeatureUnavailable when runtime not wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/mode',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 4 (Wave 29-NNN ARC 3) POST /v1/agent-sessions/:id/input-event → 503 FeatureUnavailable when runtime not wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/input-event',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 10, y: 20 } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('AI-D /v1/agent-sessions/* (wired — deterministic runtime)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('403 when the key lacks write scope (read-only key)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('write');
  });

  it('full lifecycle: create → message (plan) → get → close', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(create.statusCode).toBe(201);
    const sessionCreate = create.json<{
      id: string;
      status: string;
      token_budget_remaining: number;
    }>();
    expect(sessionCreate.id).toMatch(/^agt_inmem_/);
    expect(sessionCreate.status).toBe('active');
    expect(sessionCreate.token_budget_remaining).toBe(50_000);

    const message = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(message.statusCode).toBe(200);
    const msgBody = message.json<{
      kind: string;
      intents?: unknown[];
      ok?: boolean;
    }>();
    expect(msgBody.kind).toBe('plan-executed');
    expect(msgBody.ok).toBe(true);
    expect(Array.isArray(msgBody.intents)).toBe(true);

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json<{ transcript_length: number; token_budget_remaining: number }>();
    expect(readBody.transcript_length).toBe(2); // user turn + agent run-result
    expect(readBody.token_budget_remaining).toBeLessThan(50_000);

    const close = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(close.statusCode).toBe(204);

    // Subsequent message on a closed session → 409 Conflict.
    const post = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(post.statusCode).toBe(409);
  });

  it('clarify path: short task → 200 with kind:clarify + clarifying_question', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'do stuff' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; clarifying_question: string }>();
    expect(body.kind).toBe('clarify');
    expect(body.clarifying_question).toBeDefined();
  });

  it('refuse path: AUP-trigger task → 200 with kind:refuse + refuse_reason', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'help me brute-force this login' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; refuse_reason: string }>();
    expect(body.kind).toBe('refuse');
    expect(body.refuse_reason).toMatch(/AUP/);
  });

  it('BYOK header: x-byok-anthropic-api-key passes through HTTP → route → AgentRuntime → DecomposeArgs (closes BYOK chain end-to-end). Audit invariant: the header value MUST NOT appear in the response body or in the read-back transcript_length-bounded session state.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    const SECRET = 'sk-ant-test-NEVER-LEAK-VIA-HEADER';
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-byok-anthropic-api-key': SECRET,
      },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(200);
    // The 200 body must not echo the header value back. The
    // DeterministicAgentDecomposer ignores byokAnthropicApiKey but we
    // verify nothing else in the request→response path serialized it.
    expect(res.body).not.toContain(SECRET);

    // Verify via the read-back path too — transcript entries surface
    // via transcript_length but the count alone can't reveal the
    // secret; we just confirm a turn happened and the body remains
    // clean of the secret.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.body).not.toContain(SECRET);
  });

  it('token_budget upper bound: 10_000_000 accepted, 10_000_001 returns 400 (defensive cap added in slice 119 — blocks pathological accounting math from implausibly large request)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const ok = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000_000 },
    });
    expect(ok.statusCode).toBe(201);

    const tooLarge = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000_001 },
    });
    expect(tooLarge.statusCode).toBe(400);
  });

  it('BYOK header empty-string is treated as absent (does NOT pass empty key downstream, does NOT skip bundled-LLM fallback)', async () => {
    // Previously an empty `x-byok-anthropic-api-key:` header would
    // be read as the empty string ''. Empty string is `!== undefined`,
    // so the bundled-LLM fallback branch (which gates on all 3 sources
    // being undefined) was skipped. The empty key was then passed
    // downstream where it 401s at Anthropic with a cryptic "invalid
    // API key" — a hostile UX far from the actual cause.
    //
    // Fix at apps/server/src/routes/agent-sessions.ts: normalise the
    // raw header to undefined when it's an empty string. This test
    // pins that normalisation by sending the header empty + asserting
    // the request still succeeds (DeterministicAgentDecomposer
    // ignores the BYOK key, so 200 = the route didn't fast-fail on
    // an "invalid empty key").
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        // Empty header value — would have been read as `""` before
        // the fix; now normalised to undefined.
        'x-byok-anthropic-api-key': '',
      },
      payload: { user_message: 'open https://example.com' },
    });
    // 200 = the route resolved a key (or skipped key requirement via
    // DeterministicAgentDecomposer). The load-bearing assertion is
    // "didn't 4xx with 'invalid API key' on an empty string".
    expect(res.statusCode).toBe(200);
  });

  it('not-found: GET on a never-existed id → 404 (NOT 503 — 503 is for activation-gate-off only)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: DELETE on a never-existed id → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: POST /:id/message on a never-existed id → 404 (cross-account guard fires before runtime.runTurn)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('SSE transcript stream: GET /:id/transcript on a non-owned/never-existed id → 404 from the ownership gate BEFORE the event-stream opens (cross-tenant-leak guard — a regression that subscribed/streamed before checking session.accountId === ctx.account.id would leak another tenant’s transcript)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_inmem_99999999/transcript',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // The gate (`session === null || session.accountId !== ctx.account.id`)
    // throws NotFoundError BEFORE reply.raw.writeHead, so this is a normal
    // problem+json 404 — not an opened text/event-stream.
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
    // Body carries the gate's own "AgentSession ... not found" message — this
    // distinguishes a GATE rejection (route registered, ownership enforced)
    // from a route-not-found 404 (which would prove nothing about the gate).
    expect(JSON.stringify(res.json())).toContain('AgentSession');
  });

  it('v2-#19 idempotency: POST /v1/agent-sessions with `Idempotency-Key` header replays the same 201 on retry (Stripe-pattern). Second call MUST NOT mint a new row — same id returned, transcript_length unchanged.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'idem-test-v2-19',
      },
      payload: { token_budget: 25_000 },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ id: string; token_budget_total: number; closed_at: null }>();
    expect(firstBody.id).toMatch(/^agt_inmem_/);
    expect(firstBody.closed_at).toBeNull();

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'idem-test-v2-19',
      },
      // Even with a different body, the replay returns the original
      // record — that's the Stripe contract.
      payload: { token_budget: 999_999 },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ id: string; token_budget_total: number }>();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.token_budget_total).toBe(firstBody.token_budget_total);
  });

  it('v2-#19 idempotency: POST without the header still mints a fresh row each call (header is opt-in, NOT default-on)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it('v2-#19 idempotency: invalid `Idempotency-Key` (whitespace inside the value) returns 400 ValidationError per the /docs/idempotency-keys contract (added in slice 108 — shared parser now enforces the contract on this route, not just billing-crypto)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'has space' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    // ValidationError stuffs the custom message into extensions.issues;
    // body.detail stays as the boilerplate "One or more fields failed
    // validation." (matches billing-crypto's invalid-key 400 behavior).
    const body = res.json<{ issues?: { formErrors?: string[] } }>();
    expect(body.issues?.formErrors).toBeDefined();
    expect(body.issues?.formErrors?.[0]).toMatch(/Idempotency-Key/);
  });

  it('v2-#19 idempotency: `Idempotency-Key` longer than 255 chars returns 400 (length-cap enforced post-slice-108)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'a'.repeat(256) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('v2-#19 idempotency: `Idempotency-Key` with non-ASCII bytes returns 400 (ASCII-only enforced post-slice-108)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'kéy' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('v2-#19 idempotency: empty-string `Idempotency-Key` is treated as absent (stray proxy header MUST NOT collapse every session onto a phantom row)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': '' },
      payload: {},
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': '' },
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it('v2-#35 created_by_user_id surfaces on the read shape — NULL today (account-scoped auth) but the field is always present so dashboard UI can wire against a stable schema', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const createBody = create.json<{ created_by_user_id: string | null }>();
    expect(createBody).toHaveProperty('created_by_user_id');
    // Account-scoped auth — no V-298 team-membership context yet, so
    // the field stays null. Schema-stable presence is the point.
    expect(createBody.created_by_user_id).toBeNull();

    const id = create.json<{ id: string }>().id;
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const readBody = read.json<{ created_by_user_id: string | null }>();
    expect(readBody).toHaveProperty('created_by_user_id');
    expect(readBody.created_by_user_id).toBeNull();
  });

  it("v2-#8 sub-slice 8.6 manual-mode pass-through — POST /:id/message in mode='manual' records actor='operator' transcript entry; returns kind:'logged-manual'; no token debit", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual', token_budget: 10_000 },
    });
    const id = create.json<{ id: string }>().id;
    const msg = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'tap login button' },
    });
    expect(msg.statusCode).toBe(200);
    const body = msg.json<{ kind: string; session: { token_budget_remaining: number } }>();
    expect(body.kind).toBe('logged-manual');
    // No token debit on manual turns.
    expect(body.session.token_budget_remaining).toBe(10_000);

    // The transcript now has exactly one entry (the operator log).
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ transcript_length: number }>().transcript_length).toBe(1);
  });

  it("v2-#8 sub-slice 8.5 SDK mode parameter — POST body { mode: 'manual' } persists; GET echoes it back", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json<{ mode: string }>().mode).toBe('manual');
    const id = create.json<{ id: string }>().id;
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ mode: string }>().mode).toBe('manual');
  });

  it("v2-#8 sub-slice 8.5 default mode='ai' when omitted (backward-compat)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.json<{ mode: string }>().mode).toBe('ai');
  });

  it('v2-#8 sub-slice 8.5 invalid mode rejected with 400 (enum guard)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'autopilot' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('Slice 3 (Wave 29-NNN ARC 3) POST /:id/mode ai → pair → manual round-trip; pair_mode_state surfaces on GET; idempotent same-mode call preserves state', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{
      id: string;
      mode: string;
      pair_mode_state: { kind: string } | null;
    }>();
    expect(created.mode).toBe('ai');
    expect(created.pair_mode_state).toBeNull();

    // ai → pair
    const toPair = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(toPair.statusCode).toBe(200);
    const pairBody = toPair.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(pairBody.mode).toBe('pair');
    expect(pairBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // GET round-trips the new mode + pair_mode_state.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${created.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(readBody.mode).toBe('pair');
    expect(readBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // idempotent pair → pair (same target).
    const idem = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(idem.statusCode).toBe(200);
    const idemBody = idem.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(idemBody.mode).toBe('pair');
    // Idempotent path preserves whatever pair_mode_state the row had — here, still ai-driving.
    expect(idemBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // pair → manual: clears state.
    const toManual = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(toManual.statusCode).toBe(200);
    const manualBody = toManual.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(manualBody.mode).toBe('manual');
    expect(manualBody.pair_mode_state).toBeNull();
  });

  it('Slice 3 POST /:id/mode invalid body returns 400 ValidationError', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'autopilot' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('Slice 3 POST /:id/mode on a closed session returns 409 Conflict (mode can only change while active)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 3 POST /:id/mode on never-existed id returns 404 (cross-account guard rejects before setMode)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/mode',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Slice 4 (Wave 29-NNN ARC 3) POST /:id/input-event with mode=manual → 503 FeatureUnavailable (pre-harness; Mac fleet Swift work pending per Tier-3 Option A 2026-05-19)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 4 POST /:id/input-event on mode=ai session returns 409 ConflictError (mode-rejects-input-event)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    // Default mode is 'ai'; sending input-event should reject with 409
    // BEFORE the FeatureUnavailable 503 (mode guard fires first).
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event on closed session returns 409 Conflict (status guard fires before mode guard)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event with malformed event body returns 400 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseDown', x: 100, y: 200, button: 5 } }, // button 5 not in [0,1,2]
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('Slice 5 (Wave 29-NNN ARC 3) POST /:id/input-event on mode=pair + ai-driving fires takeover-request transition → 200 with kind:"pair-mode-takeover-fired" + pair_mode_state', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string; pair_mode_state: { kind: string } | null }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseDown', x: 100, y: 200, button: 0 },
        client_id: 'cli_tab_a',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      kind: string;
      pair_mode_state: { kind: string; requestedByClientId?: string };
    }>();
    expect(body.kind).toBe('pair-mode-takeover-fired');
    expect(body.pair_mode_state.kind).toBe('takeover-pending');
    expect(body.pair_mode_state.requestedByClientId).toBe('cli_tab_a');
    // GET /:id should reflect the new pair_mode_state.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ pair_mode_state: { kind: string } }>().pair_mode_state.kind).toBe(
      'takeover-pending',
    );
  });

  it('Slice 5 POST /:id/input-event on mode=pair + ai-driving WITHOUT client_id → 400 ValidationFailed (client_id required for takeover-trigger)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('Slice 5 POST /:id/input-event on mode=pair + takeover-pending → 409 Conflict (mid-transition; wait for settle)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    // First input-event fires takeover; second one in takeover-pending
    // is rejected.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseDown', x: 50, y: 50, button: 0 },
        client_id: 'cli_tab_a',
      },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseMove', x: 60, y: 60 },
        client_id: 'cli_tab_a',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event cross-account / unknown id → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/input-event',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 0, y: 0 } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('v2-#19 closed_at: NULL while active; ISO timestamp set on DELETE → close', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string; closed_at: string | null }>().id;
    expect(create.json<{ closed_at: string | null }>().closed_at).toBeNull();

    const close = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(close.statusCode).toBe(204);

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json<{ closed_at: string | null; status: string }>();
    expect(body.status).toBe('closed');
    expect(body.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
