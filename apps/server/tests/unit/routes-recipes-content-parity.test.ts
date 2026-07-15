// Drift guard for apps/server/src/routes/recipes.ts. Pins AI-B4
// POST /v1/recipes — write-only at v1.0, read/list/execute/delete
// are v1.1 D2/D3 scope. Activation-gate pattern matches Wave 1119+:
// when both recipesRepo + agentSessionsRepo are wired, the real
// registrar runs; when omitted, 503 FeatureUnavailable surfaces a
// machine-readable signal to SDK + dashboard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('AI-B4 module-level framing pinned: recipe library routes (create + list + detail + delete); read/management pulled fwd from v1.1 D2/D3 (V-530.I/.J); EXECUTION stays v1.1 (harness-executor-gated)', () => {
    expect(body).toMatch(
      /\/\/ AI-B4 — recipe library routes\. POST \/v1\/recipes \(create\) \+ GET/,
    );
    expect(body).toMatch(/pulled forward from the v1\.1 D2\/D3 defer \(V-530\.I\/\.J\); recipe/);
    expect(body).toMatch(/EXECUTION stays v1\.1 \(gated on the harness-wired AgentExecutor\)\./);
  });

  it('Activation-gate Wave 1119+ framing pinned: \'when both recipesRepo + agentSessionsRepo are wired in AppDeps, registerRecipesRoutes runs. When omitted, registerRecipesDisabledRoutes surfaces 503 FeatureUnavailable so SDK + dashboard get a machine-readable "not yet enabled" signal vs 404.\' — pinned so the dual-dep + 503-vs-404 + machine-readable-signal contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ Activation gate matches the rest of Wave 1119\+: when both\s*\n?\s*\/\/ recipesRepo \+ agentSessionsRepo are wired in AppDeps,\s*\n?\s*\/\/ registerRecipesRoutes runs\. When omitted, registerRecipesDisabledRoutes\s*\n?\s*\/\/ surfaces 503 FeatureUnavailable so SDK \+ dashboard get a machine-\s*\n?\s*\/\/ readable "not yet enabled" signal vs 404\./,
    );
  });

  it('CreateRecipeRequestSchema 3-field shape + 100-char agent_session_id cap pinned: agent_session_id min 1 max 100 (canonical agt_<36-char-uuid>=40 + in-mem fixture ~19) + label min 1 max 120 + description max 2000 optional. Drift to dropping the 100-char cap would let a customer POST a multi-MB string that bloats the 404 NotFoundError detail in the problem+json body', () => {
    expect(body).toMatch(
      /\/\/ Cap at 100 chars — canonical `agt_<36-char-uuid>` is 40 chars,\s*\n?\s*\/\/ in-memory test fixtures use `agt_inmem_<counter>` \(~19 chars\)\.\s*\n?\s*\/\/ Without a cap, a customer could POST a multi-MB string that\s*\n?\s*\/\/ flows into the 404 NotFoundError detail and bloats the\s*\n?\s*\/\/ problem\+json body\./,
    );
    expect(body).toMatch(/agent_session_id: z\.string\(\)\.min\(1\)\.max\(100\),/);
    expect(body).toMatch(/label: z\.string\(\)\.min\(1\)\.max\(120\),/);
    expect(body).toMatch(/description: z\.string\(\)\.max\(2000\)\.optional\(\),/);
  });

  it("PublicRecipe 8-field shape pinned: id + account_id + agent_session_id (nullable) + label + description (nullable) + intent_count + created_at + updated_at. Drift to dropping intent_count would force the dashboard to fetch the full intent_log just to show 'N steps' UX; drift to dropping nullable on agent_session_id would crash on recipes whose source session was deleted", () => {
    expect(body).toMatch(/interface PublicRecipe \{\s*\n?\s*id: string;/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/agent_session_id: string \| null;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/description: string \| null;/);
    expect(body).toMatch(/intent_count: number;/);
    expect(body).toMatch(/created_at: string;/);
    expect(body).toMatch(/updated_at: string;/);
  });

  it("Cross-account 404 framing pinned: 'The session MUST belong to the caller's account (cross-account 404 instead of 403 — don't leak existence).' — pinned so the 404-not-403 anti-enumeration contract stays documented (drift to 403 would leak that a session id exists on someone else's account)", () => {
    expect(body).toMatch(
      /\/\/ Load the source agent session to snapshot its intent_log \+\s*\n?\s*\/\/ transcript\. The session MUST belong to the caller's account\s*\n?\s*\/\/ \(cross-account 404 instead of 403 — don't leak existence\)\./,
    );
    expect(body).toMatch(
      /if \(source === null \|\| source\.accountId !== ctx\.account\.id\) \{\s*\n?\s*throw new NotFoundError\(`AgentSession \$\{parsed\.data\.agent_session_id\} not found\.`\);/,
    );
  });

  it("Q.5.c intent_log assembly framing pinned: 'assemble intent_log from the transcript's plan-executed agent turns. AgentRuntime persists each plan's structured intent array on the transcript entry's optional `intents` field (Q.5.c follow-up). flatMap produces a concatenated intent_log in turn order so replay walks them in the same sequence the customer's session originally executed.' + source.transcript.flatMap((entry) => entry.intents ?? []) — pinned so the Q.5.c anchor + turn-order-replay-fidelity contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Q\.5\.c — assemble intent_log from the transcript's\s*\n?\s*\/\/ plan-executed agent turns\./,
    );
    expect(body).toMatch(
      /const intentLog: AgentIntent\[\] = source\.transcript\.flatMap\(\(entry\) => entry\.intents \?\? \[\]\);/,
    );
  });

  it('public detail omits explicit and selector-inferred sensitive type values while preserving the encrypted repository record for server-side replay', () => {
    expect(body).toMatch(
      /import \{ publicAgentIntent \} from '\.\.\/services\/agent-public-redaction\.js';/,
    );
    expect(body).toMatch(/rec\.intentLog\.map\(publicAgentIntent\)/);
  });

  it('Disabled-stub customer-facing current-state detail and docs URL are pinned', () => {
    expect(body).toMatch(
      /\/\/ Customer-facing detail\. Lands verbatim in the SDK's 503 problem\s*\n?\s*\/\/ body\. Same fix shape as agent-sessions \/ byok-anthropic \/\s*\n?\s*\/\/ proxy disabled-stubs \(slices 87 \+ 88\): point at customer-facing\s*\n?\s*\/\/ docs URL, NOT the internal handoff\/design doc\./,
    );
    expect(body).toMatch(
      /'Recipes are unavailable on this deployment\. ' \+\s*\n?\s*'Contact the deployment operator if recipe access is expected\. See ' \+\s*\n?\s*'https:\/\/docs\.driftstack\.dev\/api\/recipes\/ for the supported API flow\.';/,
    );
  });
});
