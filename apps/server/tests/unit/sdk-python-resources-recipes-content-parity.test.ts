// Drift guard for packages/sdk-python/src/driftstack/resources/recipes.py.
// Pins the public saved-recipe Python surface — sync + async management
// and suggestions + the cross-account 404
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

  it('frames recipes as an available management and suggestion resource', () => {
    expect(body).toMatch(/"""Saved recipes and recipe suggestions\./);
    expect(body).toMatch(
      /Surface: ``create`` \+ ``list`` \+ ``iterate`` \+ ``get`` \+ ``delete`` \+\s*\n?\s*``suggest``\. Deployments without recipe storage return the typed\s*\n?\s*``FeatureUnavailable`` error\./,
    );
  });

  it('keeps roadmap and internal dependency language out of the public SDK', () => {
    expect(body).not.toMatch(
      /AI-B4|Doc-132|v1\.1|D2\/D3|V-530|defer|compile ahead|wired in AppDeps|harness executor/i,
    );
  });

  it('Sync RecipesResource surface pinned: create + list + iterate + get + delete + suggest. No execute() because execution is outside this resource', () => {
    expect(body).toMatch(/class RecipesResource:/);
    expect(body).toMatch(
      /def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def get\(self, recipe_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def delete\(self, recipe_id: str\) -> None:/);
    expect(body).toMatch(/def suggest\(self, agent_session_id: str\) -> dict\[str, Any\]:/);
    expect(body).not.toMatch(/def execute\(/);
  });

  it('Async AsyncRecipesResource surface mirror pinned: create + list + iterate + get + delete (sync/async parity)', () => {
    expect(body).toMatch(/class AsyncRecipesResource:/);
    expect(body).toMatch(
      /async def create\(\s*\n?\s*self,\s*\n?\s*\*,\s*\n?\s*agent_session_id: str,\s*\n?\s*label: str,\s*\n?\s*description: str \| None = None,\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/async def get\(self, recipe_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/async def delete\(self, recipe_id: str\) -> None:/);
    expect(body).toMatch(/async def suggest\(self, agent_session_id: str\) -> dict\[str, Any\]:/);
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

  it("V-1120 ACCESS-scoped 404 framing pinned: agent_session_id must be a session you can ACCESS, and anything else 404s rather than 403s. The old docstring read as though any cross-account id 404s, which is the rule V-812 retracted — a team admin snapshotting the owner's session gets a 201, filed under the admin's own account.", () => {
    const body = read(LIB);
    expect(body).toMatch(
      /``agent_session_id`` must be a session you can\s*\n?\s*ACCESS — one your own account owns, or one owned by a team you/,
    );
    expect(body, 'the 404-not-403 reason must stay').toMatch(
      /returns 404 \(not 403\) by\s*\n?\s*design/,
    );
    expect(body, 'the any-cross-account-404s claim must not return').not.toMatch(
      /cross-account access on ``agent_session_id``\s*\n?\s*returns 404/,
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
