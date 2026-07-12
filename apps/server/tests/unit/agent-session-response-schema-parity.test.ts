// Pins the agent-session RESPONSE schema wiring introduced when the
// OpenAPI responses for the 3 read endpoints (POST 201 create, GET
// list, GET by-id) were `z.object({})` — i.e. the whole AI-chat
// resource was untyped for SDK codegen.
//
//   1. api-types `AgentSessionSchema` mirrors the apps/server route's
//      `PublicAgentSession` interface field-for-field, so the schema,
//      the route serialization, and codegen can never drift apart.
//   2. openapi.ts registers `AgentSession` as a named component and
//      references it on the 3 read endpoints (no longer empty).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSessionSchema, AgentIntentSchema, IntentResultSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

describe('agent-session response schema parity', () => {
  it('AgentSessionSchema mirrors the route PublicAgentSession interface field-for-field — the response shape is shared so a field added/removed on either side breaks the build (the OpenAPI spec, SDK codegen, and the route serialization stay aligned)', () => {
    const routeSrc = read(resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'));
    const m = routeSrc.match(/interface PublicAgentSession \{([\s\S]+?)\n\}/);
    expect(m, 'PublicAgentSession interface must be present in the route').not.toBeNull();
    // Top-level field names only (anchored to line start; skips comments +
    // the inline `{ kind: ... }` members of pair_mode_state).
    const ifaceBody = m?.[1] ?? '';
    const ifaceFields = [...ifaceBody.matchAll(/^\s+(\w+)\??:/gm)]
      .map((x) => x[1])
      .filter((f): f is string => f !== undefined);
    expect(ifaceFields.length).toBe(17);
    expect(new Set(Object.keys(AgentSessionSchema.shape))).toEqual(new Set(ifaceFields));
  });

  it('OpenAPI registers AgentSession as a named component (Pydantic/Go/TS codegen gets a named type, not an inline anonymous shape)', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(oapi).toMatch(/r\.register\('AgentSession', AgentSessionSchema\);/);
  });

  it('OpenAPI references AgentSessionSchema on the 3 read endpoints — bare on POST 201 + GET by-id, array-wrapped on GET list (was z.object({}))', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    // bare resource (create 201 + get-by-id both use `schema: AgentSessionSchema`)
    expect(oapi).toMatch(/schema: AgentSessionSchema \}/);
    // list rows
    expect(oapi).toMatch(/data: z\.array\(AgentSessionSchema\)/);
  });

  it('OpenAPI types the `session` envelope on the POST /:id/message turn-result union (all 3 members — plan-executed/clarify/refuse — carried session: z.object({}) before)', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    const sessionFields = oapi.match(/session: AgentSessionSchema,/g) ?? [];
    // 3 union members each carry the updated session envelope.
    expect(sessionFields.length).toBe(3);
  });

  it('OpenAPI types the message turn-result intents/results arrays (were z.array(z.object({}))); AgentIntent/IntentResult cover the route vocabulary', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(oapi).toMatch(/intents: z\.array\(AgentIntentSchema\)/);
    expect(oapi).toMatch(/results: z\.array\(IntentResultSchema\)/);
    // Route parity: the decomposer's AgentIntent union member count == the schema's
    // (a new verb added to the route but not api-types fails here). W140 added
    // scroll + behavioral_pause → 6 members.
    const decomposer = read(resolve(REPO_ROOT, 'apps/server/src/services/agent-decomposer.ts'));
    const intentBlock = decomposer.match(/export type AgentIntent =([\s\S]+?)\n\n/)?.[1] ?? '';
    const routeVerbCount = (intentBlock.match(/kind: '/g) ?? []).length;
    expect(routeVerbCount).toBe(6);
    expect(AgentIntentSchema.options).toHaveLength(routeVerbCount);
    // success + failure + confirmation_required (W443/W445 human-confirm guardrail).
    expect(IntentResultSchema.options).toHaveLength(3);
    expect(
      IntentResultSchema.safeParse({
        kind: 'confirmation_required',
        intent: { kind: 'interact', action: 'tap', selector: 'Buy Now' },
        category: 'purchase',
        matchedText: 'Buy Now',
      }).success,
    ).toBe(true);
    // The closed verb vocabulary parses under the schema.
    expect(AgentIntentSchema.safeParse({ kind: 'navigate', url: 'https://x' }).success).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'capture', capture: 'pdf' }).success).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: 0 }).success,
    ).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: -1 }).success,
    ).toBe(false);
    expect(
      AgentIntentSchema.safeParse({ kind: 'wait', condition: 'idle', timeoutMs: 1.5 }).success,
    ).toBe(false);
    // W140 behavioural intents.
    expect(
      AgentIntentSchema.safeParse({ kind: 'scroll', direction: 'down', amount_px: 800 }).success,
    ).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'scroll', direction: 'up' }).success).toBe(true);
    expect(
      AgentIntentSchema.safeParse({ kind: 'behavioral_pause', reading_word_count: 120 }).success,
    ).toBe(true);
    expect(AgentIntentSchema.safeParse({ kind: 'behavioral_pause' }).success).toBe(true);
    // scroll requires a direction.
    expect(AgentIntentSchema.safeParse({ kind: 'scroll' }).success).toBe(false);
    expect(
      IntentResultSchema.safeParse({
        kind: 'success',
        intent: { kind: 'wait', condition: 'idle' },
        summary: 'ok',
      }).success,
    ).toBe(true);
  });
});
