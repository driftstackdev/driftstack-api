// Drift guard for packages/sdk-typescript/src/resources/agent-sessions.ts.
// Pins the AI-chat route surface (commit 611ddc8f) + the 6-method shape +
// the AgentSession discriminated-union return + the BYOK header threading
// + the Stripe-pattern Idempotency-Key plumb-through.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-typescript resources/agent-sessions content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Module-level AgentSessionsResource framing pins stable provider availability without internal rollout mechanics', () => {
    expect(body).toMatch(
      /\/\/ AgentSessionsResource — typed methods for \/v1\/agent-sessions\/\*\./,
    );
    expect(body).toMatch(
      /AI-backed operations depend on the deployment's configured BYOK or\s*\n?\s*\/\/ bundled-LLM provider\. Deployments without one return the stable\s*\n?\s*\/\/ FeatureUnavailableError; the remaining session surface stays available\./,
    );
    expect(body).not.toMatch(/503 stub|until AI chat ships|activation gate/);
  });

  it('LiveKitInfo interface pinned: ws_url + room + token + participant_identity + expires_at (all required, all strings). Drift to optional or shape-change would break livekit-client.Room.connect contract', () => {
    expect(body).toMatch(
      /export interface LiveKitInfo \{\s*\n?\s*ws_url: string;\s*\n?\s*room: string;\s*\n?\s*token: string;\s*\n?\s*participant_identity: string;\s*\n?\s*expires_at: string;\s*\n?\s*\}/,
    );
  });

  it("LK.5 framing on LiveKitInfo pinned: 'optionally returned on session-create + always returned by POST /v1/agent-sessions/:id/livekit-token. Use these fields with livekit-client's Room.connect(ws_url, token). Token TTL is 24h; re-mint via the dedicated /livekit-token endpoint after expiry.' — pinned so the dual-path delivery (auto-populate on create OR explicit mint) + the 24h TTL + the re-mint flow all stay documented", () => {
    expect(body).toMatch(
      /LK\.5 — LiveKit join info, optionally returned on session-create\s*\n?\s*\*\s+\+ always returned by POST \/v1\/agent-sessions\/:id\/livekit-token\./,
    );
    expect(body).toMatch(
      /Token TTL is 24h; re-mint via the dedicated \/livekit-\s*\n?\s*\*\s+token endpoint after expiry\./,
    );
  });

  it('AgentSession interface 17-field surface: id/account_id/driftstack_session_id/status/closed_reason/token_budget_total/token_budget_remaining/transcript_length/closed_at/created_by_user_id/mode/pair_mode_state/created_at/updated_at/livekit (optional)/liveness (optional, W2679). Drift to dropping a field would break customers reading that field; drift to making livekit/liveness required would break pre-LK / no-fleet-CP deployments where the field is absent', () => {
    expect(body).toMatch(/export interface AgentSession \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/driftstack_session_id: string \| null;/);
    expect(body).toMatch(/status: 'active' \| 'paused' \| 'closed';/);
    expect(body).toMatch(/closed_reason: string \| null;/);
    expect(body).toMatch(/token_budget_total: number;/);
    expect(body).toMatch(/token_budget_remaining: number;/);
    expect(body).toMatch(/transcript_length: number;/);
    expect(body).toMatch(/closed_at: string \| null;/);
    expect(body).toMatch(/created_by_user_id: string \| null;/);
    expect(body).toMatch(/mode: 'manual' \| 'ai' \| 'pair';/);
    // 6.c — per-session model picker field on the read shape.
    expect(body).toMatch(
      /model: 'claude-opus-4-8' \| 'claude-opus-4-7' \| 'claude-sonnet-4-6' \| 'claude-haiku-4-5';/,
    );
    expect(body).toMatch(/pair_mode_state: \{ kind: string; \[k: string\]: unknown \} \| null;/);
    expect(body).toMatch(/livekit\?: LiveKitInfo;/);
    // W2679 — worker-reported per-session liveness (optional; absent = unknown,
    // trust the binding). state nullable; fresh = beat-staleness guard.
    expect(body).toMatch(
      /liveness\?: \{ state: 'active' \| 'provisioning' \| 'idle' \| 'terminating' \| null; fresh: boolean \};/,
    );
  });

  it('Arc 2 v2-#8 mode framing on CreateAgentSessionRequest pinned: \'Defaults to "ai" (legacy decompose-driven runtime). "manual" makes runTurn a pass-through so the customer drives intents directly. "pair" enables the takeover state-machine (sub-slice 8.7).\' — pinned so the 3-mode semantics + default + pair-mode anchor stay documented (drift to a different default would silently change behavior for callers omitting mode)', () => {
    expect(body).toMatch(
      /Arc 2 sub-slice 8\.5 \(v2-#8 AI chat \+ manual\)\. Defaults to 'ai'\s*\n?\s*\*\s+\(legacy decompose-driven runtime\)\. 'manual' makes runTurn a\s*\n?\s*\*\s+pass-through so the customer drives intents directly\. 'pair'\s*\n?\s*\*\s+enables the takeover state-machine \(sub-slice 8\.7\)\./,
    );
  });

  it('CreateAgentSessionRequest exposes optional profile_id (file 57 — attach a saved profile to the session). Drift to dropping it strands the live server-side profile-backed-session feature with no SDK surface for customers.', () => {
    expect(body).toMatch(/profile_id\?: string;/);
  });

  it('CreateAgentSessionRequest exposes optional initial_url (customer-settable start URL the remote browser opens on launch; http(s)-only, validated server-side). Drift to dropping it removes the SDK surface for the Settings → Start URL feature.', () => {
    expect(body).toMatch(/initial_url\?: string;/);
  });

  it('CreateAgentSessionRequest exposes optional geolocation override (A3-approved contract 2026-07-01 — explicit device coordinates overriding the proxy-exit auto-derive). Drift to dropping it removes the SDK surface for per-session geo.', () => {
    expect(body).toMatch(
      /geolocation\?: \{ latitude: number; longitude: number; accuracy\?: number \};/,
    );
  });

  it('AgentIntent 4-kind union: navigate / interact / wait / capture. Drift to dropping a kind would break the executor contract; drift to adding an undeclared kind would render as TS error in callers using exhaustive switch', () => {
    expect(body).toMatch(/\{ kind: 'navigate'; url: string \}/);
    expect(body).toMatch(
      /kind: 'interact';\s*\n?\s*action: 'tap' \| 'type' \| 'scroll' \| 'swipe' \| 'press';/,
    );
    expect(body).toMatch(
      /\{ kind: 'wait'; condition: 'idle' \| 'selector_visible'; selector\?: string; timeoutMs\?: number \}/,
    );
    expect(body).toMatch(/\{ kind: 'capture'; capture: 'screenshot' \| 'dom_snapshot' \| 'pdf' \}/);
  });

  it("AgentMessageResponse 4-variant discriminated union: plan-executed / clarify / refuse / logged-manual. Drift to dropping a variant would break the chat UI's exhaustive switch (e.g. dropping logged-manual would leave manual-mode responses as never-handled)", () => {
    expect(body).toMatch(/kind: 'plan-executed';/);
    expect(body).toMatch(/kind: 'clarify';/);
    expect(body).toMatch(/kind: 'refuse';/);
    expect(body).toMatch(/kind: 'logged-manual';/);
  });

  it("AI-chat confirmation + usage surface pinned: ConsequentialActionCategory + AgentUsage types, the confirmation_required AgentIntentResult variant ({category, matchedText} echoed for approval), usage? on plan-executed/clarify/refuse, and message()'s approveConsequentialActions opt mapped to the wire snake_case approve_consequential_actions. Drift would break the AI-chat Approve/Deny safety-gate round-trip + the per-turn cost badge", () => {
    expect(body).toMatch(
      /export type ConsequentialActionCategory = 'purchase' \| 'payment' \| 'account_deletion';/,
    );
    expect(body).toMatch(/export interface AgentUsage \{/);
    expect(body).toMatch(/decomposer_kind: 'claude' \| 'deterministic';/);
    // confirmation_required intent-result variant carries the echo-back fields.
    expect(body).toMatch(/kind: 'confirmation_required';/);
    expect(body).toMatch(/category: ConsequentialActionCategory;/);
    expect(body).toMatch(/matchedText: string;/);
    // usage? attached to the three substantive response variants.
    expect(body).toMatch(/usage\?: AgentUsage;/);
    // message() accepts approvals + maps them to the wire snake_case shape.
    expect(body).toMatch(/approveConsequentialActions\?: ReadonlyArray</);
    expect(body).toMatch(/approve_consequential_actions: approvals\.map/);
    expect(body).toMatch(/matched_text: a\.matchedText,/);
  });

  it('AgentSessionsResource 10-method surface: create + get + message + close + setMode + sendInputEvent + takeover + handback + livekitToken + resume (W474). Drift to dropping a method would break dashboard + e2e tests that compile against it; drift to changing signature would silently break the wire contract', () => {
    expect(body).toMatch(/export class AgentSessionsResource \{/);
    expect(body).toMatch(/create\(\s*\n?\s*body: CreateAgentSessionRequest = \{\},/);
    expect(body).toMatch(/get\(id: string\): Promise<AgentSession>/);
    expect(body).toMatch(
      /message\(\s*\n?\s*id: string,\s*\n?\s*userMessage: string,\s*\n?\s*opts\?: \{[\s\S]*?byokApiKey\?: string;[\s\S]*?approveConsequentialActions\?:[\s\S]*?\},\s*\n?\s*\): Promise<AgentMessageResponse>/,
    );
    expect(body).toMatch(/close\(id: string\): Promise<void>/);
    expect(body).toMatch(
      /setMode\(id: string, mode: 'manual' \| 'ai' \| 'pair'\): Promise<AgentSession>/,
    );
    expect(body).toMatch(
      /sendInputEvent\(\s*\n?\s*id: string,\s*\n?\s*event: InputEvent,\s*\n?\s*opts\?: \{ clientId\?: string \},\s*\n?\s*\): Promise<SendInputEventResponse>/,
    );
    expect(body).toMatch(/takeover\(\s*\n?\s*id: string,\s*\n?\s*clientId: string,\s*\n?\s*\)/);
    expect(body).toMatch(/handback\(id: string\)/);
    expect(body).toMatch(/livekitToken\(id: string\): Promise<LiveKitInfo>/);
    expect(body).toMatch(
      /resume\(\s*\n?\s*id: string,\s*\n?\s*body: \{ challenge_id\?: string \} = \{\},\s*\n?\s*\): Promise<\{ status: 'resume_requested'; session_id: string \}>/,
    );
  });

  it("Stripe-pattern Idempotency-Key framing on create() pinned: 'Forward as the Idempotency-Key request header so retries collapse onto the server's first 201 response. The server-side partial unique index on (account_id, idempotency_key) is what guarantees the dedupe end-to-end; SDK just plumbs the header.' — pinned so the SDK-plumbs-only-not-the-source-of-dedupe rationale survives (drift to client-side dedupe would mask the load-bearing partial-unique-index contract)", () => {
    expect(body).toMatch(
      /v2-#19 — Stripe-pattern idempotency\. Forward as the\s*\n?\s*\/\/ `Idempotency-Key` request header so retries collapse onto the\s*\n?\s*\/\/ server's first 201 response\./,
    );
    expect(body).toMatch(
      /\.\.\.\(opts\?\.idempotencyKey !== undefined\s*\n?\s*\? \{ headers: \{ 'Idempotency-Key': opts\.idempotencyKey \} \}\s*\n?\s*: \{\}\),/,
    );
  });

  it("BYOK Anthropic key threading on message() pinned: x-byok-anthropic-api-key header forwarded ONLY when byokApiKey is defined AND non-empty + 'NEVER logged by the SDK; the key arrives over TLS to the control plane.' — pinned so the empty-string skip + the never-logged guarantee survive (drift to logging the key would leak customer Anthropic keys into observability tooling; drift to forwarding empty strings would send a literal `x-byok-anthropic-api-key:` on the wire)", () => {
    expect(body).toMatch(
      /`byokApiKey` \(optional\) is the customer-supplied Anthropic API\s*\n?\s*\*\s+key \(BYOK Tier-3 LOCKED 2026-05-16\)\. Forwarded via the\s*\n?\s*\*\s+`x-byok-anthropic-api-key` request header/,
    );
    expect(body).toMatch(
      /NEVER logged by the SDK; the key\s*\n?\s*\*\s+arrives over TLS to the control plane\./,
    );
    expect(body).toMatch(
      /\.\.\.\(opts\?\.byokApiKey !== undefined && opts\.byokApiKey\.length > 0\s*\n?\s*\? \{ 'x-byok-anthropic-api-key': opts\.byokApiKey \}\s*\n?\s*: \{\}\),/,
    );
  });

  it('message() exposes and forwards a caller-reusable durable logical-turn Idempotency-Key beside SSE/BYOK', () => {
    expect(body).toMatch(/idempotencyKey\?: string;/);
    expect(body).toMatch(/Reuse it when retrying after a lost\/ambiguous stream/);
    expect(body).toMatch(
      /\.{3}\(opts\?\.idempotencyKey !== undefined\s*\n?\s*\? \{ 'Idempotency-Key': opts\.idempotencyKey \}\s*\n?\s*: \{\}\),/,
    );
  });

  it("takeover() + handback() pair-mode state-machine framing pinned: 'transitions ai-driving → takeover-pending (or takeover-queued if the runtime is mid-decompose)' + 'transitions human-driving → handback-pending (or handback-queued if the runtime is mid-decompose)' + Throws PairModeStateInvalidTransitionError (409) — pinned so the queued-vs-pending discriminant + the 409 error type stay documented (drift would break the pair-mode UI's state-transition handling)", () => {
    expect(body).toMatch(
      /transitions\s*\n?\s*\*\s+`ai-driving → takeover-pending` \(or `takeover-queued` if the\s*\n?\s*\*\s+runtime is mid-decompose\)/,
    );
    expect(body).toMatch(
      /transitions `human-driving → handback-pending` \(or\s*\n?\s*\*\s+`handback-queued` if the runtime is mid-decompose\)/,
    );
    expect(body).toMatch(/Throws `PairModeStateInvalidTransitionError` \(409\)/);
  });

  it("livekitToken() LK.3 framing + 3-error catalog pinned: 403 (closed) + 404 (unknown / cross-account) + 503 (no Mac registered OR can't decrypt). Drift to dropping the 404-also-covers-cross-account framing would leak existence; drift to dropping the 503 operator-action hint would leave operators guessing why no token is being minted", () => {
    expect(body).toMatch(
      /LK\.3 — mint a fresh LiveKit JWT for the agent session's video\s*\n?\s*\*\s+room\./,
    );
    expect(body).toMatch(/- 403 — session is closed; can't mint/);
    expect(body).toMatch(/- 404 — session unknown \(or cross-account; existence not leaked\)/);
    expect(body).toMatch(
      /- 503 — no Mac registered LiveKit yet, OR the stored Mac\s*\n?\s*\*\s+secret can't be decrypted \(operator action — re-run\s*\n?\s*\*\s+POST \/v1\/mac-nodes\/register\)/,
    );
  });

  it('HTTP path-segment encodeURIComponent pinned on all id-bearing routes (get/message/close/setMode/sendInputEvent/takeover/handback/livekitToken). Drift to dropping encodeURIComponent would break customers whose session ids contain reserved URI chars (rare but real — esp. on legacy ids before the prefix-normalization)', () => {
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/message`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/mode`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/input-event`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/takeover`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/handback`/);
    expect(body).toMatch(/`\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/livekit-token`/);
  });
});
