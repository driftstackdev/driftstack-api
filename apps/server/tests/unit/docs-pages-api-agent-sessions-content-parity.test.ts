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

  it('V-1505 the failure report and the usage block are documented, not just published. `error_event` was in the spec and both SDKs and appeared NOWHERE under apps/docs — measured against every component schema, it and the AgentMessageUsage token fields were the only customer-facing properties the docs never named. A customer receiving `{ customer_actionable: false, retryable: true }` on a failed session had two booleans and no statement of which way either points.', () => {
    // Resource shape carries the field, with the branching keys a caller acts on.
    expect(body).toMatch(
      /"error_event": \{[\s\S]*?"customer_actionable": false,[\s\S]*?"retryable": true/,
    );
    expect(body).toContain(
      '`customer_actionable` says whether a human can do\nanything about the failure, and `retryable` says whether repeating the same\ncall is worth trying.',
    );
    // Verified against both recordErrorEvent implementations: each writes
    // lastErrorEvent + updatedAt and never touches status.
    expect(body).toContain('An `error_event` does not by itself close the session');

    // Usage: decomposer_kind is the schema's only required property, and the
    // deterministic decomposer reports DETERMINISTIC_USAGE — the kind alone.
    expect(body).toContain('Only `decomposer_kind` is always present.');
    expect(body).toMatch(/"anthropic_input_tokens": 1200,\s*\n\s*"anthropic_output_tokens": 340,/);
  });

  it('Agent sessions overview framing pinned (W554: intent list completed to all 6 kinds — navigate/interact/wait/capture + behavioural scroll/behavioral_pause): chat-style decompose→execute loop + NL messages + streaming-results contract stay documented', () => {
    expect(body).toMatch(
      /An \*\*agent session\*\* layers a chat-style decompose→execute loop on\s*top of a regular driver-backed browser session\./,
    );
    expect(body).toMatch(
      /the server's decomposer translates that into typed\s*intents \(`navigate`, `interact`, `wait`, `capture`, plus the\s*behavioural `scroll` and `behavioral_pause`\); the runtime executes\s*them; results stream back in the response\./,
    );
  });

  // V-740 — the transcript `body` is ALWAYS prose. The page said it was
  // "serialised `DecomposeResult` JSON for agent turns", which no code path
  // produces: agent-runtime writes `refused: <reason>` and `clarify: <question>`,
  // agent-executor writes a newline-joined plan summary, and the transcript-answer
  // path writes sanitised answer text. A consumer following the page and calling
  // JSON.parse on an agent turn would throw on every one. The structured form is
  // `intents?`, which is a separate field.
  it('V-740 transcript body is documented as prose, never JSON, and points at intents for structure', () => {
    const body = read(LIB);

    expect(body).toMatch(/`body` — always human-readable text, never JSON\./);
    // The concrete renderings, so the claim stays checkable against the code.
    expect(body).toMatch(/`refused: <reason>`/);
    expect(body).toMatch(/`clarify: <question>`/);
    expect(body).toMatch(/\(plan halted on failure\)/);
    // The actionable instruction, and where structure actually lives.
    expect(body).toMatch(/Do \*\*not\*\*\s*`JSON\.parse` it/);
    // And the false claim must not return.
    expect(body).not.toMatch(/serialised\s*`DecomposeResult` JSON for agent turns/);
  });

  it('3-mode state machine framing pinned: ai (default; every message goes through decomposer + executor; closed sessions return 409) + manual (message is transcript-only pass-through; gui-client drives real actions via gui_control plane HMAC channel) + pair (interactive takeover state machine; AI drives by default; customer calls takeover to seize control then handback to return; state transitions audit-logged) — pinned so the 3-mode roster + AI-default + manual-gui_control-plane + pair-takeover-handback-state-machine + audit-logged contract all stay documented (drift on any mode would mismatch route+service+DB enum)', () => {
    expect(body).toMatch(
      /- `ai` \(default\) — every customer message goes through the\s*decomposer \+ executor\. Closed sessions return 409\./,
    );
    expect(body).toMatch(
      /- `manual` — `message` is a transcript-only pass-through\. The\s*customer's gui-client drives the real actions via the\s*gui_control plane \(a separate per-session HMAC channel\)\./,
    );
    expect(body).toMatch(
      /- `pair` — interactive takeover state machine\. AI drives by\s*default; the customer can call `takeover` to seize control,\s*then `handback` to return control to AI\. State transitions are\s*audit-logged\./,
    );
  });

  it("Resource shape framing pinned: agt_<uuid> id + 3-status (active/paused/closed) + closed_reason/closed_at nullable + token_budget total+remaining + transcript_length + mode + 5-field optional livekit (ws_url + room=agt_<uuid> + HS256 JWT token + customer-<account-uuid> participant_identity + expires_at). + 'The livekit field is optional — auto-populated on the session-create response when the deployment has at least one Mac with registered LiveKit credentials, and absent otherwise (pre-LK deployment, OR no Mac has called POST /v1/mac-nodes/register yet). Clients that need a token in the absent case use the explicit endpoint at' — pinned so the resource-shape + optional-livekit + auto-populated-when-Mac-registered + fallback-to-explicit-endpoint contract all stay documented", () => {
    expect(body).toMatch(
      // V-738 — driftstack_session_id is emitted PREFIXED (`ses_<uuid>`); the
      // route stores it bare and returns the canonical form so input and output
      // share one contract (agent-sessions.ts:414-417). The page contradicted
      // itself: this shape and the ID-format note both said bare, while the
      // create-response example two blocks down said `ses_<uuid>`. account_id
      // IS bare, which is what the note is for.
      /"id": "agt_<uuid>",\s*"account_id": "<uuid>",\s*"driftstack_session_id": "ses_<uuid> \| null",\s*"status": "active \| paused \| closed",/,
    );
    expect(body).toMatch(
      /"livekit": \{\s*"ws_url": "wss:\/\/mac-NNN\.driftstack\.dev:8443",\s*"room": "agt_<uuid>",\s*"token": "<HS256 JWT>",\s*"participant_identity": "customer-<account-uuid>",\s*"expires_at": "<ISO-8601>"\s*\}/,
    );
    expect(body).toMatch(
      /The `livekit` field is \*\*optional\*\* — auto-populated on the\s*session-create response when the deployment has at least\s*one Mac with registered LiveKit credentials, and absent otherwise\s*\(pre-LK deployment, OR no Mac has called\s*`POST \/v1\/mac-nodes\/register` yet\)\./,
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
      /\*\*HTTP manual-input dispatch is unavailable\.\*\* Manual-mode and\s*pair-mode-after-takeover input-events return `503 feature-unavailable`;\s*the HTTP route does not forward input to the harness\./,
    );
    expect(body).toMatch(
      /use the desktop Simulator or publish input through\s*the LiveKit DataChannel documented in the/,
    );
    expect(body).not.toMatch(/Agent\s+[123]|until[^.]{0,120}lands/iu);
    expect(body).toMatch(/live fleet state is\s*unavailable in the deployment\./);
    expect(body).toMatch(/no BYOK or bundled-LLM provider is available in the deployment/);
    expect(body).not.toMatch(/control plane\s*is not wired|activation gate is off|key path wired/);
  });

  it('documents outcome-unknown action failures as non-replayable without claiming the command failed before application', () => {
    expect(body).toContain(
      'the browser action or pacing may have taken effect even though its result was not confirmed — inspect the current page before deciding whether to try another action',
    );
    expect(body).toMatch(/"diagnosis": \{ "category": "unknown", "retryable": false \}/);
    expect(body).toMatch(/`retryable: true`\s*means automatic replay/);
    expect(body).toMatch(/`false` means\s*never replay automatically/);
    expect(body).toMatch(/does not prove that the\s*action succeeded or failed/);
    expect(body).toMatch(/applies to `navigate`,\s*`interact`, `scroll`, and `behavioral_pause`/);
    expect(body).toMatch(/Read-only\s*`capture` remains eligible for bounded automatic replay/);
    expect(body).not.toContain('try a broader selector or wait for it to appear');
  });

  it('documents exact control-lane admission, manual provider bypass, and honest partial 409 settlement', () => {
    expect(body).toMatch(/admits each request into exactly one control lane/);
    expect(body).toMatch(/A `manual` request is\s*transcript-only and never consults BYOK/);
    expect(body).toMatch(
      /invalidate the admitted turn even if\s*the session later returns to the same visible mode/,
    );
    expect(body).toMatch(/`409 conflict` with `ai_control_unavailable: true` and a `phase`/);
    expect(body).toMatch(
      /starts no later provider attempt, retry, browser intent, read-back, or\s*transcript suffix/,
    );
    expect(body).toMatch(/`tokens_consumed` and\s*`usage`/);
    expect(body).toMatch(/redacted `partial_results`/);
    expect(body).toMatch(/manual transcript turn never reads or hashes the irrelevant/);
    expect(body).toMatch(/BYOK header is deliberately outside receipt identity/);
    expect(body).toMatch(/still replays the original terminal result/);
    expect(body).toMatch(/close or pause wins after model or\s*browser work has already settled/);
    expect(body).toMatch(/resume a paused session, but\s*replace a closed one/);
    expect(body).toMatch(/redacted `partial_results` evidence described\s*above/);
    expect(body).toMatch(/posted 10-cent included-service accounting value/);
    expect(body).toMatch(/not the upstream model's measured cost/);
    expect(body).toMatch(/optional read-back model call is recorded separately/);
    expect(body).toMatch(/not currently aggregated into this response field/);
    expect(body).toMatch(
      /`ai_control_unavailable: true` when a message's admitted control epoch changes/,
    );
  });

  it('V-1076 CRITICAL the message endpoint documents its SSE lane, including that errors ride inside the terminal frame rather than the HTTP status. A caller branching on the response status reads an invalid body or an unknown session as success, because the lane answers 200 and reports the real status as a field of the envelope.', () => {
    expect(body, 'the SSE opt-in is no longer documented').toMatch(
      /Send `Accept: text\/event-stream`/,
    );
    expect(body, 'the terminal frame name is no longer documented').toMatch(
      /event: response`? whose `data:` is JSON `\{ status, body \}`/,
    );
    expect(body, 'the errors-inside-the-frame warning is gone').toMatch(
      /Branching on\s*the response status alone will read every one of those as success/,
    );
    expect(body, 'the heartbeat-comment note is gone').toMatch(
      /Heartbeats are SSE comments, not events/,
    );
    expect(body, 'the rate-limit exception is gone').toMatch(
      /Rate-limit denial is the one exception/,
    );

    // The route must still behave the way the page now describes, or the page is
    // the next thing to go stale.
    const route = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'),
      'utf8',
    );
    expect(route, 'the message route no longer selects the lane on Accept').toMatch(
      /'text\/event-stream'/,
    );
    expect(route, 'the terminal frame is no longer named response').toMatch(
      /event: response\\ndata: \$\{terminal\}/,
    );
    expect(route, 'the heartbeat is no longer an SSE comment').toMatch(/`: heartbeat \$\{/);
    expect(route, 'a rate-limit denial no longer bypasses the stream').toMatch(
      /err instanceof RateLimitedError \|\| !wantsEventStream/,
    );
  });

  it('V-1080 CRITICAL the collection list is documented, with its envelope and its admin-only team rule. It is a live customer endpoint that all three SDKs wrap as list(), and until now the only mention anywhere in the docs was the RBAC exception V-1068 added — so a customer reading this page could not learn the endpoint exists, let alone that it pages.', () => {
    expect(body, 'the List section is gone').toMatch(/## List\s*\n\s*\n`GET \/v1\/agent-sessions`/);
    expect(body, 'the pagination envelope is no longer stated').toMatch(
      /\{ data, has_more, next_cursor \}/,
    );
    expect(body, 'the page-size-not-ceiling clarification is gone').toMatch(
      /that is the page size, not a ceiling/,
    );
    expect(body, 'the admin-only team rule is no longer stated here').toMatch(
      /Team members need the `admin` role here/,
    );

    // The spec summary must not go back to describing a hard cap, which is what it
    // said while the response published `data` alone.
    const spec = readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8');
    const doc = JSON.parse(spec) as {
      paths: Record<string, Record<string, { summary?: string }>>;
    };
    const summary = doc.paths['/v1/agent-sessions']?.['get']?.summary ?? '';
    expect(summary, 'the list summary is missing').not.toBe('');
    expect(summary, 'the summary describes a hard cap again').not.toMatch(/capped at 100\)/);
    expect(summary, 'the summary no longer says it is cursor-paginated').toMatch(
      /cursor-paginated/,
    );
  });
});
