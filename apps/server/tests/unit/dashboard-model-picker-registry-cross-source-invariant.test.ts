// Cross-source invariant: the customer dashboard's agent-session model-picker
// <option value> list must stay in lockstep with the canonical CLAUDE_MODELS
// registry (packages/api-types/src/agent-models.ts). api-types + the SDK model
// union + the dashboard DEFAULT (dashboard-agent-sessions-page-content-parity)
// are already pinned, but the <option value> set itself was NOT cross-checked —
// so a founder adding a model to the registry (or renaming one) could leave it
// unselectable in the dashboard, or leave a stale/typo'd id selectable, with no
// test failing. This reads the canonical keys + asserts a 1:1 match with the
// rendered options (both directions), WITHOUT hardcoding the model list here
// (so it tracks the registry automatically).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/agent-sessions.astro'),
  'utf8',
);

function dashboardModelOptionIds(): string[] {
  return [
    ...new Set(
      [...PAGE.matchAll(/<option value="(claude-[^"]+)">/g)]
        .map((m) => m[1])
        .filter((v): v is string => v !== undefined),
    ),
  ];
}

describe('dashboard agent-session model picker ↔ CLAUDE_MODELS registry', () => {
  const canonical = Object.keys(CLAUDE_MODELS);

  it('renders an <option> for every canonical model id (no model is unselectable)', () => {
    const optionIds = dashboardModelOptionIds();
    for (const modelId of canonical) {
      expect(optionIds).toContain(modelId);
    }
  });

  it('renders no model <option> absent from the registry (no stale / typo / removed id)', () => {
    for (const id of dashboardModelOptionIds()) {
      expect(canonical).toContain(id);
    }
  });
});
