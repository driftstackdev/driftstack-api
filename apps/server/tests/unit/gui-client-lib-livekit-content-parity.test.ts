// Drift guard for apps/gui-client/src/lib/livekit.ts. Pins LK.6.a
// the typed wrapper around livekit-client + LK.6.d InputEvent
// schema that MUST stay in lock-step with Agent 1's Mac-side Quartz
// CGEvent decoder (commit 9170da82). Drift to the InputEvent shape
// would break customer manual-control input.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client/lib/livekit content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.6.a module-level framing pinned: 'livekit-client smoke import + a tiny typed wrapper. Reuses the LiveKitInfo shape from the SDK (which mirrors the api-types Zod schema). The shape is the contract the /v1/agent-sessions/:id/livekit-token endpoint returns and the optional livekit field on session-create.' — pinned so the LK.6.a anchor + SDK-mirrors-api-types-Zod + LK.3 endpoint cross-reference contract all stay documented", () => {
    expect(body).toMatch(/\/\/ LK\.6\.a — livekit-client smoke import \+ a tiny typed wrapper\./);
    expect(body).toMatch(
      /\/\/ Reuses the LiveKitInfo shape from the SDK \(which mirrors the\s*\n?\s*\/\/ api-types Zod schema\)\. The shape is the contract the\s*\n?\s*\/\/ \/v1\/agent-sessions\/:id\/livekit-token endpoint returns and the\s*\n?\s*\/\/ optional `livekit` field on session-create\./,
    );
  });

  it("LK.6.d InputEvent 7-variant tagged union pinned: mouseMove + mouseDown(button:0|1|2) + mouseUp(button:0|1|2) + keyDown(modifiers?: readonly string[]) + keyUp + wheel(deltaX+deltaY) + ping(timestamp). + 'the input-event schema the Mac side decodes. Must stay in lock-step with Agent 1's Swift InputEvent enum.' — pinned so the cross-agent Swift-side enum + 7-variant contract all stay documented (drift would break customer manual control input)", () => {
    expect(body).toMatch(
      /\/\*\* LK\.6\.d — the input-event schema the Mac side decodes\. Must\s*\n?\s*\*\s+stay in lock-step with Agent 1's Swift `InputEvent` enum\. \*\/\s*\n?\s*export type InputEvent =\s*\n?\s*\| \{ type: 'mouseMove'; x: number; y: number \}\s*\n?\s*\| \{ type: 'mouseDown'; x: number; y: number; button: 0 \| 1 \| 2 \}\s*\n?\s*\| \{ type: 'mouseUp'; x: number; y: number; button: 0 \| 1 \| 2 \}\s*\n?\s*\| \{ type: 'keyDown'; key: string; modifiers\?: readonly string\[\] \}\s*\n?\s*\| \{ type: 'keyUp'; key: string; modifiers\?: readonly string\[\] \}\s*\n?\s*\| \{ type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number \}\s*\n?\s*\| \{ type: 'ping'; timestamp: number \};/,
    );
  });

  it('LK.6.c LivekitConnectionState 6-variant tagged union pinned: idle / connecting / connected / reconnecting / disconnected / error(message). Drift to a different state-machine shape would mismatch the badge-rendering logic in LivekitConnectionBadge.tsx', () => {
    expect(body).toMatch(
      /export type LivekitConnectionState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'connecting' \}\s*\n?\s*\| \{ kind: 'connected' \}\s*\n?\s*\| \{ kind: 'reconnecting' \}\s*\n?\s*\| \{ kind: 'disconnected' \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("createLivekitRoom adaptive-stream + dynacast framing pinned: 'Construct a Room with adaptive-stream + autoSubscribe enabled. No connect() call here — the AgentSessionPanel component owns the lifecycle.' + new Room({adaptiveStream: true, dynacast: true}). Drift to dropping adaptiveStream would force the SFU to send full-resolution under congestion", () => {
    expect(body).toMatch(
      /export function createLivekitRoom\(\): Room \{\s*\n?\s*return new Room\(\{\s*\n?\s*adaptiveStream: true,\s*\n?\s*dynacast: true,\s*\n?\s*\}\);/,
    );
  });

  it("sendInputEvent reliable=true default framing pinned: 'lossy: false (TCP-style; mouse/key events MUST arrive in order). For high-frequency mouseMove streams, callers can opt-in to lossy: true to drop intermediate frames if the link congests — acceptable trade for cursor-tracking only.' + opts.reliable ?? true + JSON.stringify(event) → publishData. Drift to reliable=false default would let click/keypress events drop silently", () => {
    expect(body).toMatch(
      /const reliable = opts\.reliable \?\? true;\s*\n?\s*const data = new TextEncoder\(\)\.encode\(JSON\.stringify\(event\)\);\s*\n?\s*await room\.localParticipant\.publishData\(data, \{ reliable \}\);/,
    );
  });
});
