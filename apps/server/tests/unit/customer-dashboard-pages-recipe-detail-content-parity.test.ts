// Drift guard for apps/customer-dashboard/src/pages/recipes/[id].astro.
// AI-B4 recipe DETAIL view — the dashboard consumer for GET
// /v1/recipes/:id (the full recipe incl. intent_log). SSR
// (prerender=false) so there's no static dist HTML to jsdom-test;
// these source pins lock the load-bearing behaviour: the [data-state]
// state machine (loading → loaded / not-found / error / needs-signin),
// the cross-account 404 → not-found mapping, the NON-lossy AgentIntent
// rendering (all 4 kinds + a JSON fallback so a new intent shape is
// never silently dropped), the read+delete-only posture (execution
// stays harness-gated), and delete → redirect to /recipes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/recipes/[id].astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/customer-dashboard/src/pages/recipes/[id].astro content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('SSR dynamic route: prerender=false + reads the id from Astro.params + passes it to the inline script via define:vars (recipeId)', () => {
    expect(body).toMatch(/export const prerender = false;/);
    expect(body).toMatch(/const \{ id \} = Astro\.params;/);
    expect(body).toMatch(/define:vars=\{\{ apiBaseUrl, recipeId: id \}\}/);
  });

  it("read+delete-only framing pinned: 'Read + delete only ... there is no run/replay control' — so the execution-stays-harness-gated contract stays explicit (drift to adding a run control would imply the executor exists, which it doesn't)", () => {
    expect(body).toMatch(
      /Read \+ delete only —\s*\n?\s*\/\/ recipe EXECUTION stays gated on the harness executor/,
    );
  });

  it('GET /v1/recipes/:id fetch with the recipeId path param (the built-but-previously-unconsumed detail endpoint)', () => {
    expect(body).toMatch(/authedFetch\('\/v1\/recipes\/' \+ encodeURIComponent\(recipeId\)\)/);
  });

  it('cross-account / missing → 404 maps to the not-found state (not a generic error); other non-ok → error state', () => {
    expect(body).toMatch(/if \(r\.status === 404\) \{\s*\n?\s*show\('not-found'\);/);
    expect(body).toMatch(/show\('error'\);/);
  });

  it('[data-state] state machine present: loading + loaded + not-found + error + needs-signin (show() toggles exactly one)', () => {
    for (const s of ['loading', 'loaded', 'not-found', 'error', 'needs-signin']) {
      expect(body, `data-state="${s}"`).toMatch(new RegExp(`data-state="${s}"`));
    }
    expect(body).toMatch(
      /el\.classList\.toggle\('hidden', el\.getAttribute\('data-state'\) !== state\)/,
    );
  });

  it('NON-lossy AgentIntent rendering: all 4 kinds (navigate/interact/wait/capture) summarised + JSON.stringify fallback for unknown kinds so a future intent shape is never silently dropped', () => {
    expect(body).toMatch(/case 'navigate':/);
    expect(body).toMatch(/case 'interact':/);
    expect(body).toMatch(/case 'wait':/);
    expect(body).toMatch(/case 'capture':/);
    expect(body).toMatch(/default:\s*\n?\s*return escapeHtml\(JSON\.stringify\(it\)\);/);
  });

  it('source-session-deleted indicator: agent_session_id null/undefined → "(source session deleted)" — mirrors the list page', () => {
    expect(body).toMatch(/r\.agent_session_id === null \|\| r\.agent_session_id === undefined/);
    expect(body).toMatch(/\(source session deleted\)/);
  });

  it('delete: confirm-gated DELETE /v1/recipes/:id → on 204 redirect to /recipes', () => {
    expect(body).toMatch(/window\.confirm\('Delete this recipe\? This cannot be undone\.'\)/);
    expect(body).toMatch(
      /authedFetch\('\/v1\/recipes\/' \+ encodeURIComponent\(recipeId\), \{ method: 'DELETE' \}\)/,
    );
    expect(body).toMatch(
      /if \(r\.status === 204\) \{\s*\n?\s*window\.location\.href = '\/recipes';/,
    );
  });

  it('V-331b act-as header propagation in authedFetch (reads/deletes scope to the acting account)', () => {
    expect(body).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });
});
