// W650 — drift guard for the agent-session pageState eviction in the customer
// DELETE /v1/agent-sessions/:id close handler. The SessionPageStateStore is a
// route-owned, per-session in-memory Map (latest pageState for the GUI
// loading-bar / error-overlay). It is bounded by an LRU cap, so a missing
// eviction is not an unbounded leak — but on an explicit customer close the
// entry should be freed promptly (rather than lingering until LRU pushout,
// where GET /:id/page-state could serve a closed session's stale state), which
// also fulfils the store's documented on-session-end eviction. This mirrors the
// sibling byokKeyCache?.delete eviction in the same handler (byok-clear-on-
// close-guard.test.ts). The store CLASS is unit-tested in
// session-page-state-store.test.ts; this source-pin guards the ROUTE WIRING so
// a refactor can't silently drop the eviction (the wiring is gated/optional, so
// a behavioral test would need buildTestApp to wire the store + fleet plane).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

describe('W650 pageState evict-on-close (customer DELETE) drift guard', () => {
  const body = readFileSync(ROUTE, 'utf8');

  it('the route file exists at the canonical path', () => {
    expect(existsSync(ROUTE)).toBe(true);
  });

  it('evicts the agent session pageState on the customer DELETE close path', () => {
    // The customer-close handler closes the session, then evicts the in-memory
    // pageState (idempotent + optional-chained — no-op when the store/fleet
    // plane is unwired). Discrete pins (avoid a long \s*\n? chain).
    expect(body).toMatch(/await sessions\.closeWithReason\(req\.params\.id, 'customer-closed'\);/);
    expect(body).toMatch(/sessionPageStateStore\?\.delete\(req\.params\.id\);/);
  });

  it("the rationale comment is pinned so the eviction isn't refactored away as dead code", () => {
    expect(body).toMatch(/evict the agent session's latest pageState on close/);
  });
});
