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
    // Was `>= 2` with a comment naming "BOTH" sites. There are FOUR, so the
    // bound carried two spare and could not see one being dropped. The sites are
    // not derivable from a route roster — they sit inside close-handling
    // branches — so this is an exhaustiveness pin instead: an exact count, which
    // reds on a removal AND forces a new one to be acknowledged here.
    //
    // The four: the two message-route session-closed paths, the explicit close
    // path, and the customer DELETE.
    const clearSites = body.match(/byokKeyCache\?\.delete\(req\.params\.id\);/g) ?? [];
    expect(
      clearSites.length,
      'every route-layer BYOK cache-clear site; add the new one here deliberately',
    ).toBe(4);
  });
});

// V-730 — the turn path must consult STORAGE on a cache miss before conceding
// to the bundled-LLM leg.
//
// The per-session cache is populated once at session-create and is lossy by
// construction (process restart, redeploy, LRU eviction at 10k, 13h TTL), while
// the bundled preflight gates on `cachedByokKey === undefined`. So a customer
// with a valid STORED key was silently promoted onto Driftstack's deployment
// key and billed against their bundled cap — with the docs promising BYOK
// always wins. The same re-read is what makes credential-lifecycle eviction
// effective: after a clear or rotate drops the entry, the next turn re-resolves
// instead of continuing on stale plaintext.
//
// Pinned at source rather than behaviourally, for the reason this file already
// records: driving a real turn needs the runtime plus provider mocks. That is a
// weaker guard than a behavioural test and is labelled as such — it proves the
// re-read is still WIRED, not that it resolves correctly. The eviction half IS
// behavioural (account-byok-anthropic-active.test.ts), as is the cache index
// (byok-anthropic-key-cache.test.ts).
describe('V-730 turn-path BYOK storage re-read on cache miss drift guard', () => {
  const body = readFileSync(ROUTE, 'utf8');

  it('re-reads the stored key when the cache misses and no header key was supplied', () => {
    // The guard condition: only on a miss, and only when the caller did not
    // already supply a header key (which outranks storage).
    expect(body).toMatch(
      /if \(cachedByokKey === undefined && headerByokKey === undefined && byokService !== undefined\) \{/,
    );
    expect(body).toMatch(/const stored = await byokService\.getPlaintext\(\{/);
    // Re-populating the cache is what keeps this to ONE decrypt per miss.
    expect(body).toMatch(/byokKeyCache\?\.set\(req\.params\.id, stored, turnAccountId\);/);
  });

  it('cached entries are tagged with their owning account so a clear/rotate can find them', () => {
    // Without the accountId argument the cache cannot be evicted by account and
    // the credential lifecycle silently stops reaching live sessions again.
    expect(body.match(/byokKeyCache\.set\([^)]*, stored, ownerAccountId\)/g)).toHaveLength(3);
  });

  it('a failed re-read degrades instead of failing the turn', () => {
    expect(body).toMatch(/'BYOK re-read on cache miss failed; resolving without a stored key'/);
  });
});
