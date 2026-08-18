// The recipe label and description bounds are written in THREE places and tested by
// none of them at the boundary.
//
// Found by widening last fire's threshold census to the population it excluded by
// construction: comparisons against an INLINE numeric literal. 73 of them in
// apps/server/src, most of them HTTP status classification and character ranges. The
// customer-facing ones are input bounds, and the recipe pair is written out three
// times:
//
//   routes/recipes.ts       `label: z.string().min(1).max(120)`
//                           `description: z.string().max(2000).optional()`
//   services/recipes.ts     `trimmedLabel.length > 120` / `description.length > 2000`
//   db/recipes-repo.ts      byte-identical to the service copy
//
// What guards them today: `db-recipes-repo-content-parity` regexes the validator's
// TEXT, and `docs-recipes-content-parity` regexes the docs and the route source. Three
// copies of a number, three text pins, and nothing had ever sent a 121-character label.
//
// ⚠️ The layered copies are not redundant, they are a HAZARD, and the reason is the
// error type. The route's zod rejection is a clean 400. The service and repo copies
// `throw new Error(...)` — a plain Error, not an ApiError — so anything reaching THEM
// with an over-long value produces a 500 rather than a validation failure. Today zod
// catches it first because all three numbers agree. Raise the route's max above the
// service's and a customer typing one character too many gets "internal server error".
//
// So the arms below drive the real route at 120/121 and 2000/2001 and assert the shape
// of the refusal, not just that one happened. The accept side is what stops this being
// an all-refusals matrix a validator rejecting everything would satisfy.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let agentSessionId = '';

beforeAll(async () => {
  fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: {},
  });
  expect(created.statusCode, `agent-session create returned ${created.statusCode}`).toBe(201);
  agentSessionId = created.json<{ id: string }>().id;
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
});

function createRecipe(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  body: string;
}> {
  return fx.app.inject({
    method: 'POST',
    url: '/v1/recipes',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { agent_session_id: agentSessionId, ...payload },
  });
}

describe('a recipe label at its limit is accepted, and one past it is a 400', () => {
  it('CRITICAL the fixture really creates recipes, so the refusals below are refusals rather than a route that never worked. Every other arm reports a rejection, and a create path that was broken for an unrelated reason would satisfy them all.', async () => {
    const res = await createRecipe({ label: `ok-${randomUUID().slice(0, 8)}` });
    expect(res.statusCode, `a normal recipe create failed: ${res.body}`).toBe(201);
  });

  it('CRITICAL a label of EXACTLY 120 characters is accepted. The bound is inclusive in all three places that state it, so 120 is legal — and a narrowing to 119 refuses a customer who is inside the documented limit, which is the direction nobody notices until support does.', async () => {
    const res = await createRecipe({ label: 'a'.repeat(120) });
    expect(res.statusCode, `a 120-character label was refused: ${res.body}`).toBe(201);
  });

  it('CRITICAL a 121-character label is a 400, NOT a 500. This is the arm the layering makes necessary: the route rejects with zod, while the service and repo copies throw a plain Error. They agree on 120 today, so zod fires first — the moment they disagree, one extra character becomes an internal server error instead of a validation failure.', async () => {
    const res = await createRecipe({ label: 'a'.repeat(121) });
    expect(res.statusCode, `a 121-character label produced ${res.statusCode}: ${res.body}`).toBe(
      400,
    );
    expect(res.body, 'the refusal is not an RFC 7807 problem body').toContain(
      'errors.driftstack.dev',
    );
  });

  it('CRITICAL a description of EXACTLY 2000 characters is accepted, and 2001 is a 400. Same bracket on the other bound — the description is the field a customer pastes into, so the edge is the value they actually hit.', async () => {
    const ok = await createRecipe({
      label: `desc-ok-${randomUUID().slice(0, 8)}`,
      description: 'd'.repeat(2000),
    });
    expect(ok.statusCode, `a 2000-character description was refused: ${ok.body}`).toBe(201);

    const over = await createRecipe({
      label: `desc-over-${randomUUID().slice(0, 8)}`,
      description: 'd'.repeat(2001),
    });
    expect(
      over.statusCode,
      `a 2001-character description produced ${over.statusCode}: ${over.body}`,
    ).toBe(400);
  });

  it('CRITICAL a label that is only whitespace is refused. The service and repo trim BEFORE measuring, so "   " is length 0 after trim — but zod sees three characters and passes it. This is the one case where the layered copies are doing work the route schema cannot, which is also why they cannot simply be deleted.', async () => {
    const res = await createRecipe({ label: '   ' });
    expect(
      res.statusCode,
      `a whitespace-only label produced ${res.statusCode}: ${res.body}`,
    ).toBeGreaterThanOrEqual(400);
    expect(
      res.statusCode,
      'a whitespace-only label produced a 5xx rather than a refusal',
    ).toBeLessThan(500);
  });

  it('CRITICAL the three copies of the bound still agree. They are enforced at three layers with two different error types, so a disagreement is not a style problem — it is the gap where a clean 400 becomes a 500. Derived from the sources rather than restated, because a fourth hand-written copy of the number is the thing being guarded against.', () => {
    const route = read('apps/server/src/routes/recipes.ts');
    const service = read('apps/server/src/services/recipes.ts');
    const repo = read('apps/server/src/db/recipes-repo.ts');

    const routeLabel = /label:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\((\d+)\)/.exec(route)?.[1];
    const routeDesc = /description:\s*z\.string\(\)\.max\((\d+)\)/.exec(route)?.[1];
    expect(routeLabel, 'the route label bound is gone or reshaped').toBeDefined();
    expect(routeDesc, 'the route description bound is gone or reshaped').toBeDefined();

    for (const [name, src] of [
      ['services/recipes.ts', service],
      ['db/recipes-repo.ts', repo],
    ] as const) {
      const label = /trimmedLabel\.length > (\d+)/.exec(src)?.[1];
      const desc = /description\.length > (\d+)/.exec(src)?.[1];
      expect(label, `${name} no longer bounds the label`).toBe(routeLabel);
      expect(desc, `${name} no longer bounds the description`).toBe(routeDesc);
    }
  });
});
