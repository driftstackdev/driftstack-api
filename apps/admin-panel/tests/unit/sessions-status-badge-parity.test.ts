// W344.C — drift guard for admin /sessions page STATUS_BADGE map.
// The page covers all 5 session statuses; if a new status lands
// (e.g. 'queued' from a future scheduler) without a matching
// badge entry, the page renders an un-styled span. Mirror of the
// W340.C incidents-badge-parity pattern.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W344.C admin /sessions STATUS_BADGE ↔ SessionStatusSchema parity', () => {
  const page = read(PAGE);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  const block = page.match(/const\s+STATUS_BADGE\s*=\s*\{([\s\S]*?)\};/);
  expect(block).not.toBeNull();
  const keys = [...block![1]!.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();

  it('STATUS_BADGE keys match SessionStatusSchema exactly', () => {
    expect(keys).toEqual([...statuses].sort());
  });

  it('status filter options also match SessionStatusSchema', () => {
    const options = [...page.matchAll(/<option value="([a-z_]+)">\1<\/option>/g)]
      .map((match) => match[1]!)
      .sort();
    expect(options).toEqual([...statuses].sort());
  });

  it("'ready' uses emerald, 'errored' uses red, 'busy' uses blue (semantic colour pin)", () => {
    expect(block![1]!).toMatch(/ready:\s*'[^']*emerald[^']*'/);
    expect(block![1]!).toMatch(/errored:\s*'[^']*red[^']*'/);
    expect(block![1]!).toMatch(/busy:\s*'[^']*blue[^']*'/);
  });

  it('every badge has a unique Tailwind class string (no copy-paste collisions)', () => {
    const classes = [...block![1]!.matchAll(/^\s*[a-z_]+:\s*'([^']+)',/gm)].map((m) => m[1]!);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('force-destroy is the only admin mutation surfaced on the list page', () => {
    // The page narrative pins this — replays / recording-view
    // flow through per-account detail pages. Pin the narrative so
    // a future "Replay all" button can't quietly land here.
    expect(page).toMatch(/Force-destroy is\s+the only mutation surfaced here/);
  });

  it('device labels derive from the registry instead of one hard-coded mock archetype', () => {
    expect(page).toMatch(/ARCHETYPE_REGISTRY\.map/);
    expect(page).toMatch(/archetypeDisplayLabel\(a\.id\)/);
  });

  it('admin endpoints surface: GET /v1/admin/sessions + POST /v1/admin/sessions/:id/destroy', () => {
    expect(page).toMatch(/\/v1\/admin\/sessions/);
    expect(page).toMatch(/\/v1\/admin\/sessions\/[^'"`]*destroy/);
  });
});
