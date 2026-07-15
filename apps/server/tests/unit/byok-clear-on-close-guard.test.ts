// Q.1.c / 938ebf3a — drift guard for the BYOK plaintext-clear-on-close in the
// agent-session MESSAGE route. The runtime can close a session mid-turn
// (budget-exhausted via closeWithReason); the decrypted BYOK Anthropic key
// lives in the route-owned in-memory cache, and the runtime has no handle on
// it, so the route MUST drop it when the turn closed the session — else the
// plaintext lingers in process memory until restart (the customer DELETE
// route is the only other clear path). This fix shipped without a test
// (the cache CLASS is unit-tested in byok-anthropic-key-cache.test.ts, but
// the route WIRING was unguarded — a refactor could silently drop the clear).
// A behavioral test needs buildTestApp to expose the cache + drive a
// budget-exhausted turn; this source-pin is the lightweight regression guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

describe('Q.1.c BYOK plaintext-clear-on-close (both route close paths) drift guard', () => {
  const body = readFileSync(ROUTE, 'utf8');

  it('the route file exists at the canonical path', () => {
    expect(existsSync(ROUTE)).toBe(true);
  });

  it('clears the cached BYOK plaintext when the message turn closed the session', () => {
    // Discrete pins (avoid a long \s*\n? chain).
    expect(body).toMatch(/if \(result\.session\.status === 'closed'\) \{/);
    expect(body).toMatch(/byokKeyCache\?\.delete\(req\.params\.id\);/);
  });

  it("the rationale comment is pinned so the clear isn't refactored away as dead code", () => {
    expect(body).toMatch(/drop the cached BYOK/);
    expect(body).toMatch(
      /the decrypted key would linger in process\s*\n?\s*\/\/\s*memory until restart/,
    );
  });

  // Symmetric guard for the SECOND clear path. The cache class doc names
  // two route-layer clear sites (message-route budget-exhausted close +
  // the customer DELETE /v1/agent-sessions/:id handler), but the block
  // above only pins the message-route one — the shared
  // `byokKeyCache?.delete(req.params.id);` `toMatch` passes on EITHER
  // occurrence, so removing the DELETE-handler eviction would slip
  // through. These pins make the customer-close clear path independently
  // regression-protected too.
  it('clears the cached BYOK plaintext on the customer DELETE close path (second clear site)', () => {
    // The atomic close winner evicts; concurrent idempotent losers return 204
    // before any teardown/cache/audit side effect.
    expect(body).toMatch(/const closeOutcome = await sessions\.closeWithReasonOutcome\(/);
    expect(body).toMatch(/if \(closeOutcome\.kind === 'already_closed'\) \{/);
    expect(body).toMatch(/const closed = closeOutcome\.session;/);
    expect(body).toMatch(/clear the cached plaintext on customer close/);
    // BOTH route-layer clear sites must be present (message-route close +
    // customer DELETE) — a count pin so neither can be dropped silently.
    const clearSites = body.match(/byokKeyCache\?\.delete\(req\.params\.id\);/g) ?? [];
    expect(clearSites.length).toBeGreaterThanOrEqual(2);
  });
});
