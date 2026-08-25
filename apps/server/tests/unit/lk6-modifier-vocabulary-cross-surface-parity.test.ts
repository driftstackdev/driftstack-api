// 2026-05-20 — LK.6.d modifier-vocabulary cross-surface parity.
//
// The gui-client (Tauri desktop) captures KeyboardEvents and POSTs
// LK.6 InputEvent payloads to /v1/agent-sessions/:id/input-event, using
// the Mac-native modifier vocabulary so the Mac harness decoder sees a
// single payload shape.
//
// Vocabulary lock (2026-05-20): cmd / ctrl / shift / option —
// Mac-native labels, 1:1 with Quartz CGEventFlags
// (kCGEventFlagMaskCommand → cmd, etc.). Pre-lock, gui-client used
// DOM-standard Shift/Control/Alt/Meta names which forced the
// harness to remap Meta→Command on every key press.
//
// 2026-07-02 — the customer-dashboard agent-sessions/[id] workbench (the
// browser surface that mirrored this vocabulary) moved to the desktop
// GUI with the account-portal IA, so its parity subtest was removed. The
// gui-client ↔ SDK/api-types side of the lock is still asserted here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GUI_CLIENT = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-input-capture.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('LK.6.d modifier-vocabulary cross-surface parity', () => {
  it('gui-client modifiersFromEvent uses Mac-native vocabulary (cmd/ctrl/shift/option) + CanonicalModifier return type', () => {
    const body = read(GUI_CLIENT);
    expect(body).toMatch(/if \(event\.metaKey\) mods\.push\('cmd'\);/);
    expect(body).toMatch(/if \(event\.ctrlKey\) mods\.push\('ctrl'\);/);
    expect(body).toMatch(/if \(event\.shiftKey\) mods\.push\('shift'\);/);
    expect(body).toMatch(/if \(event\.altKey\) mods\.push\('option'\);/);
    // The DOM-standard names MUST NOT return.
    expect(body).not.toMatch(/mods\.push\('Shift'\)/);
    expect(body).not.toMatch(/mods\.push\('Control'\)/);
    expect(body).not.toMatch(/mods\.push\('Alt'\)/);
    expect(body).not.toMatch(/mods\.push\('Meta'\)/);
    // Slice 6 follow-up — the helper signature is now CanonicalModifier-typed
    // (imported from @driftstack/sdk's re-export of api-types) so a typo
    // like mods.push('Cmd') would now fail at compile time, not runtime.
    expect(body).toMatch(/import \{ type CanonicalModifier \} from '@driftstack\/sdk';/);
    expect(body).toMatch(
      /readonly CanonicalModifier\[\] \| undefined \{\s*const mods: CanonicalModifier\[\] = \[\];/,
    );
  });
});
