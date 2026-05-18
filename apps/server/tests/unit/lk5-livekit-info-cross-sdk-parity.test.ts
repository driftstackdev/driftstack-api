// LK.5 — LiveKitInfo type cross-SDK parity. The same 5 fields must
// appear in:
//   - packages/api-types/src/livekit.ts          (Zod schema)
//   - packages/sdk-typescript                    (LiveKitInfo interface)
//   - packages/sdk-go/agent_sessions.go          (LiveKitInfo struct)
//   - the AgentSession envelope (optional `livekit` field) in each
//     SDK so session-create returns the typed shape
//
// Drift on any one of these surfaces breaks customer code: TS users
// see an `any`, Go users see a `map[string]string`, Python users see
// `dict[str, Any]`. The parity sweep pins all four together.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const FIELD_NAMES = ['ws_url', 'room', 'token', 'participant_identity', 'expires_at'] as const;

describe('LK.5 — LiveKitInfo cross-SDK parity', () => {
  it('api-types Zod schema declares exactly the 5 fields', () => {
    // Read the source file directly to avoid needing a fresh build of
    // the api-types package (the test runs against the un-built TS).
    const body = readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/livekit.ts'), 'utf8');
    expect(body).toMatch(/export const LiveKitInfoSchema = z\.object\(/);
    for (const f of FIELD_NAMES) {
      expect(body, `api-types LiveKitInfoSchema must declare ${f}`).toMatch(
        new RegExp(`${f}:\\s*z\\.string\\(\\)`),
      );
    }
  });

  it('TS SDK declares LiveKitInfo interface with all 5 fields', () => {
    const tsResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
      'utf8',
    );
    expect(tsResource).toMatch(/export interface LiveKitInfo \{/);
    for (const f of FIELD_NAMES) {
      expect(tsResource, `TS SDK LiveKitInfo must declare ${f}`).toMatch(
        new RegExp(`\\b${f}\\b\\s*:\\s*string`),
      );
    }
  });

  it('TS SDK AgentSession interface has optional livekit field referencing LiveKitInfo', () => {
    const tsResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
      'utf8',
    );
    expect(tsResource).toMatch(/livekit\?:\s*LiveKitInfo/);
  });

  it('TS SDK package index re-exports LiveKitInfo', () => {
    const tsIndex = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts'),
      'utf8',
    );
    expect(tsIndex).toMatch(/LiveKitInfo,?\s*\n/);
  });

  it('Python SDK package __init__ re-exports LiveKitInfo (matches TS index parity)', () => {
    const pyInit = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py'),
      'utf8',
    );
    // Import line from the resource module.
    expect(pyInit).toMatch(/from driftstack\.resources\.agent_sessions import LiveKitInfo/);
    // __all__ list — pin the literal entry so `from driftstack import
    // LiveKitInfo` keeps working even if the import line moves.
    expect(pyInit).toMatch(/"LiveKitInfo",/);
  });

  it('Go SDK declares LiveKitInfo struct with all 5 JSON tags', () => {
    const goResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go'),
      'utf8',
    );
    expect(goResource).toMatch(/type LiveKitInfo struct/);
    for (const f of FIELD_NAMES) {
      expect(goResource, `Go SDK LiveKitInfo must carry json tag ${f}`).toMatch(
        new RegExp(`\`json:"${f}"\``),
      );
    }
  });

  it('Go SDK AgentSession struct has optional LiveKit field (pointer + omitempty)', () => {
    const goResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go'),
      'utf8',
    );
    expect(goResource).toMatch(/LiveKit\s+\*LiveKitInfo\s+`json:"livekit,omitempty"`/);
  });

  it('api-types index.ts re-exports the livekit module', () => {
    const idx = readFileSync(resolve(REPO_ROOT, 'packages/api-types/src/index.ts'), 'utf8');
    expect(idx).toMatch(/from '\.\/livekit\.js'/);
  });

  it('field names are wire-stable lowercase_snake_case (Driftstack API convention)', () => {
    for (const f of FIELD_NAMES) {
      expect(f, `field ${f} must be lowercase_snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  // LK.3 helper-method parity — each SDK ships a typed
  // re-mint helper for POST /v1/agent-sessions/:id/livekit-token.
  // Without these, customers fall back to raw HTTP calls when the
  // 24h token expires.
  it('TS SDK declares AgentSessionsResource.livekitToken returning LiveKitInfo', () => {
    const tsResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
      'utf8',
    );
    expect(tsResource).toMatch(/livekitToken\(id: string\): Promise<LiveKitInfo>/);
    expect(tsResource).toMatch(
      /\/v1\/agent-sessions\/\$\{encodeURIComponent\(id\)\}\/livekit-token/,
    );
  });

  it('Go SDK declares (*AgentSessionsResource).LivekitToken returning *LiveKitInfo', () => {
    const goResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go'),
      'utf8',
    );
    expect(goResource).toMatch(
      /func \(r \*AgentSessionsResource\) LivekitToken\(ctx context\.Context, agentSessionID string\) \(\*LiveKitInfo, error\)/,
    );
    expect(goResource).toMatch(
      /"\/v1\/agent-sessions\/" \+ url\.PathEscape\(agentSessionID\) \+ "\/livekit-token"/,
    );
  });

  it('Python SDK declares AgentSessionsResource.livekit_token (sync + async) returning LiveKitInfo TypedDict', () => {
    const pyResource = readFileSync(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/agent_sessions.py'),
      'utf8',
    );
    // Hand-defined LiveKitInfo TypedDict (closes the cross-SDK type
    // asymmetry against TS interface + Go struct). Companion to the
    // .openapi('LiveKitInfo') registration in apps/server/src/lib/
    // openapi.ts which lifts the schema into components.schemas so a
    // future datamodel-codegen run can replace this hand-defined class
    // with a generated pydantic model.
    expect(pyResource).toMatch(/class LiveKitInfo\(TypedDict\):/);
    for (const f of FIELD_NAMES) {
      expect(pyResource, `Python LiveKitInfo TypedDict must declare ${f}`).toMatch(
        new RegExp(`\\b${f}: str\\b`),
      );
    }
    // Sync helper returns the typed shape.
    expect(pyResource).toMatch(/def livekit_token\(self, agent_session_id: str\) -> LiveKitInfo:/);
    // Async helper returns the typed shape.
    expect(pyResource).toMatch(
      /async def livekit_token\(self, agent_session_id: str\) -> LiveKitInfo:/,
    );
    // The path that each helper hits.
    expect(pyResource).toMatch(
      /f"\/v1\/agent-sessions\/\{quote\(agent_session_id, safe=''\)\}\/livekit-token"/,
    );
    // Drift-guard: the legacy untyped `dict[str, Any]` return MUST NOT
    // re-appear on either helper.
    expect(pyResource).not.toMatch(
      /def livekit_token\(self, agent_session_id: str\) -> dict\[str, Any\]:/,
    );
  });
});
