// Drift guard for apps/docs/src/pages/api/agent-sessions.md. Pins
// the agent-sessions API docs at structural level — 3-mode roster
// (ai/manual/pair) + decompose-execute loop + LiveKit field optional
// auto-populated + resource shape. The file is large (384 lines) so
// this test pins only the load-bearing framing comments + 3-mode
// state machine.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentModelSchema, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/pages/api/agent-sessions content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Agent sessions overview framing pinned (W554: intent list completed to all 6 kinds — navigate/interact/wait/capture + behavioural scroll/behavioral_pause): chat-style decompose→execute loop + NL messages + streaming-results contract stay documented', () => {
    expect(body).toMatch(
      /An \*\*agent session\*\* layers a chat-style decompose→execute loop on\s*\n?\s*top of a regular driver-backed browser session\./,
    );
    expect(body).toMatch(
      /the server's decomposer translates that into typed\s*\n?\s*intents \(`navigate`, `interact`, `wait`, `capture`, plus the\s*\n?\s*behavioural `scroll` and `behavioral_pause`\); the runtime executes\s*\n?\s*them; results stream back in the response\./,
    );
  });

  it('3-mode state machine framing pinned: ai (default; every message goes through decomposer + executor; closed sessions return 409) + manual (message is transcript-only pass-through; gui-client drives real actions via gui_control plane HMAC channel) + pair (interactive takeover state machine; AI drives by default; customer calls takeover to seize control then handback to return; state transitions audit-logged) — pinned so the 3-mode roster + AI-default + manual-gui_control-plane + pair-takeover-handback-state-machine + audit-logged contract all stay documented (drift on any mode would mismatch route+service+DB enum)', () => {
    expect(body).toMatch(
      /- `ai` \(default\) — every customer message goes through the\s*\n?\s*decomposer \+ executor\. Closed sessions return 409\./,
    );
    expect(body).toMatch(
      /- `manual` — `message` is a transcript-only pass-through\. The\s*\n?\s*customer's gui-client drives the real actions via the\s*\n?\s*gui_control plane \(a separate per-session HMAC channel\)\./,
    );
    expect(body).toMatch(
      /- `pair` — interactive takeover state machine\. AI drives by\s*\n?\s*default; the customer can call `takeover` to seize control,\s*\n?\s*then `handback` to return control to AI\. State transitions are\s*\n?\s*audit-logged\./,
    );
  });

  it("Resource shape framing pinned: agt_<uuid> id + 3-status (active/paused/closed) + closed_reason/closed_at nullable + token_budget total+remaining + transcript_length + mode + 5-field optional livekit (ws_url + room=agt_<uuid> + HS256 JWT token + customer-<account-uuid> participant_identity + expires_at). + 'The livekit field is optional — auto-populated on the session-create response when the deployment has at least one Mac with registered LiveKit credentials, and absent otherwise (pre-LK deployment, OR no Mac has called POST /v1/mac-nodes/register yet). Clients that need a token in the absent case use the explicit endpoint at' — pinned so the resource-shape + optional-livekit + auto-populated-when-Mac-registered + fallback-to-explicit-endpoint contract all stay documented", () => {
    expect(body).toMatch(
      /"id": "agt_<uuid>",\s*\n?\s*"account_id": "<uuid>",\s*\n?\s*"driftstack_session_id": "<uuid> \| null",\s*\n?\s*"status": "active \| paused \| closed",/,
    );
    expect(body).toMatch(
      /"livekit": \{\s*\n?\s*"ws_url": "wss:\/\/mac-NNN\.driftstack\.dev:8443",\s*\n?\s*"room": "agt_<uuid>",\s*\n?\s*"token": "<HS256 JWT>",\s*\n?\s*"participant_identity": "customer-<account-uuid>",\s*\n?\s*"expires_at": "<ISO-8601>"\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /The `livekit` field is \*\*optional\*\* — auto-populated on the\s*\n?\s*session-create response when the deployment has at least\s*\n?\s*one Mac with registered LiveKit credentials, and absent otherwise\s*\n?\s*\(pre-LK deployment, OR no Mac has called\s*\n?\s*`POST \/v1\/mac-nodes\/register` yet\)\./,
    );
  });

  it("3-mode-enum 'mode': 'ai | manual | pair' field shape pinned in resource. Drift to a 4th mode or renaming any of the 3 would mismatch the DB CHECK constraint + route layer + Drizzle repo + customer SDK", () => {
    expect(body).toMatch(/"mode": "ai \| manual \| pair"/);
  });

  it("Per-session model picker (#15) pinned in resource + create body: 'model' field listing claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 with claude-opus-4-7 as the omitted-default. The values + default are DERIVED from AgentModelSchema.options / DEFAULT_AGENT_MODEL, so adding/renaming a model or changing the default must update agent-sessions.md in lockstep — drift would leave the route's `model: AgentModelSchema.optional()` create field undocumented or misdocumented.", () => {
    // Structural shape: the inline pipe-separated field in both JSON blocks.
    expect(body).toMatch(
      /"model": "claude-opus-4-8 \| claude-opus-4-7 \| claude-sonnet-4-6 \| claude-haiku-4-5"/,
    );
    // Source-derived: every AgentModelSchema option must be documented (a 4th
    // model added to the enum but not the doc fails here).
    for (const m of AgentModelSchema.options) {
      expect(body, `agent-sessions.md must document model '${m}'`).toContain(m);
    }
    // The omitted-default must name DEFAULT_AGENT_MODEL.
    expect(body).toContain(`defaults to \`${DEFAULT_AGENT_MODEL}\``);
  });

  it("3-status-enum 'status': 'active | paused | closed' field shape pinned in resource + 'Closed sessions return 409' state-machine guard. Drift to dropping the paused state would simplify the lifecycle but break the pair-mode-takeover-suspend pattern", () => {
    expect(body).toMatch(/"status": "active \| paused \| closed"/);
    expect(body).toMatch(/Closed sessions return 409\./);
  });

  it('documents the current HTTP 503 boundary and supported live-control channels without internal ownership or roadmap prose', () => {
    expect(body).toMatch(
      /\*\*HTTP manual-input dispatch is unavailable\.\*\* Manual-mode and\s*\n?\s*pair-mode-after-takeover input-events return `503 feature-unavailable`;\s*\n?\s*the HTTP route does not forward input to the harness\./,
    );
    expect(body).toMatch(
      /use the desktop Simulator or publish input through\s*\n?\s*the LiveKit DataChannel documented in the/,
    );
    expect(body).not.toMatch(/Agent\s+[123]|until[^.]{0,120}lands/iu);
    expect(body).toMatch(/live fleet state is\s*\n?\s*unavailable in the deployment\./);
    expect(body).toMatch(/no BYOK or bundled-LLM provider is available in the deployment/);
    expect(body).not.toMatch(
      /control plane\s*\n?\s*is not wired|activation gate is off|key path wired/,
    );
  });
});
