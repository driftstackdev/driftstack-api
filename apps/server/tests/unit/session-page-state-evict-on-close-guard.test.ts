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
//
// Audit 2026-07-01 (MEDIUM) — the customer DELETE route is only ONE of
// several session-termination paths (worker-disconnect grace / the 12h
// orphan backstop also close sessions but, being bulk closes-by-nodeId/
// cutoff, cannot cheaply evict this store — see those services' own
// comments). GET /:id/page-state itself is the actual backstop for those: it
// now cross-checks the session's live `status` (every closer flips the same
// column) before ever consulting the store, and additionally age-bounds a
// still-open entry via `getFresh`. Pinned below alongside the DELETE-path
// eviction so a refactor can't silently drop either half of the fix.

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
    // The atomic close winner evicts the in-memory pageState (optional-chained
    // no-op when unwired); concurrent idempotent losers return before eviction.
    expect(body).toMatch(/const closeOutcome = await sessions\.closeWithReasonOutcome\(/);
    expect(body).toMatch(/if \(closeOutcome\.kind === 'already_closed'\) \{/);
    expect(body).toMatch(/const closed = closeOutcome\.session;/);
    expect(body).toMatch(/sessionPageStateStore\?\.delete\(req\.params\.id\);/);
  });

  it("the rationale comment is pinned so the eviction isn't refactored away as dead code", () => {
    expect(body).toMatch(/evict the agent session's latest pageState on close/);
  });

  it("GET /:id/page-state refuses to serve a closed session's cached pageState (audit 2026-07-01)", () => {
    // `rec.status === 'closed'` gate — the single chokepoint every closer
    // (DELETE / terminal-close / worker-disconnect / orphan-sweep) already
    // shares, so a dead session's last cached entry (possibly 'stalled') can
    // never be served regardless of whether this store was itself evicted.
    expect(body).toMatch(
      /if \(rec\.status === 'closed'\) \{\s*\n\s*return \{ page_state: null \};/,
    );
  });

  it('GET /:id/page-state age-bounds a still-open entry via getFresh (audit 2026-07-01)', () => {
    expect(body).toMatch(
      /sessionPageStateStore\?\.getFresh\(req\.params\.id, maxAgeMs\) \?\? null/,
    );
    expect(body).toMatch(/resolvePageStateMaxAgeSeconds\(\) \* 1000/);
  });
});
