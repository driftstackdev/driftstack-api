// Drift guard for apps/server/src/db/agent-sessions-repo.ts. Pins
// AI-A.c Drizzle implementation of AgentSessionsRepo (migration 0042).
// Key shape rules + token-budget concurrency contract + v2-#19 partial
// unique index for idempotency-key first-write-wins + Arc 2 sub-slice
// 8.2 mode column with DB CHECK default.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/agent-sessions-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/agent-sessions-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-A.c module-level framing pinned: 'Drizzle implementation of AgentSessionsRepo (migration 0042). Production wires this; tests/dev use InMemoryAgentSessionsRepo from services/agent-sessions.ts.' — pinned so the AI-A.c anchor + migration 0042 + production-vs-InMemory split contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-A\.c — Drizzle implementation of AgentSessionsRepo \(migration 0042\)\./,
    );
    expect(body).toMatch(
      /\/\/ Production wires this; tests\/dev use InMemoryAgentSessionsRepo from\s*\n?\s*\/\/ services\/agent-sessions\.ts\./,
    );
  });

  it("4-key-shape rules framing pinned: text PK agt_<uuid> + jsonb transcript append-only via full-row UPDATE rewrite + debitTokens floors remaining at 0 with CHECK remaining<=total + closeWithReason atomic status+closed_reason flip. 'a transcript with 100 messages is ~few KB jsonb' size-rationale. Drift on any of the 4 invariants would either lose atomicity (transcript appends) or break the budget contract (debitTokens floor)", () => {
    expect(body).toMatch(/\/\/\s+- text PK `agt_<uuid>` minted at create\./);
    expect(body).toMatch(
      /\/\/\s+- jsonb transcript starts empty, grows append-only via\s*\n?\s*\/\/\s+appendTranscript \(full-row UPDATE rewrites the jsonb; OK at the\s*\n?\s*\/\/\s+expected per-session volume — a transcript with 100 messages is\s*\n?\s*\/\/\s+~few KB jsonb\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- debitTokens floors remaining at 0 \(matches the in-memory\s*\n?\s*\/\/\s+`Math\.max\(0, \.\.\.\)`\); the CHECK constraint `remaining <= total`\s*\n?\s*\/\/\s+prevents the opposite drift\./,
    );
    expect(body).toMatch(
      /\/\/\s+- closeWithReason flips status to 'closed' \+ writes closed_reason\s*\n?\s*\/\/\s+atomically\./,
    );
  });

  it('Concurrency note framing pinned (CORRECTED — was a false safety claim): debitTokens is a READ-MODIFY-WRITE (get() SELECT then a SEPARATE UPDATE), NOT a single atomic statement, so concurrent same-session debits have a LOST-UPDATE window → the session is UNDER-debited (budget over-served / uncapped bundled-LLM spend). FIX = atomic `GREATEST(0, remaining - $tokens)`, deferred (no real-PG test validates the SQL). Pinned so the accurate race description + the deferred-atomic-fix path stay documented — and so the prior false "single statement / serialize at the row level / bills for both" claim cannot silently return.', () => {
    expect(body).toMatch(
      /\/\/ Concurrency note: debitTokens is a READ-MODIFY-WRITE \(a get\(\) SELECT\s*\n?\s*\/\/ then a SEPARATE UPDATE writing the JS-computed remaining\), NOT a single\s*\n?\s*\/\/ atomic statement\./,
    );
    expect(body).toMatch(/one debit is\s*\n?\s*\/\/ LOST → the session is UNDER-debited/);
    expect(body).toMatch(/FIX = an atomic single-statement decrement/);
    // Guard: the prior false "single statement … serialize at the row level"
    // safety claim must NOT come back.
    expect(body).not.toMatch(/each UPDATE is a single statement, so concurrent/);
  });

  it("rowToRecord field-mapper framing pinned: 'v2-#9 + v2-#19 hardening columns — present on every row even when migration 0047 left them NULL on legacy rows.' + 'Arc 2 sub-slice 8.2 (v2-#8) — pair-mode + GUI-key columns from migration 0052. Existing rows pick up mode=\"ai\" from the CHECK default; null for pair_mode_state + gui_control_key_expires_at.' + mode: (row.mode as 'manual' | 'ai' | 'pair') ?? 'ai' fallback — pinned so the v2-#9/19 + Arc 2 sub-slice 8.2 + migration 0052 + 3-mode enum + 'ai' fallback contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ v2-#9 \+ v2-#19 hardening columns — present on every row even\s*\n?\s*\/\/ when migration 0047 left them NULL on legacy rows\./,
    );
    expect(body).toMatch(
      /\/\/ Arc 2 sub-slice 8\.2 \(v2-#8\) — pair-mode \+ GUI-key columns from\s*\n?\s*\/\/ migration 0052\. Existing rows pick up mode='ai' from the CHECK\s*\n?\s*\/\/ default; null for pair_mode_state \+ gui_control_key_expires_at\./,
    );
    expect(body).toMatch(/mode: \(row\.mode as 'manual' \| 'ai' \| 'pair'\) \?\? 'ai',/);
  });

  it("create agt_<uuid> minting + v2-#19 first-write-wins framing pinned: const id = `agt_${randomUUID()}` + 'v2-#19 hardening columns — partial unique index on (account_id, idempotency_key) enforces \"first-write wins\" if the route layer races two POSTs with the same key. Postgres raises a UniqueViolation; the route layer's findByIdempotencyKey pre-check is the primary dedupe surface.' + 'Arc 2 sub-slice 8.2 — mode forwarded from caller (or default via DB CHECK constraint when args.mode is omitted).' + conditional spread when args.mode is undefined — pinned so the v2-#19 first-write-wins + UniqueViolation-from-Postgres + route-layer-pre-check-is-primary + Arc 2 sub-slice 8.2 DB-CHECK-default-when-omitted contract all stay documented", () => {
    expect(body).toMatch(/const id = `agt_\$\{randomUUID\(\)\}`;/);
    expect(body).toMatch(
      /\/\/ v2-#19 hardening columns — partial unique index on\s*\n?\s*\/\/ \(account_id, idempotency_key\) enforces "first-write wins" if\s*\n?\s*\/\/ the route layer races two POSTs with the same key\. Postgres\s*\n?\s*\/\/ raises a UniqueViolation; the route layer's findByIdempotencyKey\s*\n?\s*\/\/ pre-check is the primary dedupe surface\./,
    );
    expect(body).toMatch(/\.\.\.\(args\.mode !== undefined \? \{ mode: args\.mode \} : \{\}\),/);
  });
});
