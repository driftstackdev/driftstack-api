// A3 contract audit (2026-09-05, harness 07c8a693f) — a switch that failed because the
// SESSION ended must not be reported as a failed switch.
//
// The harness can answer activateTab with six error tokens; the contract doc listed
// four. One of the two it had missed is "session ended" (the session was reaped between
// the switch and its stamp). The GUI's single failure path reverts to the previous tab
// and says "Could not switch tab" — which is wrong in kind for that token: the whole
// session is gone, so the tab the revert just selected is gone too, and the operator's
// next tap earns the same toast a second time. This pins the distinct copy, in the
// vocabulary the agent-session panel already uses ("Session ended").
//
// Drift guard rather than a behaviour test: the failure path sits ~5500 lines into a
// component whose render needs a live Room and a connected data channel.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, '..', '..');
const WINDOW = resolve(GUI_ROOT, 'src/views/SimulatorWindow.tsx');

describe('a switch that failed because the session ended says so', () => {
  const body = readFileSync(WINDOW, 'utf8');

  it('CRITICAL the harness "session ended" token gets its own copy; every other token keeps the per-switch message', () => {
    // Read from the frame the harness actually sent, normalised so a stray case or
    // space cannot silently fall through to the generic copy.
    expect(body).toMatch(
      /const harnessError =\s*typeof msg\.error === 'string' \? msg\.error\.trim\(\)\.toLowerCase\(\) : '';/,
    );
    expect(body).toMatch(
      /showNotice\(\s*harnessError === 'session ended' \? 'Session ended' : 'Could not switch tab',\s*3000,?\s*\);/,
    );
  });

  it('the generic copy survives for the per-switch tokens — exactly one failure notice site', () => {
    // Two copies would mean a second failure path that could diverge from this rule.
    expect(body.split("'Could not switch tab'")).toHaveLength(2);
    expect(body.split("'Session ended'")).toHaveLength(2);
  });

  it("matches the app's existing session-loss vocabulary rather than inventing a third phrasing", () => {
    const panel = readFileSync(resolve(GUI_ROOT, 'src/components/AgentSessionPanel.tsx'), 'utf8');
    expect(panel).toMatch(/Session ended/);
  });
});
