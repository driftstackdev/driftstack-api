// Drift guard for apps/customer-dashboard/src/pages/recipes.astro.
// AI-B4 recipe-library management page — the dashboard read/delete
// surface for GET /v1/recipes + DELETE /v1/recipes/:id. Drift here
// either breaks the cursor-paginated "Load more" walk (would silently
// truncate the recipe list to the first page) or drops the
// execution-stays-gated framing (would imply a run/replay control
// that does not exist — execution is harness-executor-gated).
//
//   • AI-B4 read+delete-only framing (no run/replay control).
//   • V-331b act-as headers in authedFetch.
//   • GET /v1/recipes cursor-paginated fetch + accumulate.
//   • DELETE /v1/recipes/:id confirm + 204-only + reload-from-page-1.
//   • Empty-state: 'No recipes yet. Save one from an agent session.'
//   • dashboardHydrated() opacity-gate signal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/recipes.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/customer-dashboard/src/pages/recipes.astro content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B4 read+delete framing pinned: 'Recipe library management page' + 'this page is read + delete only — there is no run/replay control yet' — pinned so the execution-stays-gated contract stays explicit on the dashboard (drift to adding a run control would imply the harness executor exists, which it does not)", () => {
    expect(body).toMatch(/\/\/ AI-B4 — Recipe library management page\./);
    expect(body).toMatch(
      /execution\s*\n?\s*\/\/ stays gated on the harness executor, so this page is read \+\s*\n?\s*\/\/ delete only — there is no run\/replay control yet\./,
    );
  });

  it("V-331b act-as header propagation in authedFetch — pinned so the team-scoped 'view as another account' flow propagates to recipe reads/deletes (drift would let team managers delete from their OWN account when acting for a team-mate)", () => {
    expect(body).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('GET /v1/recipes cursor-paginated fetch: optional ?cursor= + r.ok-or-reject + accumulate into loaded[] + track next_cursor — pinned so the page walks every page rather than truncating to the first (drift to dropping the cursor would silently hide all but the newest page of recipes)', () => {
    expect(body).toMatch(/const qs = cursor \? '\?cursor=' \+ encodeURIComponent\(cursor\) : '';/);
    expect(body).toMatch(/authedFetch\('\/v1\/recipes' \+ qs\)/);
    expect(body).toMatch(/loaded = loaded\.concat\(body\.data \|\| \[\]\);/);
    expect(body).toMatch(/nextCursor = body\.next_cursor \|\| null;/);
  });

  it("DELETE /v1/recipes/:id: window.confirm + encodeURIComponent on id + 204-only success + reload()-from-first-page — pinned so customers can't accidentally delete (confirm-required), the RFC-compliant 204 is the only success path, and a delete re-walks pagination from page 1 (drift to splicing in place would corrupt cursor boundaries)", () => {
    expect(body).toMatch(
      /if \(!window\.confirm\('Delete recipe "' \+ label \+ '"\? This cannot be undone\.'\)\) \{/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/recipes\/' \+ encodeURIComponent\(id\), \{\s*\n?\s*method: 'DELETE',\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /if \(r\.status === 204\) \{\s*\n?\s*showBanner\('Recipe deleted\.'\);\s*\n?\s*return reload\(\);/,
    );
  });

  it("intent_count singular/plural label: '1 intent' vs 'N intents' — pinned so the row count reads grammatically (drift to always-plural would render '1 intents')", () => {
    expect(body).toMatch(
      /r\.intent_count === 1 \? '1 intent' : escapeHtml\(String\(r\.intent_count\)\) \+ ' intents';/,
    );
  });

  it('row label links to the recipe detail view (/recipes/:id) — pinned so the list does not dead-end (the detail page consumes the built GET /v1/recipes/:id endpoint); drift to a bare <p> would orphan the detail view', () => {
    expect(body).toMatch(/'<a href="\/recipes\/' \+\s*\n?\s*encodeURIComponent\(r\.id\) \+/);
  });

  it("source-session-deleted indicator: agent_session_id === null → '(source session deleted)' — pinned so customers see when a recipe's source agent-session was cleaned up (the FK is ON DELETE SET NULL server-side; drift to dropping would leave a bare 'from ' label)", () => {
    expect(body).toMatch(/r\.agent_session_id === null/);
    expect(body).toMatch(/<em>\(source session deleted\)<\/em>/);
  });

  it("Empty-state: 'No recipes yet' headline + 'Save one from an agent session' next-step CTA pointing at /agent-sessions — pinned so the zero-state guides the customer to the capture flow (recipes are only created from agent sessions)", () => {
    expect(body).toMatch(/No recipes yet/);
    expect(body).toMatch(
      /Save one from an <a href="\/agent-sessions" class="text-glow-red underline">agent session<\/a>/,
    );
  });

  it('dashboardHydrated() opacity-gate signal fired after the first fetch — pinned so the page participates in the V-... hydrate-gate (drift to dropping would leave the page stuck at reduced opacity)', () => {
    expect(body).toMatch(
      /if \(typeof window\.dashboardHydrated === 'function'\) \{\s*\n?\s*window\.dashboardHydrated\(\);/,
    );
  });
});
