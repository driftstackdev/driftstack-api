// Security sweep 2026-09-24, finding #7 — POST /v1/recipes stored a full copy of
// the source session's transcript on every call, without limit.
//
// A recipe snapshots the session's transcript (up to 1 MiB, encrypted, so it does
// not compress) into a new row per call; nothing deduplicated saves of one
// session and nothing capped how many recipes an account keeps. The skeptic saved
// ONE session 60 times from a new free account: 60 rows, 19 MB, about 4-5 GB an
// hour per free account at the free `global` rate.
//
// Now a session is saved as ONE recipe: saving it again under another name is
// refused 409 (delete the first to save it again), and repeating the exact same
// save — a retry — returns the recipe already saved instead of a second copy. And
// an account keeps at most its plan's number of recipes (10 on free), refused
// with the tier-limit problem past that. Both are decided under one per-account
// lock in the repository, so concurrent saves cannot race past either.

import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const json = { 'content-type': 'application/json' };

const executed: TranscriptEntry = {
  at: '2026-09-24T08:00:00.000Z',
  role: 'agent',
  body: 'opened the pricing page',
  intents: [{ kind: 'navigate', url: 'https://example.com/pricing' }],
};

async function sessionWithSteps(): Promise<string> {
  const session = await fx.agentSessionsRepo!.create({
    accountId: fx.accountId,
    tokenBudgetTotal: 1000,
    seedTranscript: [executed],
  });
  return session.id;
}

async function save(
  agentSessionId: string,
  label: string,
  description?: string,
): Promise<{ status: number; body: { id?: string; detail?: string; type?: string } }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/recipes',
    headers: { ...json, authorization: `Bearer ${fx.plaintext}` },
    payload: {
      agent_session_id: agentSessionId,
      label,
      ...(description !== undefined ? { description } : {}),
    },
  });
  return { status: res.statusCode, body: res.json() };
}

async function storedRecipes(): Promise<number> {
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/recipes?limit=100',
    headers: { authorization: `Bearer ${fx.plaintext}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ data: unknown[] }>().data.length;
}

/** A free account holding only the desktop credential, which reaches POST /v1/recipes. */
async function freeDesktopAccount(): Promise<void> {
  fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device', enableAgentRuntime: true });
}

describe('a session is saved as one recipe, and an account keeps no more recipes than its plan allows', () => {
  it('CRITICAL saving ONE session 20 times under different names stores one recipe; every other save is refused 409 and stores nothing', async () => {
    await freeDesktopAccount();
    const sessionId = await sessionWithSteps();
    const statuses: number[] = [];
    let first: string | undefined;
    let refusal: { detail?: string; type?: string } | undefined;
    for (let i = 0; i < 20; i += 1) {
      const r = await save(sessionId, `copy ${String(i)}`);
      statuses.push(r.status);
      if (r.status === 201) first ??= r.body.id;
      else refusal = r.body;
    }
    expect(statuses).toEqual([201, ...Array<number>(19).fill(409)]);
    expect(await storedRecipes()).toBe(1);
    expect(refusal?.type).toBe('https://errors.driftstack.dev/conflict');
    expect(refusal?.detail).toBe(
      `This session is already saved as recipe ${first!}. Delete that recipe to save the session again.`,
    );
  });

  it('repeating the exact same save — a retry — answers with the recipe already saved, not a second copy', async () => {
    await freeDesktopAccount();
    const sessionId = await sessionWithSteps();
    const a = await save(sessionId, 'Check pricing', 'weekly');
    const b = await save(sessionId, 'Check pricing', 'weekly');
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(await storedRecipes()).toBe(1);
  });

  it('control: once that recipe is deleted, the session can be saved again', async () => {
    // A paid plan: the free desktop credential may save a recipe but not delete one
    // (DELETE /v1/recipes/:id is not on the free-desktop allow-list).
    fx = await buildTestApp({ tier: 'solo_manual', enableAgentRuntime: true });
    const sessionId = await sessionWithSteps();
    const a = await save(sessionId, 'first name');
    expect(a.status).toBe(201);
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/recipes/${a.body.id!}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);
    expect((await save(sessionId, 'second name')).status).toBe(201);
    expect(await storedRecipes()).toBe(1);
  });

  it('CRITICAL a free account keeps at most 10 recipes; the 11th is refused with the tier-limit problem and stores nothing', async () => {
    await freeDesktopAccount();
    const statuses: number[] = [];
    let refusal: { detail?: string; type?: string } | undefined;
    for (let i = 0; i < 12; i += 1) {
      const r = await save(await sessionWithSteps(), `task ${String(i)}`);
      statuses.push(r.status);
      if (r.status !== 201) refusal = r.body;
    }
    expect(statuses).toEqual([...Array<number>(10).fill(201), 429, 429]);
    expect(await storedRecipes()).toBe(10);
    expect(refusal?.type).toBe('https://errors.driftstack.dev/tier-limit');
    expect(refusal?.detail).toBe(
      'Your plan keeps up to 10 recipes, and this account has 10. Delete a recipe to save a new one.',
    );
  });

  it('control: a paid plan keeps more than the free plan does', async () => {
    fx = await buildTestApp({ tier: 'solo_manual', enableAgentRuntime: true });
    for (let i = 0; i < 11; i += 1) {
      expect((await save(await sessionWithSteps(), `task ${String(i)}`)).status).toBe(201);
    }
    expect(await storedRecipes()).toBe(11);
  });
});
