// 2026-05-20 — LK.6.d modifier-vocabulary cross-surface parity.
//
// Both the gui-client (Tauri desktop) + customer-dashboard (Astro
// Cloudflare Pages browser app) capture KeyboardEvents and POST
// LK.6 InputEvent payloads to /v1/agent-sessions/:id/input-event.
// They MUST use the same modifier vocabulary so the Mac harness
// decoder sees a single payload shape regardless of which surface
// the customer drove from.
//
// Vocabulary lock (2026-05-20): cmd / ctrl / shift / option —
// Mac-native labels, 1:1 with Quartz CGEventFlags
// (kCGEventFlagMaskCommand → cmd, etc.). Pre-lock, gui-client used
// DOM-standard Shift/Control/Alt/Meta names which forced the
// harness to remap Meta→Command on every key press. The customer-
// dashboard inline copy already used the Mac-native form; aligning
// gui-client closed the drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GUI_CLIENT = resolve(REPO_ROOT, 'apps/gui-client/src/lib/livekit-input-capture.ts');
const CUSTOMER_DASHBOARD = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/agent-sessions/[id].astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('LK.6.d modifier-vocabulary cross-surface parity', () => {
  it('gui-client modifiersFromEvent uses Mac-native vocabulary (cmd/ctrl/shift/option)', () => {
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
  });

  it('customer-dashboard inline modifiersFromEvent uses the same Mac-native vocabulary', () => {
    const body = read(CUSTOMER_DASHBOARD);
    expect(body).toMatch(/if \(ev\.metaKey\) out\.push\('cmd'\);/);
    expect(body).toMatch(/if \(ev\.ctrlKey\) out\.push\('ctrl'\);/);
    expect(body).toMatch(/if \(ev\.shiftKey\) out\.push\('shift'\);/);
    expect(body).toMatch(/if \(ev\.altKey\) out\.push\('option'\);/);
    // Same negative guard against the DOM-standard names returning.
    expect(body).not.toMatch(/out\.push\('Shift'\)/);
    expect(body).not.toMatch(/out\.push\('Control'\)/);
    expect(body).not.toMatch(/out\.push\('Alt'\)/);
    expect(body).not.toMatch(/out\.push\('Meta'\)/);
  });
});
