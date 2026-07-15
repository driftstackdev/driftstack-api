// Drift guard for apps/server/src/services/agent-sessions.ts. Pins the
// AI-A agent-sessions persistence surface: AgentSessionRecord shape +
// AgentSessionsRepo interface + InMemoryAgentSessionsRepo helper. Pairs
// with services-recipes-content-parity (the cross-table symmetry-anchor
// referenced by recipes' RecipesRepo framing).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-sessions content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-A module-level framing pinned: 'agent-sessions persistence interface (no SQL migration; that follow-up Tier-2 slice lands once the founder reviews the storage shape). The interface + in-memory impl unblock the chat-UI consumers (AI-C dashboard slice) and the executor (AI-B2) so they can wire against a stable contract before the persistent layer lands.' — pinned so the AI-A anchor + the cross-slice unblocking rationale stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-A — agent-sessions persistence interface \(no SQL migration; that\s*\n?\s*\/\/ follow-up Tier-2 slice lands once the founder reviews the storage\s*\n?\s*\/\/ shape\)\. The interface \+ in-memory impl unblock the chat-UI consumers\s*\n?\s*\/\/ \(AI-C dashboard slice\) and the executor \(AI-B2\) so they can wire\s*\n?\s*\/\/ against a stable contract before the persistent layer lands\./,
    );
  });

  it("Design SOT pointer pinned: 'docs/internal/ai-chat-agent-layer-design.md (in-repo) + Wave 1119+ founder verdict moving AI-CHAT from v1.1 → v1.0 launch arc (per the V-361 framing comment in agent-decomposer.ts).' — pinned so the design-doc location + the v1.1→v1.0 promotion verdict + the V-361 cross-reference all survive", () => {
    expect(body).toMatch(
      /\/\/ Design source of truth: `docs\/internal\/ai-chat-agent-layer-design\.md`\s*\n?\s*\/\/ \(in-repo\) \+ Wave 1119\+ founder verdict moving AI-CHAT from v1\.1 → v1\.0\s*\n?\s*\/\/ launch arc \(per the V-361 framing comment in agent-decomposer\.ts\)\./,
    );
  });

  it('AgentSessionStatus 3-state enum pinned: active | paused | closed. Drift would diverge from the SDK + dashboard status discriminator + would break the closedAt invariant (paused stays in "is_open" set, closed transitions out)', () => {
    expect(body).toMatch(/export type AgentSessionStatus = 'active' \| 'paused' \| 'closed';/);
  });

  it("AgentSessionMode 3-value enum pinned: manual | ai | pair. 'ai' default = legacy decompose-driven; 'manual' = pass-through (human drives intents); 'pair' = takeover state-machine (sub-slice 8.7). Drift would silently change behavior for callers omitting mode", () => {
    expect(body).toMatch(/export type AgentSessionMode = 'manual' \| 'ai' \| 'pair';/);
    expect(body).toMatch(
      /Arc 2 sub-slice 8\.2 \(v2-#8\) — operational mode for the agent\s*\n?\s*\*\s+session\. 'ai' \(the default\) keeps the legacy decompose-driven\s*\n?\s*\*\s+behaviour\. 'manual' makes AgentRuntime\.runTurn pass-through —\s*\n?\s*\*\s+the human drives intents directly \(sub-slice 8\.6\)\. 'pair' enables\s*\n?\s*\*\s+the takeover state-machine \(sub-slice 8\.7\)/,
    );
  });

  it("agt_<uuid> id prefix anchor pinned: 'agt_<uuid> id; minted by the repo on create.' — pinned so the cross-resource id-prefix convention stays explicit (agt_ for agent-sessions, rec_ for recipes, ses_ for sessions etc; drift to a different prefix would break test fixtures + log-grep flows that pattern-match on the prefix)", () => {
    expect(body).toMatch(/\/\*\* `agt_<uuid>` id; minted by the repo on create\. \*\//);
  });

  it("driftstackSessionId optional framing pinned: 'NULL when the agent-session is still in pre-plan phase (the customer hasn't reached for the harness yet — chat is happening but no browser session is open). The intent executor (AI-B2 follow-up) is what attaches a session id.' — pinned so the pre-plan-vs-attached-phase split + the AI-B2-attaches-the-id contract stay documented", () => {
    expect(body).toMatch(
      /NULL when the agent-session is still in pre-plan\s*\n?\s*\*\s+phase \(the customer hasn't reached for the harness yet — chat\s*\n?\s*\*\s+is happening but no browser session is open\)\. The intent\s*\n?\s*\*\s+executor \(AI-B2 follow-up\) is what attaches a session id\./,
    );
  });

  it("idempotencyKey framing pinned: 'v2-#9 + v2-#19 — Stripe-pattern idempotency key. NULL when the caller didn't pass an Idempotency-Key header on POST /v1/agent-sessions. Repo enforces (account_id, idempotency_key) uniqueness via the partial unique index from migration 0047. Lookup via findByIdempotencyKey is what the route layer uses to replay a prior 201 response on retry instead of minting a duplicate row.' — pinned so the migration-0047 partial-unique-index + findByIdempotencyKey-replay-pattern cross-reference survive (drift would let duplicate rows mint on retry, breaking the cross-SDK Stripe-pattern contract)", () => {
    expect(body).toMatch(
      /v2-#9 \+ v2-#19 — Stripe-pattern idempotency key\.\s*\n?\s*\*\s+NULL when the caller didn't pass an `Idempotency-Key` header on\s*\n?\s*\*\s+POST \/v1\/agent-sessions\. Repo enforces \(account_id, idempotency_key\)\s*\n?\s*\*\s+uniqueness via the partial unique index from migration 0047\./,
    );
  });

  it('Arc 2 v2-#8 guiControlKey encryption framing pinned: gui_control_key plaintext stored as AES-256-GCM ciphertext blob (Buffer | null), decrypted via decryptGuiControlKey with MFA_ENCRYPTION_KEY env value. Drift to plaintext storage would leak the per-session control key in db dumps + violate the at-rest encryption guarantee', () => {
    expect(body).toMatch(
      /Arc 2 sub-slice 8\.4 \(v2-#8\) — AES-256-GCM ciphertext blob for\s*\n?\s*\*\s+the gui_control_key plaintext\. NULL when no key has been minted\.\s*\n?\s*\*\s+Decrypted at the route layer via `decryptGuiControlKey` with the\s*\n?\s*\*\s+MFA_ENCRYPTION_KEY env value\./,
    );
    expect(body).toMatch(/guiControlKeyCiphertext: Buffer \| null;/);
  });

  it('AgentSessionRecord 16-field shape pinned. Drift to dropping a field would diverge from the cross-SDK AgentSession projection (TS + Go + Python all hand-map to this shape via the route layer)', () => {
    expect(body).toMatch(/export interface AgentSessionRecord \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/driftstackSessionId: string \| null;/);
    expect(body).toMatch(/status: AgentSessionStatus;/);
    expect(body).toMatch(/transcript: ReadonlyArray<TranscriptEntry>;/);
    expect(body).toMatch(/tokenBudgetTotal: number;/);
    expect(body).toMatch(/tokenBudgetRemaining: number;/);
    expect(body).toMatch(/closedReason: string \| null;/);
    expect(body).toMatch(/idempotencyKey: string \| null;/);
    expect(body).toMatch(/createdByUserId: string \| null;/);
    expect(body).toMatch(/closedAt: Date \| null;/);
    expect(body).toMatch(/mode: AgentSessionMode;/);
    expect(body).toMatch(/pairModeState: unknown;/);
    expect(body).toMatch(/guiControlKeyExpiresAt: Date \| null;/);
    expect(body).toMatch(/guiControlKeyCiphertext: Buffer \| null;/);
    expect(body).toMatch(/createdAt: Date;/);
    expect(body).toMatch(/updatedAt: Date;/);
  });

  it('AgentSessionsRepo close contract pins both the compatibility row result and atomic side-effect ownership outcome. Drift would break the executor/dashboard abstraction or let concurrent DELETEs duplicate teardown and audit', () => {
    expect(body).toMatch(/export interface AgentSessionsRepo \{/);
    expect(body).toMatch(/create\(args: CreateAgentSessionArgs\): Promise<AgentSessionRecord>;/);
    expect(body).toMatch(/get\(id: string\): Promise<AgentSessionRecord \| null>;/);
    // Method-name pin only (the surface-existence intent) — the signature gained
    // an optional `opts?: { limit?: number }` for DB-level paging and now wraps
    // across lines, which a full-signature regex can't match.
    expect(body).toMatch(/listByAccount\(/);
    expect(body).toMatch(
      /appendTranscript\(id: string, entry: TranscriptEntry\): Promise<AgentSessionRecord>;/,
    );
    expect(body).toMatch(/appendTranscriptIfActive\(/);
    expect(body).toMatch(/Promise<AgentSessionRecord \| null>;/);
    expect(body).toMatch(/debitTokens\(id: string, tokens: number\): Promise<AgentSessionRecord>;/);
    expect(body).toMatch(
      /debitTokensIfActive\(id: string, tokens: number\): Promise<AgentSessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /closeWithReason\(id: string, reason: string\): Promise<AgentSessionRecord>;/,
    );
    expect(body).toMatch(/export type CloseAgentSessionResult =/);
    expect(body).toMatch(/\| \{ kind: 'closed'; session: AgentSessionRecord \}/);
    expect(body).toMatch(/\| \{ kind: 'already_closed'; session: AgentSessionRecord \};/);
    expect(body).toMatch(
      /closeWithReasonOutcome\(id: string, reason: string\): Promise<CloseAgentSessionResult>;/,
    );
    expect(body).toMatch(/reapOrphanedActiveBefore\(cutoff: Date\): Promise<number>;/);
    // Worker-disconnect fix (2026-06-19, migration 0086) — session→node
    // pointer + node-scoped bulk-close that the disconnect reaper drives.
    expect(body).toMatch(
      /setNodeId\(id: string, nodeId: string\): Promise<AgentSessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /if \(!rec \|\| rec\.status !== 'active'\) return Promise\.resolve\(null\);/,
    );
    expect(body).toMatch(/closeActiveByNode\(nodeId: string, reason: string\): Promise<number>;/);
    // W2813 bootId consumer — node-restart variant that keeps the new boot's
    // reaffirmed sessions. Method-name + keep-set pin (may wrap across lines).
    expect(body).toMatch(/closeActiveByNodeExcept\(/);
    expect(body).toMatch(/keepIds: readonly string\[\]/);
    expect(body).toMatch(
      /findByIdempotencyKey\(\s*\n?\s*accountId: string,\s*\n?\s*idempotencyKey: string,\s*\n?\s*\): Promise<AgentSessionRecord \| null>;/,
    );
    expect(body).toMatch(
      /setPairModeState\(id: string, state: unknown\): Promise<AgentSessionRecord>;/,
    );
    expect(body).toMatch(/compareAndSetPairModeState\(/);
    expect(body).toMatch(/expectedState: unknown/);
    expect(body).toMatch(/nextState: unknown/);
    expect(body).toMatch(/Promise<AgentSessionRecord \| null>;/);
    expect(body).toMatch(
      /setGuiControlKey\(args: \{\s*\n?\s*id: string;\s*\n?\s*ciphertext: Buffer \| null;\s*\n?\s*expiresAt: Date \| null;\s*\n?\s*\}\): Promise<AgentSessionRecord>;/,
    );
  });

  it("InMemoryAgentSessionsRepo framing pinned: 'In-memory implementation for tests + dev mode. Production wires the Drizzle-backed repo (AI-A.c follow-up). The two share this exact interface so the executor + dashboard chat UI never have to know which backend they're talking to.' + 'Thread-safety: the repo is intended for single-threaded use (Node's single event loop suffices for the API server). Concurrent calls to debitTokens on the same id are serialized by the JS event loop.' — pinned so the dual-backend interface + the Node-event-loop thread-safety rationale stay documented", () => {
    expect(body).toMatch(
      /\* In-memory implementation for tests \+ dev mode\. Production wires the\s*\n?\s*\* Drizzle-backed repo \(AI-A\.c follow-up\)\. The two share this exact\s*\n?\s*\* interface so the executor \+ dashboard chat UI never have to know\s*\n?\s*\* which backend they're talking to\./,
    );
    expect(body).toMatch(
      /\* Thread-safety: the repo is intended for single-threaded use \(Node's\s*\n?\s*\* single event loop suffices for the API server\)\. Concurrent calls\s*\n?\s*\* to debitTokens on the same id are serialized by the JS event loop\./,
    );
  });

  it('active-only runtime mutations return null on missing/terminal rows and preserve unconditional fixture compatibility', () => {
    expect(body).toMatch(/appendTranscriptIfActive\(/);
    expect(body).toMatch(/debitTokensIfActive\(/);
    expect((body.match(/rec === undefined \|\| rec\.status !== 'active'/g) ?? []).length).toBe(2);
    expect(body).toMatch(/appendTranscript\(id: string, entry: TranscriptEntry\)/);
    expect(body).toMatch(/debitTokens\(id: string, tokens: number\)/);
  });

  it("agt_inmem_<padded-counter> id prefix pinned. Drift would break test fixtures that grep for 'agt_inmem_' to identify in-memory rows; drift to dropping padStart(8, '0') would let sort-by-id break on 11th+ in-memory row (lexical sort: '10' < '2')", () => {
    expect(body).toMatch(
      /const id = `agt_inmem_\$\{this\.counter\.toString\(\)\.padStart\(8, '0'\)\}`;/,
    );
  });

  it("CreateAgentSessionArgs 5-field shape pinned: accountId + tokenBudgetTotal + driftstackSessionId? + idempotencyKey? + createdByUserId? + mode?. Drift to making tokenBudgetTotal optional would break tier-derived-cap contract (the repo doesn't re-resolve tier per turn — it relies on the create-time cap)", () => {
    expect(body).toMatch(/export interface CreateAgentSessionArgs \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/tokenBudgetTotal: number;/);
    expect(body).toMatch(/driftstackSessionId\?: string;/);
    expect(body).toMatch(/idempotencyKey\?: string;/);
    expect(body).toMatch(/createdByUserId\?: string;/);
    expect(body).toMatch(/mode\?: AgentSessionMode;/);
  });
});
