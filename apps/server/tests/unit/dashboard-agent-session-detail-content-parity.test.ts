// Drift guard for the agent-session DETAIL workbench page
// (apps/customer-dashboard/src/pages/agent-sessions/[id].astro). The
// list-page guard lives in dashboard-agent-sessions-page-content-parity.test.ts;
// the detail page (the live AI-chat workbench) had NO guard — and its
// message composer was POSTing the wrong field: `{ content }` instead of
// `{ user_message }`. The route's RunTurnRequestSchema is a strict
// `z.object({ user_message: ... })`, so every chat turn from the workbench
// 400'd. This pins the corrected wire contract so it can't silently regress.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/agent-sessions/[id].astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

describe('agent-sessions/[id].astro detail-page wire-contract parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('message composer POSTs /message with { user_message } — matches the route RunTurnRequestSchema; sending `content` 400s every turn', () => {
    expect(body).toMatch(/\/message'/);
    expect(body).toMatch(/JSON\.stringify\(\{ user_message: text \}\)/);
    // Drift-guard against the exact bug this fixed: never POST `content`.
    expect(body).not.toMatch(/JSON\.stringify\(\{ content:/);
  });

  it("CROSS-SOURCE: the route's RunTurnRequestSchema still requires `user_message` (the field the page sends)", () => {
    const route = readFileSync(ROUTE, 'utf8');
    expect(route).toMatch(
      /RunTurnRequestSchema = z\.object\(\{\s*\n?\s*user_message: z\.string\(\)/,
    );
  });
});
