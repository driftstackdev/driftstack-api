// Drift guard for packages/sdk-python/src/driftstack/resources/recipes.py.
// Pins the AI-B4 write-only Python surface — sync + async create()
// methods + the v1.0 narrow surface + the cross-account 404
// existence-leak-prevention contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/recipes.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B4 module-level docstring framing pinned: 'Recipes resource — /v1/recipes (AI-B4, write-only at v1.0). Mirrors the TypeScript RecipesResource. Server registers the route as a 503 FeatureUnavailable stub until both recipesRepo and agentSessionsRepo are wired in AppDeps; SDK surface is stable so consumers compile ahead of time.' — pinned so the AI-B4 anchor + cross-SDK TS-mirror reference + dual-repo activation-gate framing all stay documented", () => {
    expect(body).toMatch(/"""Recipes resource — \/v1\/recipes \(AI-B4, write-only at v1\.0\)\./);
    expect(body).toMatch(
      /Mirrors the TypeScript RecipesResource\. Server registers the route as\s*\n?\s*a 503 ``FeatureUnavailable`` stub until both ``recipesRepo`` and\s*\n?\s*``agentSessionsRepo`` are wired in AppDeps; SDK surface is stable so\s*\n?\s*consumers compile ahead of time\./,
    );
  });

  it("v1.0-narrow + v1.1-D2/D3 scope framing pinned: 'V1.0 scope is intentionally narrow — create only. Read / list / execute / delete surfaces are v1.1 D2/D3.' — pinned so the v1.0-narrow + v1.1-expansion contract stays explicit (drift to adding more methods in v1.0 would expand beyond the server's actual surface)", () => {
    expect(body).toMatch(
      /V1\.0 scope is intentionally narrow — ``create`` only\. Read \/ list \/\s*\n?\s*execute \/ delete surfaces are v1\.1 D2\/D3\./,
    );
  });

  it('Sync RecipesResource class + 1-method surface pinned: just create(). Drift to adding read/list/execute/delete would diverge from the v1.0 server-side scope', () => {
    expect(body).toMatch(/class RecipesResource:/);
    expect(body).toMatch(
      /def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).not.toMatch(/def list\(/);
    expect(body).not.toMatch(/def delete\(/);
    expect(body).not.toMatch(/def execute\(/);
    expect(body).not.toMatch(/def get\(/);
  });

  it('Async AsyncRecipesResource 1-method mirror pinned. Drift would break the sync/async parity contract', () => {
    expect(body).toMatch(/class AsyncRecipesResource:/);
    expect(body).toMatch(
      /async def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
  });

  it("Recipe return-shape framing pinned: 'Returns the inserted Recipe payload (id + account_id + agent_session_id + label + description + intent_count + timestamps).' — pinned so the 7-field returned-shape stays documented (matches TS RecipesResource + the server's recipe-row projection)", () => {
    expect(body).toMatch(
      /Returns the inserted ``Recipe`` payload \(id \+ account_id \+\s*\n?\s*agent_session_id \+ label \+ description \+ intent_count \+\s*\n?\s*timestamps\)\./,
    );
  });

  it("cross-account 404 existence-leak-prevention framing pinned: 'Server-side: cross-account access on agent_session_id returns 404 (not 403) by design — existence isn't leaked.' — pinned so the deliberate-404 privacy contract is explicit on the Python side. Drift to documenting 403 would mislead consumers about the actual server behavior + leak the privacy-contract rationale to downstream callers", () => {
    expect(body).toMatch(
      /Server-side: cross-account access on ``agent_session_id``\s*\n?\s*returns 404 \(not 403\) by design — existence isn't leaked\./,
    );
  });

  it('description-when-not-None body composition pattern pinned (sync + async). Drift to always-include-description would send `description: null` on the wire instead of omitting; the server treats absent + null differently for some other resources, so the conservative path is omit-when-None', () => {
    expect(body).toMatch(
      /body: dict\[str, Any\] = \{\s*\n?\s*"agent_session_id": agent_session_id,\s*\n?\s*"label": label,\s*\n?\s*\}\s*\n?\s*if description is not None:\s*\n?\s*body\["description"\] = description/,
    );
  });

  it('POST /v1/recipes path + coerce_body() on both sync + async. Drift to a different path would break the route binding; bypassing coerce_body would diverge from cross-SDK Decimal/datetime handling', () => {
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/recipes", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /return await self\._http\.request\("POST", "\/v1\/recipes", json_body=coerce_body\(body\)\)/,
    );
  });
});
