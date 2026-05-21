// W291.B — drift guard for DashboardLayout nav labels. Each nav
// item label must be unique within the layout so the active-state
// highlight + screen-reader announcements aren't ambiguous.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W291.B DashboardLayout nav-label uniqueness', () => {
  const body = read(LAYOUT);
  // 2026-05-21 — items now carry an optional `icon: ICON.X` field after
  // the label; the regex tolerates any trailing properties before the
  // closing brace so the uniqueness guard survives the icon addition.
  const labels = [
    ...body.matchAll(
      /\{\s*href:\s*['"][^'"]+['"]\s*,\s*label:\s*['"]([^'"]+)['"]\s*(?:,[^}]*)?\}/g,
    ),
  ].map((m) => m[1]!);

  it('layout declares at least 5 nav items', () => {
    expect(labels.length).toBeGreaterThanOrEqual(5);
  });

  it('no two nav items share the same label', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const l of labels) {
      if (seen.has(l)) dupes.push(l);
      else seen.add(l);
    }
    expect(dupes).toEqual([]);
  });
});
