// Cross-source invariant: every activation-gate disabled-stub
// detail string MUST point at a customer-facing docs.driftstack.dev
// URL — NEVER at an internal handoff or design doc. Per slices
// 87 + 88 / commit 6efc0a34 fix-shape: the 503 problem-body lands
// VERBATIM in the customer's SDK, so internal nomenclature
// (planning files, V-NNN, handoff numbers) would orphan operators
// from a working recovery path.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RECIPES = resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts');
const AGENT_SESSIONS = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const ACCOUNT_BYOK = resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Activation-gate disabled-stub customer-facing docs URL cross-source invariant', () => {
  const recipes = read(RECIPES);
  const agentSessions = read(AGENT_SESSIONS);
  const accountByok = read(ACCOUNT_BYOK);

  it('routes/recipes disabled-stub references the supported API flow at https://docs.driftstack.dev/api/recipes/', () => {
    expect(recipes).toMatch(
      /'https:\/\/docs\.driftstack\.dev\/api\/recipes\/ for the supported API flow\.'/,
    );
  });

  it('routes/agent-sessions disabled-stub references both byok-anthropic + bundled-llm docs URLs — pinned so the 2-recovery-path customer-facing roster stays in sync with the 2-feature surface', () => {
    expect(agentSessions).toMatch(
      /'\(https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/\), or opt into the ' \+/,
    );
    expect(agentSessions).toMatch(/'\(https:\/\/docs\.driftstack\.dev\/api\/bundled-llm\/\)\.';/);
  });

  it('routes/account-byok-anthropic disabled-stub references the supported key-management flow at docs.driftstack.dev/api/byok-anthropic/', () => {
    expect(accountByok).toMatch(
      /'https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/ for the supported key-management flow\.'/,
    );
  });

  it("routes/recipes header explicitly documents the slice 87+88 fix-shape: 'Same fix shape as agent-sessions / byok-anthropic / proxy disabled-stubs (slices 87 + 88): point at customer-facing docs URL, NOT the internal handoff/design doc.' — pinned so the historical-lesson rationale stays documented (drift away from this pattern would invite the original internal-jargon-in-SDK-body regression)", () => {
    expect(recipes).toMatch(
      /Same fix shape as agent-sessions \/ byok-anthropic \/\s*\/\/ proxy disabled-stubs \(slices 87 \+ 88\): point at customer-facing\s*\/\/ docs URL, NOT the internal handoff\/design doc\./,
    );
  });

  it("routes/account-byok-anthropic header explicitly documents the slice 87 / 6efc0a34 fix-shape: 'Same fix shape as agent-sessions disabled-stub (slice 87 / 6efc0a34).' — pinned so the historical-commit-anchor cross-reference stays documented", () => {
    expect(accountByok).toMatch(
      /Same fix shape as agent-sessions disabled-stub\s*\/\/ \(slice 87 \/ 6efc0a34\)\./,
    );
  });

  it('No disabled-stub detail string references internal handoff numbers, planning files, or V-NNN anchors — pinned so the customer-facing-NOT-internal commitment stays enforced across all 3 disabled-stub authors', () => {
    // The detail string slice is the customer-facing literal — must not contain internal markers.
    const recipesDetail = recipes.match(/const detail =[\s\S]*?';/);
    const accountByokDetail = accountByok.match(/const detail =[\s\S]*?';/);
    expect(recipesDetail).not.toBeNull();
    expect(accountByokDetail).not.toBeNull();
    expect(recipesDetail![0]).not.toMatch(/V-\d{3}|planning file|handoff/);
    expect(accountByokDetail![0]).not.toMatch(/V-\d{3}|planning file|handoff/);
  });
});
