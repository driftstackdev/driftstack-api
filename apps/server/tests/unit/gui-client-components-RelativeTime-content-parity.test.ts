// W486.C-1 — drift guard for apps/gui-client/src/components/RelativeTime.tsx.
// Slice C of the BlackBird-inspired GUI overhaul (2026-05-21). Pins the
// SLICES threshold table so a refactor can't silently flip "5 min ago"
// to "300 seconds ago" or similar; visible-text contract lives in
// apps/gui-client/tests/unit/RelativeTime.test.tsx.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/RelativeTime.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.C-1 apps/gui-client/src/components/RelativeTime.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('SLICES table pinned: second / minute / hour / day / week / month thresholds — pinned so a careless refactor cannot collapse a unit or reorder the breakpoint cascade (the matching unit is the first slice whose threshold is greater than the absolute diff)', () => {
    expect(body).toMatch(/\{ threshold: 60_000, unit: 'second', divisor: 1_000 \}/);
    expect(body).toMatch(/\{ threshold: 3_600_000, unit: 'minute', divisor: 60_000 \}/);
    expect(body).toMatch(/\{ threshold: 86_400_000, unit: 'hour', divisor: 3_600_000 \}/);
    expect(body).toMatch(/\{ threshold: 604_800_000, unit: 'day', divisor: 86_400_000 \}/);
    expect(body).toMatch(/\{ threshold: 2_629_800_000, unit: 'week', divisor: 604_800_000 \}/);
    expect(body).toMatch(/\{ threshold: 31_557_600_000, unit: 'month', divisor: 2_629_800_000 \}/);
  });

  it("uses Intl.RelativeTimeFormat with numeric: 'auto' — pinned so output stays locale-aware (numeric:auto means 'yesterday' instead of '1 day ago' for the common cases)", () => {
    expect(body).toMatch(/new Intl\.RelativeTimeFormat\(undefined, \{ numeric: 'auto' \}\)/);
  });

  it('emits a <time> element with dateTime attr + a title tooltip — pinned so the absolute ISO + the human-readable absolute survive screen-reader / hover audits', () => {
    expect(body).toMatch(/<time dateTime=\{iso\} title=\{tooltip\}/);
  });
});
