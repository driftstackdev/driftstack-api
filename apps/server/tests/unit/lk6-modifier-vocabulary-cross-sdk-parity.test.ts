// Slice 6 (Wave 29-NNN ARC 3) cross-SDK parity for the LK.6 InputEvent
// modifier vocabulary. The 4 canonical names (cmd / ctrl / shift /
// option) map 1:1 onto Quartz CGEventFlags on the macOS harness side;
// any of the 3 SDKs documenting a different vocabulary would lead a
// customer's input-event to be silently dropped by the harness decoder.
//
// Sister tests:
//   - lk6-modifier-vocabulary-cross-surface-parity.test.ts pins the
//     gui-client + customer-dashboard surfaces against DOM-standard
//     drift.
//   - This file extends the guarantee to all 3 SDK docstrings + the
//     api-types schema comment block.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Slice 6 LK.6 modifier vocabulary cross-SDK parity', () => {
  it('api-types/src/agent-input-event.ts exports CANONICAL_MODIFIER_NAMES = ["cmd", "ctrl", "shift", "option"] as const + CanonicalModifier type', () => {
    const lib = resolve(REPO_ROOT, 'packages/api-types/src/agent-input-event.ts');
    expect(existsSync(lib)).toBe(true);
    const body = read(lib);
    expect(body).toMatch(
      /export const CANONICAL_MODIFIER_NAMES = \['cmd', 'ctrl', 'shift', 'option'\] as const;/,
    );
    expect(body).toMatch(
      /export type CanonicalModifier = \(typeof CANONICAL_MODIFIER_NAMES\)\[number\];/,
    );
  });

  it('api-types schema comment pins Slice 6 cross-SDK lock + references the cross-surface parity test', () => {
    const lib = resolve(REPO_ROOT, 'packages/api-types/src/agent-input-event.ts');
    const body = read(lib);
    expect(body).toMatch(/Canonical modifier vocabulary \(Slice 6 cross-SDK lock 2026-05-20\)\./);
    expect(body).toMatch(/Quartz `CGEventFlags`/);
    expect(body).toMatch(/lk6-modifier-vocabulary-cross-surface-\s*\* parity\.test\.ts/);
    expect(body).toMatch(/DOM-standard variants/);
  });

  it('TypeScript SDK agent-sessions.ts sendInputEvent JSDoc pins the 4-name vocabulary + the harness-drops-DOM-names warning', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts');
    const body = read(lib);
    expect(body).toMatch(/Modifier vocabulary \(Slice 6 cross-SDK lock 2026-05-20\):/);
    expect(body).toMatch(/`'cmd' \| 'ctrl' \| 'shift' \| 'option'` \(1:1 Quartz CGEventFlags\)/);
    expect(body).toMatch(/DOM-standard names \(`Shift \/ Control \/ Alt \/ Meta`\)/);
    expect(body).toMatch(/harness decoder drops them/);
  });

  it('Python SDK agent_sessions.py send_input_event docstring pins the 4-name vocabulary + the harness-drops-DOM-names warning', () => {
    const lib = resolve(
      REPO_ROOT,
      'packages/sdk-python/src/driftstack/resources/agent_sessions.py',
    );
    const body = read(lib);
    expect(body).toMatch(/Modifier vocabulary \(Slice 6 cross-SDK lock 2026-05-20\):/);
    expect(body).toMatch(/``"cmd" \| "ctrl" \| "shift" \| "option"`` \(1:1 Quartz/);
    expect(body).toMatch(/DOM-standard names \(``Shift \/ Control \/\s*Alt \/ Meta``\)/);
    expect(body).toMatch(/harness decoder drops them/);
  });

  it('Go SDK agent_sessions.go SendInputEvent comment pins the 4-name vocabulary + the harness-drops-DOM-names warning', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go');
    const body = read(lib);
    expect(body).toMatch(/Modifier vocabulary \(Slice 6 cross-SDK lock 2026-05-20\): keyDown/);
    expect(body).toMatch(
      /"cmd" \/ "ctrl"\s*\/\/ \/ "shift" \/ "option" \(1:1 Quartz CGEventFlags\)/,
    );
    expect(body).toMatch(/DOM-standard\s*\/\/ names \(Shift \/ Control \/ Alt \/ Meta\)/);
    expect(body).toMatch(/harness decoder drops them/);
  });

  it('Python SDK agent_sessions.py exports CANONICAL_MODIFIER_NAMES tuple + CanonicalModifier Literal type matching api-types', () => {
    const lib = resolve(
      REPO_ROOT,
      'packages/sdk-python/src/driftstack/resources/agent_sessions.py',
    );
    const body = read(lib);
    expect(body).toMatch(
      /CANONICAL_MODIFIER_NAMES: tuple\[str, \.\.\.\] = \("cmd", "ctrl", "shift", "option"\)/,
    );
    expect(body).toMatch(/CanonicalModifier = Literal\["cmd", "ctrl", "shift", "option"\]/);
  });

  it('Go SDK agent_sessions.go exports CanonicalModifierNames slice matching api-types', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go');
    const body = read(lib);
    expect(body).toMatch(
      /var CanonicalModifierNames = \[\]string\{"cmd", "ctrl", "shift", "option"\}/,
    );
  });

  it('TS SDK index.ts re-exports CANONICAL_MODIFIER_NAMES + CanonicalModifier from api-types', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');
    const body = read(lib);
    expect(body).toMatch(
      /export \{[^}]*CANONICAL_MODIFIER_NAMES[^}]*type CanonicalModifier[^}]*\} from '@driftstack\/api-types';/s,
    );
  });

  it('OpenAPI input-event route description pins the modifier vocabulary + the harness-drops-DOM-names warning', () => {
    const lib = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
    const body = read(lib);
    expect(body).toMatch(
      /Slice 6\s*\/\/ \(2026-05-20\) — modifier vocabulary documented in description\./,
    );
    expect(body).toMatch(
      /Modifier vocabulary \(keyDown \/ keyUp `modifiers` array\): use the canonical 4-name set 'cmd' \| 'ctrl' \| 'shift' \| 'option'/,
    );
    expect(body).toMatch(/map 1:1 onto Quartz CGEventFlags on the macOS harness side/);
    expect(body).toMatch(
      /DOM-standard names \(Shift \/ Control \/ Alt \/ Meta\) round-trip through the schema unchanged but the harness decoder drops them\./,
    );
  });

  it('All 3 SDK quickstart docs have a "### Modifier vocabulary" section example using cmd+shift modifiers', () => {
    const ts = read(resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md'));
    const py = read(resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md'));
    const go = read(resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md'));
    for (const body of [ts, py, go]) {
      expect(body).toMatch(/### Modifier vocabulary/);
      expect(body).toMatch(/canonical 4-name set/);
      expect(body).toMatch(/Quartz `CGEventFlags`/);
      expect(body).toMatch(
        /DOM-standard names \(`Shift \/ Control \/ Alt \/ Meta`\) round-trip\s*through the schema unchanged but the harness decoder drops them\./,
      );
    }
    expect(ts).toMatch(/modifiers: \['cmd', 'shift'\]/);
    expect(py).toMatch(/"modifiers": \["cmd", "shift"\]/);
    expect(go).toMatch(/"modifiers": \[\]string\{"cmd", "shift"\}/);
  });
});
