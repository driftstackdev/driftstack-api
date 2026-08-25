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
      /\/\/ Reuses the LiveKitInfo shape from the SDK \(which mirrors the\s*\/\/ api-types Zod schema\)\. The shape is the contract the\s*\/\/ \/v1\/agent-sessions\/:id\/livekit-token endpoint returns and the\s*\/\/ optional `livekit` field on session-create\./,
    );
  });

  it("LK.6.d InputEvent 13-variant tagged union pinned: 7 mouse/key/wheel/ping + 5 touch (tap / touchStart / touchMove / touchEnd / swipe) + navigate (URL-nav over the same data channel, A3 W2668). + 'the input-event schema the Mac side decodes. Must stay in lock-step with Agent 1's Swift InputEvent enum.' — pinned so the cross-agent Swift-side enum + the touch contract (founder 2026-06-08) + the navigate command (founder 2026-06-19) all stay documented (drift would break customer manual control input). Per-variant toContain (NOT one mega-regex) to avoid the long-chain backtracking hazard.", () => {
    // Framing comment + the union declaration.
    expect(body).toMatch(
      /\/\*\* LK\.6\.d — the input-event schema the Mac side decodes\. Must\s*\*\s+stay in lock-step with Agent 1's Swift `InputEvent` enum\. \*\//,
    );
    expect(body).toMatch(/export type InputEvent =/);
    // Each variant pinned individually (mouse/key/wheel/ping + the 5 touch + navigate).
    for (const variant of [
      "| { type: 'mouseMove'; x: number; y: number }",
      "| { type: 'mouseDown'; x: number; y: number; button: 0 | 1 | 2 }",
      "| { type: 'mouseUp'; x: number; y: number; button: 0 | 1 | 2 }",
      "| { type: 'keyDown'; key: string; modifiers?: readonly string[] }",
      "| { type: 'keyUp'; key: string; modifiers?: readonly string[]; id?: string }",
      "| { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }",
      "| { type: 'tap'; x: number; y: number; id?: string }",
      "| { type: 'touchStart'; x: number; y: number; touchId: number }",
      "| { type: 'touchMove'; x: number; y: number; touchId: number }",
      "| { type: 'touchEnd'; x: number; y: number; touchId: number; id?: string }",
      "| { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }",
      "| { type: 'navigate'; url: string }",
      "| { type: 'ping'; timestamp: number };",
    ]) {
      expect(body, `livekit.ts missing variant: ${variant}`).toContain(variant);
    }
  });

  it('sendNavigate emits a navigate command on the same reliable data channel as taps (A3 W2668; the URL-bar fork chrome is un-tappable so the GUI emits its own). Pinned so the data-channel transport (no server route — would 401 for the keychain-less Simulator app) stays documented', () => {
    expect(body).toContain('export async function sendNavigate(room: Room, url: string)');
    expect(body).toContain(
      "await sendInputEvent(room, { type: 'navigate', url }, { reliable: true });",
    );
  });

  it('LK.6.c LivekitConnectionState 6-variant tagged union pinned: idle / connecting / connected / reconnecting / disconnected / error(message). Drift to a different state-machine shape would mismatch the badge-rendering logic in LivekitConnectionBadge.tsx', () => {
    expect(body).toMatch(
      /export type LivekitConnectionState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'connecting' \}\s*\| \{ kind: 'connected' \}\s*\| \{ kind: 'reconnecting' \}\s*\| \{ kind: 'disconnected' \}\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("createLivekitRoom is tuned for the INTERACTIVE simulator: adaptiveStream OFF (it gates a track on the <video> element's visibility/size, adding latency to a real-time control surface — the likeliest subscribe-side cause of the founder-reported 'very very slow streaming / huge delay') + dynacast ON (publisher-side no-op against simulcast:false, kept harmless). new Room({adaptiveStream: false, dynacast: true}). Drift back to adaptiveStream:true would re-introduce the visibility-gated latency on the live view.", () => {
    expect(body).toMatch(
      /export function createLivekitRoom\(\): Room \{\s*return new Room\(\{\s*adaptiveStream: false,\s*dynacast: true,\s*\}\);/,
    );
    expect(body).toMatch(/adaptiveStream pauses\/downgrades a track based/);
  });

  it("sendInputEvent reliable=true default framing pinned: 'lossy: false (TCP-style; mouse/key events MUST arrive in order). For high-frequency mouseMove streams, callers can opt-in to lossy: true to drop intermediate frames if the link congests — acceptable trade for cursor-tracking only.' + opts.reliable ?? true + receipt-aware wireEvent → publishData. Drift to reliable=false default would let click/keypress events drop silently", () => {
    expect(body).toContain('const reliable = opts.reliable ?? true;');
    expect(body).toContain('const data = new TextEncoder().encode(JSON.stringify(wireEvent));');
    expect(body).toContain('await room.localParticipant.publishData(data, { reliable });');
  });

  it('committed-input receipt ids are limited to tap/touchEnd/keyUp/text and registered before publish with cancellation on failure', () => {
    expect(body).toMatch(
      /event\.type === 'tap' \|\|[\s\S]{0,120}event\.type === 'touchEnd' \|\|[\s\S]{0,120}event\.type === 'keyUp' \|\|[\s\S]{0,120}event\.type === 'text'/,
    );
    expect(body).toContain('registerInputReceipt(room, receiptId, deadlineMs);');
    expect(body).toContain('if (receiptId !== null) cancelInputReceipt(room, receiptId);');
    expect(body).not.toMatch(/event\.type === 'touchMove'[\s\S]{0,80}crypto\.randomUUID/);
  });

  it("sendInputEvent swallows benign LiveKit teardown errors (PC manager closed) so a fire-and-forget publish after room teardown can't blank the app, and re-throws genuine failures", () => {
    expect(body).toContain('if (isBenignTeardownError(err)) return;');
    expect(body).toContain("import { isBenignTeardownError } from './livekit-errors';");
  });
});
