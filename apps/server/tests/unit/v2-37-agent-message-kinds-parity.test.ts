// v2-#37 — cross-source pin that AgentMessageResponse covers every
// runtime kind. Catches the drift where AgentRuntime adds a new
// discriminant (sub-slice 8.6 added 'logged-manual') without updating
// the SDK type union.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RUNTIME = resolve(REPO_ROOT, 'apps/server/src/services/agent-runtime.ts');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const TS_RESOURCE = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#37 AgentRuntime <-> SDK kind union parity', () => {
  it('source files exist', () => {
    expect(existsSync(RUNTIME)).toBe(true);
    expect(existsSync(ROUTE)).toBe(true);
    expect(existsSync(TS_RESOURCE)).toBe(true);
  });

  it("CRITICAL every kind:'…' returned from AgentRuntime.runTurn appears in the TS SDK AgentMessageResponse union", () => {
    const runtime = read(RUNTIME);
    const route = read(ROUTE);
    const resource = read(TS_RESOURCE);

    // RunTurnResult variants are declared as `kind: '<name>';`. Four kinds the
    // whole-file scan picks up are NOT runTurn RESULT kinds surfaced to the SDK:
    //   - 'session-closed' — the route maps it to a 409 Conflict via the error path.
    //   - 'turn-in-progress' — likewise maps to a 409 Conflict.
    //   - 'account-turn-limit' — maps to a typed retryable 429 RateLimitedError.
    //   - 'plan' — a DecomposeResult kind constructed by reconstructHaltedPlan (#130
    //     consequential-approval resume) + returned by the decomposer; runTurn surfaces
    //     a plan as the 'plan-executed' result kind, never a bare 'plan'.
    const ROUTE_ERROR_KINDS = [
      'session-closed',
      'turn-in-progress',
      'account-turn-limit',
      'ai-control-unavailable',
    ] as const;
    const INTERNAL_CONTROL_KINDS = ['manual-transcript', 'ai-control'] as const;
    const NON_SDK_KINDS = new Set([...ROUTE_ERROR_KINDS, ...INTERNAL_CONTROL_KINDS, 'plan']);
    const KIND_RE = /\bkind:\s*['"]([a-z][a-z-]+)['"]/g;
    const runtimeKinds = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = KIND_RE.exec(runtime)) !== null) {
      if (m[1] && !NON_SDK_KINDS.has(m[1])) runtimeKinds.add(m[1]);
    }
    expect(runtimeKinds.size).toBeGreaterThan(0);

    // An internal kind may be excluded from the SDK ONLY when the route
    // explicitly maps it to an error. This closes the prior blind spot where
    // `turn-in-progress` was neither in the SDK nor named by this guard.
    for (const kind of ROUTE_ERROR_KINDS) {
      expect(route, `agent-session message route does not map internal kind:'${kind}'`).toContain(
        `result.kind === '${kind}'`,
      );
    }

    for (const kind of runtimeKinds) {
      expect(resource, `TS SDK AgentMessageResponse union is missing kind:'${kind}'`).toContain(
        `kind: '${kind}'`,
      );
    }
  });
});
