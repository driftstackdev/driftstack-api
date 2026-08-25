// Slice 4 (Wave 29-NNN ARC 3) — cross-surface parity drift guard.
//
// The LK.6 InputEvent wire contract lives in 3 places that MUST
// stay in lock-step:
//   1. packages/api-types/src/agent-input-event.ts — Zod schema
//      (canonical source of truth for the route layer + SDKs).
//   2. apps/gui-client/src/lib/livekit.ts — local TS `type
//      InputEvent` (Tauri shell publishes via LiveKit DataChannel
//      directly; pre-promotion this was the only definition).
//   3. SDK type aliases in packages/sdk-{typescript,go} (Python
//      uses dict[str, Any] so no static drift surface — relies on
//      the route's Zod validation to enforce the shape at runtime).
//
// A drift between any pair would either let the dashboard send an
// event the harness can't decode, OR have the SDK type-check accept
// an event the route rejects with 400. The harness side (Swift) is
// out of scope here — Agent 1's repo holds the matching enum, pinned
// via a separate cross-repo content-parity test once harness work
// lands per Tier-3 Option A 2026-05-19.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/agent-input-event.ts');
const GUI_CLIENT = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit.ts');
const SDK_TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts');
const SDK_GO = resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Slice 4 — InputEvent cross-surface parity', () => {
  it('api-types InputEventSchema file exists', () => {
    expect(existsSync(API_TYPES)).toBe(true);
  });

  it('api-types InputEventSchema discriminator pinned to type field with 12 variants (7 mouse/key/wheel/ping + 5 touch)', () => {
    const body = read(API_TYPES);
    expect(body).toMatch(/InputEventSchema = z\.discriminatedUnion\('type', \[/);
    for (const variant of [
      'mouseMove',
      'mouseDown',
      'mouseUp',
      'keyDown',
      'keyUp',
      'wheel',
      'ping',
      'tap',
      'touchStart',
      'touchMove',
      'touchEnd',
      'swipe',
    ]) {
      expect(body, `missing variant: ${variant}`).toContain(`z.literal('${variant}')`);
    }
  });

  it('gui-client local InputEvent type union pins the same 12 variants in lock-step', () => {
    const body = read(GUI_CLIENT);
    expect(body).toMatch(/export type InputEvent =/);
    for (const variant of [
      "type: 'mouseMove'",
      "type: 'mouseDown'",
      "type: 'mouseUp'",
      "type: 'keyDown'",
      "type: 'keyUp'",
      "type: 'wheel'",
      "type: 'ping'",
      "type: 'tap'",
      "type: 'touchStart'",
      "type: 'touchMove'",
      "type: 'touchEnd'",
      "type: 'swipe'",
    ]) {
      expect(body, `gui-client missing: ${variant}`).toContain(variant);
    }
  });

  it('sdk-typescript exports InputEvent type alias pinned to the same 12 variants', () => {
    const body = read(SDK_TS);
    expect(body).toMatch(/export type InputEvent =/);
    for (const variant of [
      "type: 'mouseMove'",
      "type: 'mouseDown'",
      "type: 'mouseUp'",
      "type: 'keyDown'",
      "type: 'keyUp'",
      "type: 'wheel'",
      "type: 'ping'",
      "type: 'tap'",
      "type: 'touchStart'",
      "type: 'touchMove'",
      "type: 'touchEnd'",
      "type: 'swipe'",
    ]) {
      expect(body).toContain(variant);
    }
  });

  it('sdk-typescript sendInputEvent method exists with InputEvent + optional clientId opts (Slice 5 takeover-trigger needs client_id)', () => {
    const body = read(SDK_TS);
    expect(body).toMatch(
      /sendInputEvent\(\s*id: string,\s*event: InputEvent,\s*opts\?: \{ clientId\?: string \},\s*\): Promise<SendInputEventResponse>/,
    );
  });

  it('sdk-go SendInputEvent method exists with SendInputEventOptions param (Slice 5 takeover-trigger client_id)', () => {
    const body = read(SDK_GO);
    expect(body).toMatch(
      /func \(r \*AgentSessionsResource\) SendInputEvent\(ctx context\.Context, agentSessionID string, event map\[string\]any, opts \*SendInputEventOptions\) \(\*SendInputEventResponse, error\)/,
    );
    expect(body).toMatch(/type SendInputEventOptions struct \{/);
  });

  it('sdk-go SendInputEventResponse struct pinned to discriminated-union shape {Kind, PairModeState?, DurationMS?} for Slice 4 + Slice 5', () => {
    const body = read(SDK_GO);
    expect(body).toMatch(/type SendInputEventResponse struct \{/);
    expect(body).toMatch(/Kind\s+string\s+`json:"kind"`/);
    expect(body).toMatch(/PairModeState map\[string\]any `json:"pair_mode_state,omitempty"`/);
    expect(body).toMatch(/DurationMS\s+int\s+`json:"duration_ms,omitempty"`/);
  });

  it('all 4 surfaces include the LK.6 wire-contract reference comment', () => {
    expect(read(API_TYPES)).toContain('LK.6');
    expect(read(GUI_CLIENT)).toContain('LK.6');
    expect(read(SDK_TS)).toContain('LK.6');
    expect(read(SDK_GO)).toContain('LK.6');
  });
});
