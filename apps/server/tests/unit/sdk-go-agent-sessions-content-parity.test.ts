// Drift guard for packages/sdk-go/agent_sessions.go.
// Pins the public agent-session surface in idiomatic Go (pointer-
// receiver methods, context-first signatures, *Options structs
// for optional headers).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-go agent_sessions content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('resource framing describes the live typed surface and deployment-dependent availability without roadmap or defer copy', () => {
    expect(body).toMatch(
      /\/\/ AgentSessionsResource provides typed access to \/v1\/agent-sessions\s*\n?\s*\/\/ and its control subresources\./,
    );
    expect(body).toMatch(
      /\/\/ Availability depends on the deployment's agent-runtime configuration\.\s*\n?\s*\/\/ Unsupported deployments return a typed FeatureUnavailable error\./,
    );
    expect(body).not.toMatch(/\bAI-D\b|planning 132|stubs until|compile ahead/i);
  });

  it("LK.5 LiveKitInfo framing pinned: 'LiveKitInfo is the per-Mac LiveKit join info returned on session-create (when a Mac is available) and by the dedicated POST /v1/agent-sessions/:id/livekit-token endpoint.' + 'Token TTL is 24h. Room name is always the agent_session id.' + 'Use with the official livekit-server-sdk-go consumer side.' — pinned so the 24h-TTL + room-name-is-session-id + canonical-livekit-go-sdk reference all stay documented (drift would silently break Go consumers expecting these stable contracts)", () => {
    expect(body).toMatch(
      /\/\/ LK\.5 — LiveKitInfo is the per-Mac LiveKit join info returned on\s*\n?\s*\/\/ session-create \(when a Mac is available\) and by the dedicated\s*\n?\s*\/\/ POST \/v1\/agent-sessions\/:id\/livekit-token endpoint\. Use with\s*\n?\s*\/\/ the official livekit-server-sdk-go consumer side\./,
    );
    expect(body).toMatch(/\/\/ Token TTL is 24h\. Room name is always the agent_session id\./);
  });

  it('LiveKitInfo Go struct 5-field shape pinned: WSURL/Room/Token/ParticipantIdentity/ExpiresAt with snake_case json tags. Drift to PascalCase JSON tags would mismatch the server wire shape; drift to making fields optional pointers would diverge from the TS + Python definitions (all required)', () => {
    expect(body).toMatch(
      /type LiveKitInfo struct \{\s*\n?\s*WSURL\s+string `json:"ws_url"`\s*\n?\s*Room\s+string `json:"room"`\s*\n?\s*Token\s+string `json:"token"`\s*\n?\s*ParticipantIdentity string `json:"participant_identity"`\s*\n?\s*ExpiresAt\s+string `json:"expires_at"`\s*\n?\s*\}/,
    );
  });

  it("AgentSession Go struct ~14-field surface: ID + AccountID + DriftstackSessionID (*string nullable) + Status + ClosedReason (*string nullable) + TokenBudgetTotal/Remaining + TranscriptLength + ClosedAt (*string nullable) + CreatedByUserID (*string nullable) + Mode + CreatedAt + UpdatedAt + LiveKit (*LiveKitInfo,omitempty). Drift to making the nullable fields non-pointer would lose null-distinguishable encoding on Go's JSON marshaller side; drift to dropping omitempty on LiveKit would force pre-LK deployments to render 'livekit:null' instead of omitting", () => {
    expect(body).toMatch(/type AgentSession struct \{/);
    expect(body).toMatch(/ID\s+string\s+`json:"id"`/);
    expect(body).toMatch(/DriftstackSessionID\s+\*string\s+`json:"driftstack_session_id"`/);
    expect(body).toMatch(/ClosedReason\s+\*string\s+`json:"closed_reason"`/);
    expect(body).toMatch(/ClosedAt\s+\*string\s+`json:"closed_at"`/);
    expect(body).toMatch(/CreatedByUserID\s+\*string\s+`json:"created_by_user_id"`/);
    expect(body).toMatch(/Mode\s+string\s+`json:"mode"`/);
    // 6.c — per-session model picker field on the read shape.
    expect(body).toMatch(/Model\s+string\s+`json:"model"`/);
    expect(body).toMatch(/LiveKit\s+\*LiveKitInfo\s+`json:"livekit,omitempty"`/);
    // W2679 — worker-reported per-session liveness (*SessionLiveness,omitempty
    // so a no-fleet-CP deployment omits it rather than rendering 'liveness:null').
    expect(body).toMatch(/Liveness\s+\*SessionLiveness\s+`json:"liveness,omitempty"`/);
    expect(body).toMatch(
      /type SessionLiveness struct \{\s*\n?\s*State \*string `json:"state"`\s*\n?\s*Fresh bool\s+`json:"fresh"`\s*\n?\s*\}/,
    );
  });

  it("CreateAgentSessionRequest Mode-omitempty framing pinned: 'Empty string omits the field on the wire so the server applies its default (ai).' — pinned so the empty-string-as-omit pattern + the 'ai' server default survive (drift to a different default OR to sending the empty string literal would silently break server's default-mode behavior)", () => {
    expect(body).toMatch(
      /\/\/ Arc 2 sub-slice 8\.5 \(v2-#8\) — operational mode\. Empty string\s*\n?\s*\/\/ omits the field on the wire so the server applies its default\s*\n?\s*\/\/ \('ai'\)\./,
    );
    expect(body).toMatch(/Mode string `json:"mode,omitempty"`/);
    // 6.c — model picker field on the request shape (omitempty → server default).
    expect(body).toMatch(/Model string `json:"model,omitempty"`/);
    // file 57 — attach a saved profile to the session (omitempty → stateless).
    // Drift to dropping it strands the live profile-backed-session feature
    // with no Go SDK surface.
    expect(body).toMatch(/ProfileID string `json:"profile_id,omitempty"`/);
  });

  it('AgentMessageResponse discriminated union: \'Branch on Kind: "plan-executed" (Intents + Results + OK populated), "clarify" (ClarifyingQuestion populated), or "refuse" (RefuseReason populated).\' — pinned so the 3-variant discriminator framing stays documented (note: logged-manual is implicit via Kind="logged-manual" + only Session populated; drift to dropping discriminator framing would force Go callers to guess which fields to read)', () => {
    expect(body).toMatch(
      /\/\/ AgentMessageResponse is the discriminated turn-result\. Branch on\s*\n?\s*\/\/ Kind: "plan-executed" \(Intents \+ Results \+ OK populated\),\s*\n?\s*\/\/ "clarify" \(ClarifyingQuestion populated\), or "refuse"\s*\n?\s*\/\/ \(RefuseReason populated\)\./,
    );
  });

  it("CreateOptions Stripe-pattern Idempotency-Key framing pinned: 'IdempotencyKey is the v2-#19 Stripe-pattern idempotency token. Forwarded as the Idempotency-Key request header so retries collapse onto the same server-side row. Server enforces (account_id, idempotency_key) uniqueness via a partial unique index; SDK just plumbs the header.' — pinned so the partial-unique-index contract + the SDK-just-plumbs framing survive", () => {
    expect(body).toMatch(
      /\/\/ IdempotencyKey is the v2-#19 Stripe-pattern idempotency token\.\s*\n?\s*\/\/ Forwarded as the Idempotency-Key request header so retries collapse\s*\n?\s*\/\/ onto the same server-side row\. Server enforces \(account_id,\s*\n?\s*\/\/ idempotency_key\) uniqueness via a partial unique index; SDK just\s*\n?\s*\/\/ plumbs the header\./,
    );
  });

  it("MessageOptions ByokAPIKey 'NEVER logged' framing pinned: 'ByokAPIKey is the customer-supplied Anthropic API key (BYOK Tier-3 LOCKED 2026-05-16). Forwarded as the x-byok-anthropic-api-key request header so callers don't construct it by hand. NEVER logged.' — pinned so the NEVER-logged guarantee + the BYOK Tier-3 lock-date stay documented (drift to logging the key would leak customer Anthropic credentials)", () => {
    expect(body).toMatch(
      /\/\/ ByokAPIKey is the customer-supplied Anthropic API key \(BYOK Tier-3\s*\n?\s*\/\/ LOCKED 2026-05-16\)\. Forwarded as the x-byok-anthropic-api-key\s*\n?\s*\/\/ request header so callers don't construct it by hand\. NEVER logged\./,
    );
  });

  it('MessageOptions carries a durable IdempotencyKey and merges it beside BYOK without emitting empty headers', () => {
    expect(body).toMatch(/IdempotencyKey\s+string/);
    expect(body).toMatch(/Reuse it after a lost or\s*\n?\s*\/\/ ambiguous stream/);
    expect(body).toMatch(/headers\["Idempotency-Key"\] = opts\.IdempotencyKey/);
    expect(body).toMatch(/if len\(headers\) > 0 \{\s*\n?\s*req\.headers = headers/);
  });

  it('AgentSessionsResource 11-method surface: Create + Get + List + Message + Close + SetMode + SendInputEvent + Takeover + Handback + LivekitToken + Resume. Drift to dropping a method would break cross-SDK uniformity (TS + Python have the same set); drift to changing signature would break Go consumers using the context.Context-first idiom', () => {
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Create\(ctx context\.Context, body \*CreateAgentSessionRequest, opts \*CreateOptions\) \(\*AgentSession, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Get\(ctx context\.Context, agentSessionID string\) \(\*AgentSession, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) List\(ctx context\.Context, query \*ListAgentSessionsQuery\) \(\*AgentSessionsListPage, error\)/,
    );
    // sweep-3 — cursor pagination: { data, has_more, next_cursor } + an Iterate
    // walker (was a non-paginated { data } hard-capped at 100).
    expect(body).toMatch(
      /type AgentSessionsListPage struct \{[\s\S]*?Data\s+\[\]AgentSession[\s\S]*?HasMore\s+bool[\s\S]*?NextCursor\s+\*string/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Iterate\(ctx context\.Context, query \*ListAgentSessionsQuery, fn func\(\*AgentSession\) \(bool, error\)\) error/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Message\(ctx context\.Context, agentSessionID, userMessage string, opts \*MessageOptions\) \(\*AgentMessageResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Close\(ctx context\.Context, agentSessionID string\) error/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) SetMode\(ctx context\.Context, agentSessionID, mode string\) \(\*AgentSession, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) SendInputEvent\(ctx context\.Context, agentSessionID string, event map\[string\]any, opts \*SendInputEventOptions\) \(\*SendInputEventResponse, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Takeover\(ctx context\.Context, agentSessionID, clientID string\) \(\*PairModeStateEnvelope, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Handback\(ctx context\.Context, agentSessionID string\) \(\*PairModeStateEnvelope, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) LivekitToken\(ctx context\.Context, agentSessionID string\) \(\*LiveKitInfo, error\)/,
    );
    // W474 — Resume after a resolved bot-challenge; optional *ResumeAgentSessionRequest body.
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) Resume\(ctx context\.Context, agentSessionID string, body \*ResumeAgentSessionRequest\) \(\*ResumeAgentSessionResponse, error\)/,
    );
  });

  it("PairModeStateEnvelope framing pinned: 'pair_mode_state field carries the post-transition state discriminator (takeover-pending / takeover-queued / handback-pending / handback-queued) so callers can branch on whether the request was queued behind an in-flight decompose without a separate GET round-trip.' — pinned so the 4-state discriminator + the no-extra-GET rationale survive", () => {
    expect(body).toMatch(
      /\/\/ PairModeStateEnvelope is the response shape for Takeover \+ Handback\.\s*\n?\s*\/\/ The pair_mode_state field carries the post-transition state\s*\n?\s*\/\/ discriminator \(takeover-pending \/ takeover-queued \/ handback-pending\s*\n?\s*\/\/ \/ handback-queued\) so callers can branch on whether the request was\s*\n?\s*\/\/ queued behind an in-flight decompose without a separate GET round-trip\./,
    );
  });

  it("Takeover state-machine framing pinned: 'ai-driving → takeover-pending (or takeover-queued if the runtime is mid-decompose)' + 'Returns 409 PairModeStateInvalidTransitionError if the session is not in a state that permits takeover. Returns 409 ConflictError if the session is not mode=\\'pair\\'.' — pinned so the 2-way 409 mapping (state-invalid vs mode-mismatch) stays explicit", () => {
    expect(body).toMatch(
      /\/\/ State machine: ai-driving → takeover-pending \(or takeover-queued if\s*\n?\s*\/\/ the runtime is mid-decompose\)\./,
    );
    expect(body).toMatch(
      /\/\/ Returns 409 PairModeStateInvalidTransitionError if the session is\s*\n?\s*\/\/ not in a state that permits takeover\. Returns 409 ConflictError if\s*\n?\s*\/\/ the session is not mode='pair'\./,
    );
  });

  it('LivekitToken LK.3 framing + 3-error catalog pinned: 403 closed + 404 unknown/cross-account + 503 no Mac. Same as TS + Python; cross-SDK parity is the load-bearing test here (drift on one SDK silently diverges the documented error contract from its peers)', () => {
    expect(body).toMatch(
      /\/\/ LivekitToken mints a fresh LiveKit JWT for the agent session's\s*\n?\s*\/\/ video room\./,
    );
    expect(body).toMatch(
      /\/\/ Errors \(mapped to typed Driftstack errors\):\s*\n?\s*\/\/ {3}- 403 — session is closed; cannot mint\s*\n?\s*\/\/ {3}- 404 — session unknown \(or cross-account; existence not leaked\)\s*\n?\s*\/\/ {3}- 503 — no Mac registered LiveKit yet, OR the stored Mac secret\s*\n?\s*\/\/ {5}can't be decrypted \(operator action: re-run\s*\n?\s*\/\/ {5}POST \/v1\/mac-nodes\/register\)/,
    );
  });

  it('url.PathEscape on all id-bearing routes pinned (Get/Message/Close/SetMode/SendInputEvent/Takeover/Handback/LivekitToken). Drift to dropping url.PathEscape would break Go consumers whose session ids contain reserved URI chars + diverge from TS encodeURIComponent + Python quote(...,safe="") parity', () => {
    expect(body).toMatch(/"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\)/);
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/message"/,
    );
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/mode"/,
    );
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/input-event"/,
    );
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/takeover"/,
    );
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/handback"/,
    );
    expect(body).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/livekit-token"/,
    );
  });
});
