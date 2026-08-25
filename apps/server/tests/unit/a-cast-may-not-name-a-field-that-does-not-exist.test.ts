import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './_helpers/code-only.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * V-1611 — `SimulatorWindow` built a `LiveKitInfo` with `room_name` and cast it
 * with `as unknown as LiveKitInfo`, and `open-simulator` read `room_name` back
 * off one the same way. **`LiveKitInfo` has no `room_name`.** The field is
 * `room`.
 *
 * ⛔ The failure mode is what makes this worth a guard. A cast naming a field
 * that does not exist CANNOT fail — it silently yields `undefined` — so the
 * handoff carried an empty room on every launch and nothing anywhere said so.
 * `AgentSessionPanel` then compares `sessionTimingRef.current.identity !==
 * info.room`, which with `room` absent is `undefined !== undefined`: false
 * forever, and the reset branch is dead on that path.
 *
 * ⚠️ Latent rather than customer-visible — the simulator's `info` is parsed from
 * the URL once and never changes, so the reset it disabled would not have fired
 * anyway. Guarded because the COMMENT asserted the cast had been checked
 * ("Cast is safe — the panel reads ws_url/token only"), and that is the part
 * that would have stopped the next reader from looking.
 */

/** The field set, DERIVED from the SDK rather than restated here — a guard that
 *  pins its own copy of a shape goes stale the day the shape moves. */
function liveKitInfoFields(): Set<string> {
  const src = read('packages/sdk-typescript/src/resources/agent-sessions.ts');
  const body = /export interface LiveKitInfo \{([\s\S]*?)\n\}/.exec(src)?.[1];
  if (body === undefined) throw new Error('LiveKitInfo interface not found — this guard is blind');
  return new Set([...codeOnly(body).matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1] as string));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('a cast may not name a field that does not exist', () => {
  it('CRITICAL LiveKitInfo has `room`, and nothing constructs or reads `room_name`. A cast naming an absent field cannot fail — it yields undefined — so the handoff silently carried an empty room and the panel comparison it feeds was dead.', () => {
    const fields = liveKitInfoFields();
    expect(fields, 'the SDK shape must still be readable').toContain('room');
    expect(fields, 'if room_name ever becomes real, retire this guard').not.toContain('room_name');

    const offenders: string[] = [];
    for (const file of walk(resolve(REPO_ROOT, 'apps/gui-client/src'))) {
      // Comments are stripped: the two corrected sites document the old spelling
      // in prose, and prose is inert.
      if (codeOnly(readFileSync(file, 'utf8')).includes('room_name')) {
        offenders.push(
          file
            .slice(REPO_ROOT.length + 1)
            .split(sep)
            .join('/'),
        );
      }
    }
    expect(
      offenders,
      'these name a LiveKitInfo field that does not exist; the field is `room`',
    ).toEqual([]);
  });

  it('CRITICAL the simulator handoff round-trips the room. open-simulator writes the query param and SimulatorWindow reads it back; both used the non-existent name, so the value was empty end to end.', () => {
    expect(codeOnly(read('apps/gui-client/src/lib/open-simulator.ts')), 'write side').toContain(
      'room: info.room',
    );
    expect(codeOnly(read('apps/gui-client/src/views/SimulatorWindow.tsx')), 'read side').toMatch(
      /room:\s*q\.get\('room'\)/,
    );
  });
});
