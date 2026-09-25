// A Free desktop user can delete a recipe it saved.
//
// The desktop app's browser sign-in mints a `cli_device` key, and on a Free account
// that key is bounded to FREE_DESKTOP_ALLOWED_ROUTES. The list carried recipe create,
// list and detail but not delete, so a Free user could save a recipe from the app and
// then never remove it: the delete answered 403 with the Free desktop refusal, and at
// the plan's recipe limit the only way to save another was a dashboard session.
//
// Driven through the real auth chain with the key the device mint grants. Every
// other refusal stays: the route next to it in the manifest that the app does not
// use is still refused.

import { afterEach, describe, expect, it } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

async function freeDesktopApp(): Promise<TestAppFixture> {
  return buildTestApp({
    enableAgentRuntime: true,
    tier: 'free',
    keyProvenance: 'cli_device',
    // What the device-code mint grants (auth-cli.ts DEFAULT_SCOPES).
    scopes: ['account_owner'],
  });
}

function bearer(f: TestAppFixture): Record<string, string> {
  return { authorization: `Bearer ${f.plaintext}` };
}

describe('a Free desktop user can delete a recipe it saved', () => {
  it('saves a recipe, deletes it (204), and the list no longer carries it', async () => {
    fx = await freeDesktopApp();
    const repo = fx.agentSessionsRepo;
    if (repo === undefined) throw new Error('the agent runtime is not wired');
    const source = await repo.create({ accountId: fx.accountId, tokenBudgetTotal: 1000 });

    const saved = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: bearer(fx),
      payload: { agent_session_id: source.id, label: 'Check the order page' },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const recipeId = saved.json<{ id: string }>().id;

    const deleted = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/recipes/${recipeId}`,
      headers: bearer(fx),
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const list = await fx.app.inject({ method: 'GET', url: '/v1/recipes', headers: bearer(fx) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).not.toContain(
      recipeId,
    );
  });

  it('CONTROL — a route the desktop app does not use is still refused with the Free desktop refusal', async () => {
    fx = await freeDesktopApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/api-keys', headers: bearer(fx) });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ detail?: string }>().detail).toBe(FREE_DESKTOP_ROUTE_DENIED_DETAIL);
  });
});
