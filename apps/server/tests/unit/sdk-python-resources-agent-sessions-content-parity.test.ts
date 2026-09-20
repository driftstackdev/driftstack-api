// Drift guard for packages/sdk-python/src/driftstack/resources/
// agent_sessions.py. Pins the public Python agent-session surface:
// TypedDict LiveKitInfo + sync/async mirror + the 7-method
// shape + BYOK header + Stripe-pattern Idempotency-Key + the
// LK.3 5-field worked example.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/agent_sessions.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/agent_sessions content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('module framing describes the live typed surface and deployment-dependent availability without roadmap or defer copy', () => {
    expect(body).toMatch(/"""Typed access to \/v1\/agent-sessions and its control subresources\./);
    expect(body).toMatch(
      /Availability depends on the deployment's agent-runtime configuration\.\s*Unsupported deployments return typed ``FeatureUnavailable`` errors\./,
    );
    expect(body).not.toMatch(/\bAI-D\b|planning 132|aadc3ffb|stubs until|compile ahead/i);
  });

  it('Discriminated message-response framing pinned: branch on `["kind"]` — plan-executed (intents + results + ok, and answer or answer_unavailable, and notice) / clarify (clarifying_question) / refuse (refuse_reason) / stopped (results + notice). Drift would force Python callers to introspect undocumented response shapes', () => {
    expect(body).toMatch(
      /Discriminated message response: branch on ``\["kind"\]`` —\s*``plan-executed`` \(carries ``intents`` \+ ``results`` \+ ``ok``, and ``answer`` or\s*``answer_unavailable``, and ``notice`` with ``notice_reason``, when present\), ``clarify``\s*\(``clarifying_question``\), ``refuse``\s*\(``refuse_reason``\), or ``stopped``/,
    );
  });

  it('LiveKitInfo TypedDict 5-field shape pinned: ws_url + room + token + participant_identity + expires_at (all str). Drift to dropping a field would diverge from the OpenAPI LiveKitInfo schema + the TS interface + the Go struct; cross-SDK uniformity is the load-bearing test here', () => {
    expect(body).toMatch(/class LiveKitInfo\(TypedDict\):/);
    expect(body).toMatch(/ws_url: str/);
    expect(body).toMatch(/room: str/);
    expect(body).toMatch(/token: str/);
    expect(body).toMatch(/participant_identity: str/);
    expect(body).toMatch(/expires_at: str/);
  });

  it("LiveKitInfo 'hand-defined not generated' rationale pinned: 'Hand-defined here (not generated) because the same 5-field shape is used as a typed return across all three SDKs (TS LiveKitInfo interface + Go LiveKitInfo struct + this Python TypedDict) and the codegen step can lag behind. The OpenAPI schema is the contract source; this class is the Python projection of that contract.' — pinned so the 3-SDK-cross-reference + the codegen-lag rationale + the OpenAPI-as-contract anchor all survive", () => {
    expect(body).toMatch(
      /Hand-defined here \(not generated\) because the same 5-field shape is\s*used as a typed return across all three SDKs \(TS ``LiveKitInfo``\s*interface \+ Go ``LiveKitInfo`` struct \+ this Python TypedDict\) and\s*the codegen step can lag behind\. The OpenAPI schema is the contract\s*source; this class is the Python projection of that contract\./,
    );
  });

  it('Sync AgentSessionsResource 10-method surface: create + get + message + close + set_mode + send_input_event + takeover + handback + livekit_token + resume (W474). Drift would diverge from the TS + Go SDK surfaces', () => {
    expect(body).toMatch(/class AgentSessionsResource:/);
    expect(body).toMatch(
      /def create\(\s*self,\s*body: dict\[str, Any\] \| None = None,\s*\*,\s*idempotency_key: str \| None = None,\s*byok_api_key: str \| None = None,\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def get\(self, agent_session_id: str\) -> dict\[str, Any\]:/);
    // sweep-3 — cursor pagination + iterate (was a non-paginated def list(self)).
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(
      // Approvals take Mappings (a confirmation_required result can be passed
      // straight back); on_step / on_event / timeout_s are the live-progress
      // and absolute-deadline options.
      /def message\(\s*self,\s*agent_session_id: str,\s*user_message: str,\s*\*,\s*byok_api_key: str \| None = None,\s*idempotency_key: str \| None = None,\s*approve_consequential_actions: Sequence\[Mapping\[str, Any\]\] \| None = None,\s*on_step: StepCallback \| None = None,\s*on_event: EventCallback \| None = None,\s*timeout_s: float \| None = None,\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def close\(self, agent_session_id: str\) -> None:/);
    expect(body).toMatch(
      /def set_mode\(self, agent_session_id: str, mode: str\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def send_input_event\(\s*self,\s*agent_session_id: str,\s*event: dict\[str, Any\],\s*\*,\s*client_id: str \| None = None,\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def takeover\(self, agent_session_id: str, client_id: str\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/def handback\(self, agent_session_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/def livekit_token\(self, agent_session_id: str\) -> LiveKitInfo:/);
    // W474 — resume() after a resolved bot-challenge; keyword-only challenge_id.
    expect(body).toMatch(/def resume\(\s*self,\s*agent_session_id: str,/);
    expect(body).toMatch(/challenge_id: str \| None = None,/);
    // 6.c — create() docstring documents the per-session model body field
    // (Python is loose-dict, so the docstring is the typed surface).
    expect(body).toMatch(
      // Tolerant of the line wrap the 100-char ruff limit forces: the six ids
      // must all be there, in order, but the docstring may break between them.
      /"model"\?: "claude-opus-5"\|"claude-sonnet-5"\|"claude-opus-4-8"\s*\|?\s*\|?"claude-opus-4-7"\|"claude-sonnet-4-6"\|"claude-haiku-4-5"/,
    );
    // file 57 — create() docstring documents the optional profile_id body field
    // (attach a saved profile). Drift to dropping it strands the live
    // profile-backed-session feature with no documented Python surface.
    expect(body).toMatch(/"profile_id"\?: str/);
  });

  it('Async AsyncAgentSessionsResource 10-method mirror pinned (incl. resume, W474). Drift would break asyncio + FastAPI consumers OR break the sync/async parity contract', () => {
    expect(body).toMatch(/class AsyncAgentSessionsResource:/);
    expect(body).toMatch(/async def create\(/);
    expect(body).toMatch(/async def get\(/);
    expect(body).toMatch(
      /async def list\(\s*self, \*, limit: int \| None = None, cursor: str \| None = None\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/async def message\(/);
    expect(body).toMatch(/async def close\(self, agent_session_id: str\) -> None:/);
    expect(body).toMatch(/async def set_mode\(/);
    expect(body).toMatch(/async def send_input_event\(/);
    expect(body).toMatch(/async def takeover\(/);
    expect(body).toMatch(/async def handback\(/);
    expect(body).toMatch(/async def livekit_token\(/);
    expect(body).toMatch(/async def resume\(/);
  });

  it("Idempotency-Key Stripe-pattern framing on create() pinned: 'Stripe-pattern dedupe. The server enforces (account_id, idempotency_key) uniqueness via a partial unique index; retries with the same key replay the original 201 response instead of minting a duplicate row.' — pinned so the partial-unique-index + 201-replay contract stays explicit (matches TS + Go framing)", () => {
    expect(body).toMatch(
      /``idempotency_key`` \(optional\) is forwarded as the\s*``Idempotency-Key`` request header — Stripe-pattern dedupe\. The\s*server enforces ``\(account_id, idempotency_key\)`` uniqueness via\s*a partial unique index; retries with the same key replay the\s*original 201 response instead of minting a duplicate row\./,
    );
  });

  it("BYOK Anthropic key threading + 'NEVER logged' framing pinned: byok_api_key forwarded ONLY when non-None AND non-empty + 'NEVER logged by the SDK; arrives over TLS to the control plane.' + the empty-string-skip + slice-105-server-normalises-empty rationale. Drift would leak customer Anthropic credentials OR diverge from the cross-SDK empty-string-skip pattern (matches Go SDK's `opts.ByokAPIKey != \"\"` shape)", () => {
    expect(body).toMatch(
      /``byok_api_key`` \(optional\) is your own Anthropic API key, forwarded as\s*the ``x-byok-anthropic-api-key`` request header so callers don't have to\s*construct it by hand\. It takes precedence over a stored key and over\s*Driftstack's included AI\. NEVER logged by the SDK\./,
    );
    expect(body).toMatch(
      /# Skip the header when byok_api_key is None OR empty\. Empty\s*# would send `x-byok-anthropic-api-key:` on the wire — the\s*# server normalises that to absent, but skipping\s*# client-side saves the round-trip header and matches the Go\s*# SDK's `opts\.ByokAPIKey != ""` shape\./,
    );
    expect(body).toMatch(
      /if byok_api_key:\s*extra_headers\["x-byok-anthropic-api-key"\] = byok_api_key/,
    );
  });

  it('sync + async message expose one durable idempotency_key and merge it with BYOK headers', () => {
    expect(body.match(/idempotency_key: str \| None = None,/g)).toHaveLength(4);
    expect(body).toMatch(/Reuse it after a lost\/ambiguous stream/);
    // Sync and async message() share one request builder, so the header merge
    // is written once and used twice.
    expect(body.match(/extra_headers\["Idempotency-Key"\] = idempotency_key/g)).toHaveLength(1);
    expect(body).toMatch(/return body, extra_headers or None/);
    expect(body.match(/body, extra_headers = _message_request\(/g)).toHaveLength(2);
    expect(body.match(/extra_headers=extra_headers,/g)).toHaveLength(2);
  });

  it("takeover/handback pair-mode state-machine framing pinned: 'ai-driving → takeover-pending (or takeover-queued if mid-decompose)' + 'human-driving → handback-pending (or handback-queued if mid-decompose)' + PairModeStateInvalidTransitionError (409) catalog + ConflictError (409) for non-pair mode. Drift would diverge from the cross-SDK state-machine contract", () => {
    expect(body).toMatch(
      /State machine: ``ai-driving → takeover-pending`` \(or\s*``takeover-queued`` if the runtime is mid-decompose\)\./,
    );
    expect(body).toMatch(
      /State machine: ``human-driving → handback-pending`` \(or\s*``handback-queued`` if the runtime is mid-decompose\)\./,
    );
    expect(body).toMatch(
      /Raises ``PairModeStateInvalidTransitionError`` \(409\) if the\s*session is not in a state that permits takeover\. Raises\s*``ConflictError`` \(409\) if the session is not mode='pair'\./,
    );
  });

  it('LK.3 livekit_token() 5-field worked example + 3-error catalog pinned: 403 closed + 404 unknown/cross-account + 503 no Mac. Drift would diverge from the cross-SDK (TS + Go) error catalog and break Python customers who depend on the documented JSON shape', () => {
    expect(body).toMatch(/Mint a fresh live-video token for the session's video room\./);
    expect(body).toMatch(
      /\{\s*"ws_url": "wss:\/\/…",\s*"room": "agt_<uuid>",\s*"token": "<JWT>",\s*"participant_identity": "customer-<account-uuid>",\s*"expires_at": "<RFC 3339>"\s*\}/,
    );
    expect(body).toMatch(/- 403 — session is closed; cannot mint/);
    expect(body).toMatch(/- 404 — session unknown \(or cross-account; existence not leaked\)/);
    // The 503 says what the customer can do; it no longer names the machines
    // behind live video or an operator-only registration endpoint.
    expect(body).toMatch(
      /- 503 — live video is not available for this session right now; try\s*again later, or contact support if it persists/,
    );
    expect(body).not.toMatch(/mac-nodes\/register/);
  });

  it("quote(agent_session_id, safe='') on all id-bearing paths (get/message/close/set_mode/send_input_event/takeover/handback/livekit_token) for BOTH sync + async. Parity with TS encodeURIComponent + Go url.PathEscape. Drift would break Python consumers whose session ids contain reserved URI chars", () => {
    expect(body).toMatch(/f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}"/);
    expect(body).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/message"/,
    );
    expect(body).toMatch(/f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/mode"/);
    expect(body).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/input-event"/,
    );
    expect(body).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/takeover"/,
    );
    expect(body).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/handback"/,
    );
    expect(body).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/livekit-token"/,
    );
  });

  it('Body coercion via coerce_body() consistent across sync + async (for non-empty bodies). Drift to bypass coerce_body would break the cross-SDK Decimal/datetime handling helper that ensures clean JSON-encoding', () => {
    expect(body).toMatch(/from driftstack\.resources\._common import coerce_body/);
    expect(body).toMatch(/json_body=coerce_body\(body or \{\}\),/);
    // message() now builds a `body` dict (user_message + optional
    // approve_consequential_actions) then coerce_body(body) — sync + async.
    expect(body).toMatch(/json_body=coerce_body\(body\),/);
    expect(body).toMatch(/body: dict\[str, Any\] = \{"user_message": user_message\}/);
    expect(body).toContain(
      'body["approve_consequential_actions"] = _approval_payload(approve_consequential_actions)',
    );
    expect(body).toMatch(/json_body=coerce_body\(\{"client_id": client_id\}\),/);
    expect(body).toMatch(/json_body=coerce_body\(\{\}\),/);
  });
});
