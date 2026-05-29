// A4 — drift guard for the "Save recipe" flow on the agent-session detail
// workbench (apps/customer-dashboard/src/pages/agent-sessions/[id].astro).
// The dialog POSTs { agent_session_id, label, description? } to
// POST /v1/recipes (CreateRecipeRequestSchema in routes/recipes.ts). Pins
// the page↔route wire contract so a field rename on either side can't
// silently break recipe-save.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/agent-sessions/[id].astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts');

describe('agent-sessions/[id].astro save-recipe (A4) parity', () => {
  const page = readFileSync(PAGE, 'utf8');

  it('renders the Save-recipe dialog + composer button', () => {
    expect(page).toMatch(/data-component="SaveRecipeDialog"/);
    expect(page).toMatch(/data-action="save-recipe"/);
    expect(page).toMatch(/id="recipe-label"/);
    expect(page).toMatch(/id="recipe-description"/);
  });

  it('POSTs /v1/recipes with { agent_session_id, label } (+ optional description)', () => {
    expect(page).toMatch(/\/v1\/recipes/);
    expect(page).toMatch(/method:\s*['"]POST['"]/);
    expect(page).toMatch(/agent_session_id: sessionId/);
    expect(page).toMatch(/body\.description = description/);
  });

  it('handles the documented response statuses (201 success + 503 gated + 400)', () => {
    expect(page).toMatch(/res\.status === 201/);
    expect(page).toMatch(/res\.status === 503/);
    expect(page).toMatch(/res\.status === 400/);
  });

  it('respects the schema field caps (label maxlength 120, description maxlength 2000)', () => {
    expect(page).toMatch(/id="recipe-label"[\s\S]{0,200}maxlength="120"/);
    expect(page).toMatch(/id="recipe-description"[\s\S]{0,200}maxlength="2000"/);
  });

  it('CROSS-SOURCE: the server registers POST /v1/recipes with the matching CreateRecipeRequestSchema', () => {
    const route = readFileSync(ROUTE, 'utf8');
    expect(route).toMatch(/['"]\/v1\/recipes['"]/);
    expect(route).toMatch(/CreateRecipeRequestSchema = z\.object\(\{/);
    expect(route).toMatch(/agent_session_id: z\.string\(\)/);
    expect(route).toMatch(/label: z\.string\(\)/);
  });
});
