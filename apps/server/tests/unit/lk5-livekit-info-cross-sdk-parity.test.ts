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
});
