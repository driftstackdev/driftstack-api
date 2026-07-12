// Drift guard for apps/gui-client/src/components/DevLogPanel.tsx (GUI W232 d).
// The toggleable in-app dev-log view. Drift would break the subscribe→re-render
// wiring (the buffer mutates in place, so identity-based memo would freeze the
// view), or drop the Copy/Clear affordances the operator needs.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/DevLogPanel.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client components/DevLogPanel content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Subscribes to the buffer + force-renders on change — pinned because the buffer mutates in place (reference identity never changes), so a subscribe + forceRender is REQUIRED or the view freezes', () => {
    expect(body).toMatch(/useEffect\(\(\) => subscribeLogs\(forceRender\), \[\]\);/);
    expect(body).toMatch(/useReducer\(\(n: number\) => n \+ 1, 0\)/);
  });

  it('Copy + Clear + Close affordances pinned (operator needs to extract / reset the log)', () => {
    expect(body).toMatch(/formatLogEntries\(\)/);
    expect(body).toMatch(/setCopyState\('failed'\)/);
    expect(body).toMatch(/'Copy failed — retry'/);
    expect(body).toMatch(/clearLogEntries\(\)/);
    expect(body).toMatch(/setOpen\(false\)/);
  });

  it('Stable React keys on entries (key={e.id}) — pinned so the list reconciles correctly as the ring buffer evicts oldest entries', () => {
    expect(body).toMatch(/key=\{e\.id\}/);
  });

  it('data-dev-logs-toggle + data-dev-logs-panel test hooks present', () => {
    expect(body).toMatch(/data-dev-logs-toggle/);
    expect(body).toMatch(/data-dev-logs-panel/);
  });
});
