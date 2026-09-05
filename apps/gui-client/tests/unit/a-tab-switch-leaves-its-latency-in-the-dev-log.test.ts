// P-26 (2026-09-05) — a tab switch must leave its latency in the dev-log.
//
// The ledger asked A2 for THE NUMBER a tab switch costs against the warm-tabs
// box, and the GUI kept none: `switchingTabId` is set on the optimistic switch
// and cleared on the ack or the target's loaded frame, but nothing durable
// recorded how long that took or whether the harness claimed a WARM swap. This
// guard pins the instrument that closes that gap:
//
//   1. the logical activation carries `startedAt`, stamped when the optimistic
//      switch begins (not when the publish resolves — LiveKit's publish promise
//      can lag the ack on a loopback-fast box);
//   2. the correlated ack records `[tab-switch] ack` through the log buffer's own
//      `record('info', …)` (the path console.info takes after installLogCapture,
//      minus the no-console lint) with the elapsed ms, the harness's `wasWarm`
//      claim and the outcome — before the branch that decides whether to drop
//      the cover;
//   3. `info` is a captured level, so the line reaches recordings/dev-log*.txt.
//
// Drift guard, not a behaviour test: the ack handler lives 5000 lines into a
// 9000-line component whose render needs a live Room. Each arm is phrased so
// that deleting the instrument (or moving the stamp to the wrong moment) reds.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, '..', '..');
const WINDOW = resolve(GUI_ROOT, 'src/views/SimulatorWindow.tsx');
const LOG_BUFFER = resolve(GUI_ROOT, 'src/lib/log-buffer.ts');

describe('P-26 — a tab switch leaves its latency in the dev-log', () => {
  const body = readFileSync(WINDOW, 'utf8');

  it('the logical activation carries startedAt, stamped where the activation is created', () => {
    // The interface field, on LogicalTabActivation specifically (the only record
    // with a `requestIds: Set<string>`), not on the retry record.
    expect(body).toMatch(
      /requestIds: Set<string>;\s*terminalTargetFrameSeen: boolean;\s*settled: boolean;\s*(?:\/\/[^\n]*\n\s*)*startedAt: number;/,
    );
    // Stamped in the SAME literal that mints the activation — Date.now() at
    // creation, never copied from the retry or the ack.
    expect(body).toMatch(
      /requestIds: new Set\(\),\s*terminalTargetFrameSeen: ctx\.terminalTargetFrameSeen === true,\s*settled: false,\s*startedAt: Date\.now\(\),/,
    );
  });

  it('the correlated ack records elapsedMs + wasWarm + ok at INFO via log-buffer.record, before the cover decision', () => {
    // Through the buffer's own entry point, not console.info: the same capture
    // path, and the file's lint (no-console allows only warn/error) stays clean.
    expect(body).toMatch(/import \{ record \} from '\.\.\/lib\/log-buffer';/);
    expect(body).toMatch(/record\('info', \[\s*'\[tab-switch\] ack',\s*\{/);
    const ack = body.indexOf("'[tab-switch] ack',");
    expect(ack, 'the ack record line exists').toBeGreaterThan(0);
    const block = body.slice(ack, ack + 400);
    expect(block).toMatch(/tabId: pending\.tabId,/);
    expect(block).toMatch(/elapsedMs: Date\.now\(\) - pending\.startedAt,/);
    expect(block).toMatch(/wasWarm: msg\.wasWarm === true,/);
    expect(block).toMatch(/ok: !failed,/);
    // Ordered BEFORE the warm/cold cover branch so a throw in that branch can
    // never lose the measurement.
    const branch = body.indexOf(
      'if (msg.wasWarm === true || pending.terminalTargetFrameSeen || failed) {',
    );
    expect(branch, 'the cover branch exists').toBeGreaterThan(0);
    expect(ack).toBeLessThan(branch);
    // Exactly one instrument — a second copy would double-count a switch.
    expect(body.split("'[tab-switch] ack'")).toHaveLength(2);
  });

  it("'info' is a captured log level, so the line reaches the on-disk dev-log", () => {
    const logBuffer = readFileSync(LOG_BUFFER, 'utf8');
    expect(logBuffer).toMatch(
      /const levels: LogLevel\[\] = \['log', 'info', 'warn', 'error', 'debug'\];/,
    );
  });
});
