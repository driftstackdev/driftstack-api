// Drift guard for apps/server/src/services/byok-anthropic-key-cache.ts.
// Pins the Q.1.c in-memory per-session BYOK Anthropic plaintext cache —
// founder verdict 2026-05-17 (decrypt ONCE per agent-session) + the
// memory-only-not-Redis trade-off.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic-key-cache.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/byok-anthropic-key-cache content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Q.1.c founder verdict 2026-05-17 framing pinned: 'in-memory per-session BYOK Anthropic plaintext cache. Founder verdict 2026-05-17: decrypt the customer's stored key ONCE at agent-session create, hold the plaintext in process memory for the session lifetime, never re-decrypt mid-session. Bounds AES-GCM ciphertext unwrap to one operation per session-create (matching how MFA TOTP is decrypted once on enrollment-flow load).' — pinned so the Q.1.c verdict + 2026-05-17 lock-date + decrypt-once-per-session + AES-GCM unwrap-bound + MFA-TOTP comparison cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ Q\.1\.c — in-memory per-session BYOK Anthropic plaintext cache\./);
    expect(body).toMatch(
      /\/\/ Founder verdict 2026-05-17: decrypt the customer's stored key ONCE\s*\/\/ at agent-session create, hold the plaintext in process memory for\s*\/\/ the session lifetime, never re-decrypt mid-session\. Bounds AES-GCM\s*\/\/ ciphertext unwrap to one operation per session-create \(matching how\s*\/\/ MFA TOTP is decrypted once on enrollment-flow load\)\./,
    );
  });

  it("3-event lifecycle framing pinned: SET on agent-session create with a stored BYOK key, GET on each /message without an x-byok header (header overrides per Q.1.c option 2), DELETE on session close — BOTH clear paths now at the route layer (customer DELETE + the /message handler when a turn closes the session, e.g. runtime budget-exhausted close). 2026-05-31: corrected from the inaccurate 'from the runtime' wording — the runtime has no handle on the route-owned cache, so the budget-exhausted clear happens in the message route via post-turn status 'closed'", () => {
    expect(body).toMatch(
      /\/\/ {3}- SET on POST \/v1\/agent-sessions when the customer has a stored\s*\/\/ {5}BYOK key \(after BYOKAnthropicService\.getPlaintext returns\s*\/\/ {5}non-null\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}- GET on every POST \/v1\/agent-sessions\/:id\/message that doesn't\s*\/\/ {5}carry an x-byok-anthropic-api-key header \(header overrides per\s*\/\/ {5}Q\.1\.c verdict option 2\)\./,
    );
    // Discrete pins (no long backtracking chain) for the corrected,
    // route-layer-accurate DELETE lifecycle bullet.
    expect(body).toMatch(
      /\/\/ {3}- DELETE on session close — both at the route layer, since this cache/,
    );
    expect(body).toMatch(/the customer\s*\/\/ {5}DELETE \/v1\/agent-sessions\/:id handler/);
    expect(body).toMatch(/POST \/:id\/message/);
    expect(body).toMatch(/post-turn status 'closed'/);
  });

  it("Memory-shape framing pinned: 'in-process Map keyed by agent_session_id. Plaintext strings are held in JS heap; not persisted; not serialized to logs. On process restart the cache is empty; existing customer sessions fall through to the header-only path (still works because the route resolution chain is header > cache > fallback).' — pinned so the JS-heap + no-persist + no-log + empty-on-restart + header>cache>fallback resolution-chain contract all stay documented (drift to logging plaintext would leak customer Anthropic keys)", () => {
    expect(body).toMatch(
      /\/\/ Memory shape: in-process Map keyed by agent_session_id\. Plaintext\s*\/\/ strings are held in JS heap; not persisted; not serialized to logs\.\s*\/\/ On process restart the cache is empty; existing customer sessions\s*\/\/ fall through to the header-only path \(still works because the route\s*\/\/ resolution chain is header > cache > fallback\)\./,
    );
  });

  it("Why-not-Redis framing pinned: 'Redis adds round-trip latency per turn (~1-2 ms each way) for a value that's only useful within one process's memory. The orchestrator's verdict was explicit about per-SESSION caching, not cross-process; the trade-off is acceptable for v1.0.' — pinned so the latency-rationale + per-SESSION-not-cross-process + v1.0-acceptable scope all stay documented (drift to Redis-backed would add 2-4ms per turn for no benefit)", () => {
    expect(body).toMatch(
      /\/\/ Why not Redis-backed: Redis adds round-trip latency per turn \(~1-2\s*\/\/ ms each way\) for a value that's only useful within one process's\s*\/\/ memory\. The orchestrator's verdict was explicit about per-SESSION\s*\/\/ caching, not cross-process; the trade-off is acceptable for v1\.0\./,
    );
  });

  // V-730 — a FIFTH method, deleteByAccount, plus an accountId on set(). The
  // cache was keyed only by session, so the credential lifecycle could not reach
  // it: clearing the stored key left every open session transmitting the cleared
  // credential until close or the 13h TTL, and rotating never reached an
  // already-open session. Dropping either the method or the accountId argument
  // silently restores that, so both are pinned.
  it('InMemoryByokKeyCache 5-method surface pinned: set + get + delete + deleteByAccount + size (test seam). Drift to dropping size would break test-pressure assertions; drift to adding has() would tempt callers to use a non-atomic check-then-get pattern instead of just calling get + checking undefined', () => {
    expect(body).toMatch(/export class InMemoryByokKeyCache \{/);
    expect(body).toMatch(
      /set\(agentSessionId: string, plaintextKey: string, accountId\?: string\): void/,
    );
    expect(body).toMatch(/deleteByAccount\(accountId: string\): number/);
    // Every removal must funnel through forget(), or the account index outlives
    // the entries it points at and deleteByAccount reports evictions it never
    // performed — an operator would read that count as a completed revocation.
    expect(body).toMatch(/private forget\(agentSessionId: string\): void/);
    expect(body.match(/this\.cache\.delete\(/g)).toHaveLength(1);
    expect(body).toMatch(/get\(agentSessionId: string\): string \| undefined/);
    expect(body).toMatch(/delete\(agentSessionId: string\): void/);
    expect(body).toMatch(
      /\/\*\* Test seam: observable size for cache-pressure assertions\. \*\/\s*size\(\): number/,
    );
  });

  it("set() overwrite-on-existing framing pinned: 'Overwrites any prior value (no-op on first call; intentional for the rare key-rotation-during-active-session edge case).' — pinned so the deliberate-overwrite-not-throw contract + the key-rotation-during-session edge case stay documented (drift to throwing on existing would break customer rotation mid-flight)", () => {
    expect(body).toMatch(
      /\*\s+Stash the plaintext key for the given agent-session id\. Overwrites any\s*\*\s+prior value \(intentional for the rare key-rotation-during-active-session\s*\*\s+edge case\)\./,
    );
  });

  it("get() cache-miss-returns-undefined framing pinned: 'Returns the cached plaintext or undefined when no entry exists (cache miss on process restart, never-stashed session, or post-delete read).' — pinned so the undefined-on-miss + 3-miss-scenario catalog (restart / never-stashed / post-delete) stay documented (drift to throwing on miss would crash the route's normal cache-miss-falls-through-to-header path)", () => {
    expect(body).toMatch(
      /\/\*\* Returns the cached plaintext or undefined when no entry exists \(cache\s*\*\s+miss on process restart, never-stashed session, post-delete read, or an\s*\*\s+entry past its TTL/,
    );
  });

  it("delete() idempotent framing pinned: 'Drop the cached plaintext. Idempotent — safe to call on already-empty entries (e.g. when the route's DELETE handler fires concurrent with the runtime's budget-exhausted close).' — pinned so the idempotent contract + the route-vs-runtime concurrent-delete race rationale stay documented (drift to throwing on missing-entry would crash one of the two concurrent close paths)", () => {
    expect(body).toMatch(
      /\*\s+Drop the cached plaintext\. Idempotent — safe to call on already-\s*\*\s+empty entries \(e\.g\. when the route's DELETE handler fires\s*\*\s+concurrent with the runtime's budget-exhausted close\)\./,
    );
  });

  it('TTL + LRU bound pinned (audit wsihqzj39): the cache MUST self-bound so a delete()-less close path (worker-initiated / reaper / sweeper terminal close) cannot retain a decrypted plaintext key unbounded — maxEntries LRU cap (10k default), a 13h TTL (past the 12h orphan cap), an opportunistic expired-entry sweep on set(), and lazy TTL eviction on get(). Drift back to a plain unbounded Map<string,string> would reintroduce the plaintext-key leak', () => {
    // V-730 — the entry now also carries the owning accountId so a clear/rotate
    // can evict it; the self-bounding properties below are unchanged.
    expect(body).toMatch(
      /private readonly cache = new Map<string, \{ key: string; at: number; accountId\?: string \}>\(\);/,
    );
    expect(body).toMatch(/this\.maxEntries = opts\.maxEntries \?\? 10_000;/);
    expect(body).toMatch(/this\.ttlMs = opts\.ttlMs \?\? 13 \* 60 \* 60 \* 1000;/);
    // The expired-entry sweep goes through forget() so the account index is
    // swept with it — the bound itself is unchanged.
    expect(body).toMatch(/if \(now - e\.at > this\.ttlMs\) this\.forget\(id\);/);
    expect(body).toMatch(/while \(this\.cache\.size > this\.maxEntries\)/);
  });
});
