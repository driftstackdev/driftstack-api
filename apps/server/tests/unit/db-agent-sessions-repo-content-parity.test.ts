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

  it('4-key-shape rules framing pinned: text PK agt_<uuid> + record-bound v2 jsonb transcript append-only via full-row UPDATE rewrite + debitTokens floors remaining at 0 with CHECK remaining<=total + closeWithReason atomic status+closed_reason flip. Bootstrap drains legacy rows before serving; drift on any invariant would risk plaintext, relocation, lost appends, or budget breakage', () => {
    expect(body).toMatch(/\/\/\s+- text PK `agt_<uuid>` minted at create\./);
    expect(body).toMatch(
      /\/\/\s+- jsonb transcript stores a versioned application-encrypted envelope and\s*\n?\s*\/\/\s+grows append-only via appendTranscript \(full-row UPDATE rewrites the\s*\n?\s*\/\/\s+encrypted jsonb; OK at the expected per-session volume — a transcript\s*\n?\s*\/\/\s+with 100 messages is ~few KB jsonb\)\. Ordinary reads accept only the\s*\n?\s*\/\/\s+purpose\/account\/session-bound v2 envelope; bootstrap CAS-converts every\s*\n?\s*\/\/\s+plaintext\/v1 row to v2 before the app starts serving\./,
    );
    expect(body).toMatch(
      /\/\/\s+- debitTokens floors remaining at 0 \(matches the in-memory\s*\n?\s*\/\/\s+`Math\.max\(0, \.\.\.\)`\); the CHECK constraint `remaining <= total`\s*\n?\s*\/\/\s+prevents the opposite drift\./,
    );
    expect(body).toMatch(
      /\/\/\s+- closeWithReason flips status to 'closed' \+ writes closed_reason\s*\n?\s*\/\/\s+atomically\./,
    );
  });

  it('binds every production write/read to account+session, keeps ordinary reads v2-only, and CAS-migrates legacy rows before serving', () => {
    expect(body).toMatch(
      /encryptAgentSessionTranscript\(\[\], key, \{\s*accountId: args\.accountId,\s*sessionId: id,\s*\}\)/,
    );
    expect(body).toMatch(/readAgentSessionTranscript\(existing\.transcript, key, context\)/);
    expect(body).toMatch(/encryptAgentSessionTranscript\(nextTranscript, key, context\)/);
    expect(body).toMatch(/\.set\(\{ transcript: encryptedTranscript, updatedAt: now \}\)/);
    expect(body).toMatch(/throw new Error\('Agent transcript encryption key is unavailable\.'\)/);
    expect(body).toMatch(/async migrateTranscriptEnvelopes\(/);
    expect(body).toMatch(/readAgentTranscript\(v1Probe\.transcript, key\)/);
    expect(body).toMatch(/readAgentSessionTranscript\(v2Probe\.transcript, key,/);
    expect(body).toMatch(/const prepared = rows\.map\(\(row\) => \(\{/);
    expect(body).toMatch(
      /\$\{agentSessions\.transcript\} IS NOT DISTINCT FROM \$\{JSON\.stringify\(row\.transcript\)\}::jsonb/,
    );
    expect(body).toMatch(/\.set\(\{ transcript: nextTranscript \}\)/);
    expect(body).not.toMatch(/readAgentTranscript\(\s*existing\.transcript/);
  });

  it('Concurrency note framing pinned (race CLOSED): debitTokens AND appendTranscript run their read-modify-write inside a db.transaction() that SELECTs the row FOR UPDATE first (mirrors setAccountTier), so the row lock SERIALISES concurrent same-session debits/appends — no debit lost (no under-billing), no transcript entry dropped (no data loss). Pinned so the atomic FOR-UPDATE approach stays documented, the false "single statement … serialize at the row level" claim cannot return, AND the now-fixed code cannot silently regress to a bare read-modify-write without this pin failing.', () => {
    expect(body).toMatch(
      /\/\/ Concurrency note: debitTokens AND appendTranscript perform their\s*\n?\s*\/\/ read-modify-write inside a `db\.transaction\(\)` that SELECTs the row\s*\n?\s*\/\/ `FOR UPDATE` before mutating/,
    );
    expect(body).toMatch(/row lock SERIALISES concurrent same-session debits\/appends/);
    expect(body).toMatch(/no transcript entry is dropped \(no data loss\)/);
    // The fix must actually be present in BOTH methods: a FOR-UPDATE select
    // inside a transaction. Regressing to a bare read-modify-write fails here.
    expect(body).toMatch(/\.for\('update'\)/);
    expect(
      (body.match(/this\.database\.db\.transaction\(async \(tx\) =>/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    // Guard: the prior false "single statement … serialize at the row level"
    // safety claim must NOT come back.
    expect(body).not.toMatch(/each UPDATE is a single statement, so concurrent/);
  });

  it('active-only transcript and debit variants lock and re-check status=active so a committed close winner is immutable', () => {
    expect(body).toMatch(/async appendTranscriptIfActive\(/);
    expect(body).toMatch(/async debitTokensIfActive\(/);
    expect(
      (
        body.match(/and\(eq\(agentSessions\.id, id\), eq\(agentSessions\.status, 'active'\)\)/g) ??
        []
      ).length,
    ).toBeGreaterThanOrEqual(4);
    expect((body.match(/\.for\('update'\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('active-only GUI-key and mode setters predicate the metadata write itself on status=active', () => {
    expect(body).toMatch(/async setGuiControlKeyIfActive\(/);
    expect(body).toMatch(/async setModeIfActive\(/);
    expect(body).toMatch(
      /\.where\(and\(eq\(agentSessions\.id, args\.id\), eq\(agentSessions\.status, 'active'\)\)\)/,
    );
    expect(body).toMatch(
      /\.where\(and\(eq\(agentSessions\.id, id\), eq\(agentSessions\.status, 'active'\)\)\)/,
    );
    expect(
      (
        body.match(
          /return row \? rowToRecord\(row, this\.transcriptEncryptionKeyBase64\) : null/g,
        ) ?? []
      ).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('createIfUnderActiveCap uses the canonical cross-surface profile lock, checks both agent + legacy live tables, and returns the competing public session id', () => {
    expect(body).toMatch(/import \{ agentSessions, sessions \} from '\.\/schema\.js';/);
    expect(body).toMatch(
      /import \{ profileSessionAdvisoryLockKey \} from '\.\/profile-session-lock\.js';/,
    );
    expect(body).toMatch(
      /SELECT pg_advisory_xact_lock\(hashtext\(\$\{profileSessionAdvisoryLockKey\(args\.profileId\)\}\)\)/,
    );
    expect(body).toMatch(/eq\(agentSessions\.profileId, args\.profileId\)/);
    expect(body).toMatch(/notInArray\(agentSessions\.status, \['closed'\]\)/);
    expect(body).toMatch(/throw new ProfileInUseError\(liveAgent\.id\)/);
    expect(body).toMatch(/\$\{sessions\.metadata\}->>'profile_id' = \$\{args\.profileId\}/);
    expect(body).toMatch(/notInArray\(sessions\.status, \['destroyed', 'errored'\]\)/);
    expect(body).toMatch(/isNull\(sessions\.destroyedAt\)/);
    expect(body).toMatch(/throw new ProfileInUseError\(`ses_\$\{liveLegacy\.id\}`\)/);
    expect(body).not.toMatch(/agent-session-profile:/);
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

  it('pair-mode transitions use one structural compare-and-set UPDATE gated by active status and pair mode, including the legacy SQL-NULL state', () => {
    expect(body).toMatch(/async compareAndSetPairModeState\(/);
    expect(body).toMatch(/expectedState === null\s*\? isNull\(agentSessions\.pairModeState\)/);
    expect(body).toMatch(
      /sql`\$\{agentSessions\.pairModeState\} IS NOT DISTINCT FROM \$\{expectedJson\}::jsonb`/,
    );
    expect(body).toMatch(/eq\(agentSessions\.status, 'active'\)/);
    expect(body).toMatch(/eq\(agentSessions\.mode, 'pair'\)/);
    expect(body).toMatch(
      /return row \? rowToRecord\(row, this\.transcriptEncryptionKeyBase64\) : null/,
    );
  });

  it('setNodeId is an atomic active-only ownership claim, so a terminal row can never receive a late fleet assignment', () => {
    expect(body).toMatch(/async setNodeId\(id: string, nodeId: string\)/);
    expect(body).toMatch(
      /\.where\(and\(eq\(agentSessions\.id, id\), eq\(agentSessions\.status, 'active'\)\)\)/,
    );
    expect(body).toMatch(
      /return row \? rowToRecord\(row, this\.transcriptEncryptionKeyBase64\) : null/,
    );
  });

  it('closeWithReasonOutcome atomically elects one close side-effect owner while preserving closeWithReason compatibility', () => {
    expect(body).toMatch(/return \(await this\.closeWithReasonOutcome\(id, reason\)\)\.session;/);
    expect(body).toMatch(/async closeWithReasonOutcome\(/);
    expect(body).toMatch(/notInArray\(agentSessions\.status, \['closed'\]\)/);
    expect(body).toMatch(/return \{ kind: 'closed', session:/);
    expect(body).toMatch(/return \{ kind: 'already_closed', session: existing \};/);
  });
});
