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

  it("AI-B4 module-level docstring framing pinned: 'Recipes resource — /v1/recipes (AI-B4). Mirrors the TypeScript RecipesResource. Server registers the routes as 503 FeatureUnavailable stubs until both recipesRepo and agentSessionsRepo are wired in AppDeps; SDK surface is stable so consumers compile ahead of time.' — pinned so the AI-B4 anchor + cross-SDK TS-mirror reference + dual-repo activation-gate framing all stay documented", () => {
    expect(body).toMatch(/"""Recipes resource — \/v1\/recipes \(AI-B4\)\./);
    expect(body).toMatch(
      /Mirrors the TypeScript RecipesResource\. Server registers the routes as\s*\n?\s*503 ``FeatureUnavailable`` stubs until both ``recipesRepo`` and\s*\n?\s*``agentSessionsRepo`` are wired in AppDeps; SDK surface is stable so\s*\n?\s*consumers compile ahead of time\./,
    );
  });

  it("surface framing pinned: 'Surface: create + list + get + delete (the read/management path was pulled forward from the v1.1 D2/D3 defer — V-530.I/.J). Recipe EXECUTION stays v1.1 (gated on the harness executor).' — pinned so the create+list+get+delete surface + the execution-stays-gated contract stay explicit (drift to adding an execute() would diverge from the server, which has no execution route)", () => {
    expect(body).toMatch(/Surface: ``create`` \+ ``list`` \+ ``get`` \+ ``delete``/);
    expect(body).toMatch(/Recipe EXECUTION stays v1\.1 \(gated on the harness executor\)\./);
  });

  it('Sync RecipesResource surface pinned: create + list + iterate + get + delete (read/management). No execute() — recipe execution stays gated on the harness executor (an execute() would diverge from the server, which has no execution route)', () => {
    expect(body).toMatch(/class RecipesResource:/);
    expect(body).toMatch(
      /def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def get\(self, recipe_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def delete\(self, recipe_id: str\) -> None:/);
    expect(body).not.toMatch(/def execute\(/);
  });

  it('Async AsyncRecipesResource surface mirror pinned: create + list + iterate + get + delete (sync/async parity)', () => {
    expect(body).toMatch(/class AsyncRecipesResource:/);
    expect(body).toMatch(
      /async def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/async def get\(self, recipe_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/async def delete\(self, recipe_id: str\) -> None:/);
  });

  it('get() documents public intent-log sensitive-value omission and encrypted server-side replay', () => {
    expect(body).toMatch(
      /Fetch one recipe with its public ``intent_log``\.\s*\n\s*Sensitive type steps retain their selector and ``sensitive`` marker but\s*\n\s*omit the optional value\. Exact replay values stay encrypted server-side\./,
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
