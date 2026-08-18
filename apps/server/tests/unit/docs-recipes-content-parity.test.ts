// AI-B4 sub-slice 8.20.m (v2-#8) — docs/api/recipes.md content parity.
//
// Pins the new recipes API documentation page against the
// source-of-truth schema + route so renames break CI before the
// docs silently drift.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/recipes.md');
const ROUTE_FILE = resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts');

describe('AI-B4 sub-slice 8.20.m docs/api/recipes.md parity', () => {
  it('docs page exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');
  const routeSource = readFileSync(ROUTE_FILE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Recipes/);
    expect(body).toMatch(/description: .+intent_log.+/);
  });

  it('explains the current create/list/read/delete surface and does not promise an execution endpoint', () => {
    expect(body).toMatch(/The current surface covers create, list, read, and delete/);
    expect(body).toMatch(/There is no recipe-execution endpoint/);
    expect(body).toMatch(/POST \/v1\/recipes/);
    expect(body).toMatch(/GET \/v1\/recipes/);
    expect(body).toMatch(/DELETE \/v1\/recipes\/\{id\}/);
  });

  it('documents the request body shape: agent_session_id + label + optional description', () => {
    expect(body).toMatch(/agent_session_id/);
    expect(body).toMatch(/label/);
    expect(body).toMatch(/description/);
  });

  it('label length bound matches the route source (1-120 after trim)', () => {
    expect(body).toMatch(/1-120 characters after trim/);
    // The route source must declare the same bound.
    expect(routeSource).toMatch(
      /label: z\s*\.?\s*\.?string\(\)\s*\.?\s*\.min\(1\)\s*\.?\s*\.max\(120\)/,
    );
  });

  it('description length bound matches the route source (≤2000)', () => {
    expect(body).toMatch(/2000/);
    expect(routeSource).toMatch(/description: z\.string\(\)\.max\(2000\)/);
  });

  it('error table covers 400/404/401/503', () => {
    expect(body).toMatch(/\|\s*400\s*\|/);
    expect(body).toMatch(/\|\s*404\s*\|/);
    expect(body).toMatch(/\|\s*401\s*\|/);
    expect(body).toMatch(/\|\s*503\s*\|/);
  });

  it('error table mentions feature-unavailable for the activation-gate-off path', () => {
    expect(body).toMatch(/feature-unavailable/);
  });

  it('explains the intent_log flatMap semantic (operator + user entries skipped)', () => {
    expect(body).toMatch(/flatMap/);
    expect(body).toMatch(/agent turns/);
    // The same flatMap pattern lives in the route source.
    expect(routeSource).toMatch(/source\.transcript\.flatMap/);
  });

  it('mentions the manual-mode → intent_count: 0 invariant', () => {
    expect(body).toMatch(/intent_count.*0/);
    expect(body).toMatch(/manual/);
  });

  it('documents the cross-account 404 contract (no existence disclosure)', () => {
    expect(body).toMatch(/cross-account/);
    expect(body).toMatch(/404/);
  });
});
