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
import { AgentSessionSchema } from '@driftstack/api-types';

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
    expect(ifaceFields.length).toBe(16);
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
});
