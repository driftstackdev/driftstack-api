// W486.B — drift guard for apps/gui-client/src/components/ProfilesActionBar.tsx.
// Operator-UI polish wave (2026-05-21). Pins the 3-segment status filter
// taxonomy + 3-option sort dropdown + search input contract; visible-text +
// accessibility live in apps/gui-client/tests/unit/ProfilesActionBar.test.tsx.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/ProfilesActionBar.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.B apps/gui-client/src/components/ProfilesActionBar.tsx content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("exports the ProfileStatusFilter + ProfileSortBy types so ProfilesView (and any future caller) can re-use the same taxonomy — pinned so a stray `as 'idle' | 'all'` literal can't fork the segmented-control's truth table", () => {
    expect(body).toMatch(/export type ProfileStatusFilter = 'all' \| 'running' \| 'idle';/);
    expect(body).toMatch(
      /export type ProfileSortBy = 'name' \| 'last-used' \| 'created' \| 'status' \| 'country';/,
    );
    expect(body).toMatch(/export type ProfileSortDir = 'asc' \| 'desc';/);
  });

  it("3-segment status filter taxonomy + sort dropdown 5 options pinned: All / Running / Idle ; Last used / Name / Created / Status / Country — pinned so a refactor can't silently drop a status or reorder the sort options (UX defaults rely on 'last-used' being first)", () => {
    expect(body).toMatch(/\{ id: 'all', label: 'All' \}/);
    expect(body).toMatch(/\{ id: 'running', label: 'Running' \}/);
    expect(body).toMatch(/\{ id: 'idle', label: 'Idle' \}/);
    expect(body).toMatch(/<option value="last-used">Last used<\/option>/);
    expect(body).toMatch(/<option value="name">Name<\/option>/);
    expect(body).toMatch(/<option value="created">Created<\/option>/);
    expect(body).toMatch(/<option value="status">Status<\/option>/);
    expect(body).toMatch(/<option value="country">Country<\/option>/);
  });

  it('search-input contract: aria-label="Search profiles", type=search, placeholder hints the ⌘F shortcut, clear button aria-label="Clear search" — pinned so the keyboard-accessible search surface stays addressable for tests + screen readers (the placeholder reminds the user that ⌘F is wired)', () => {
    expect(body).toMatch(/aria-label="Search profiles"/);
    expect(body).toMatch(/type="search"/);
    expect(body).toMatch(/placeholder="Search profiles… {2}⌘F"/);
    expect(body).toMatch(/aria-label="Clear search"/);
  });

  it('⌘F / Ctrl-F focuses the search input + Escape clears the query while focused — pinned so the macOS / browser "find" convention stays wired (operator workflow shortcut; same pattern as ProfilesView Cmd+, Settings hotkey)', () => {
    expect(body).toMatch(/const cmd = e\.metaKey \|\| e\.ctrlKey;/);
    expect(body).toMatch(/cmd && \(e\.key === 'f' \|\| e\.key === 'F'\)/);
    expect(body).toMatch(/searchRef\.current\?\.focus\(\)/);
    expect(body).toMatch(/searchRef\.current\?\.select\(\)/);
    expect(body).toMatch(/e\.key === 'Escape' && document\.activeElement === searchRef\.current/);
  });

  it("count-display rule: '{visibleCount} of {total}' when the visible set is narrowed (isFiltered = visibleCount !== totalCount OR a search query OR status !== 'all' — the visibleCount check now also covers folder-/tag-only filters the search/status check missed, audit), '{n} profile(s)' otherwise (singular at total===1) — pinned so the chrome stays honest about whether the customer is looking at a filtered slice or the whole list", () => {
    expect(body).toMatch(
      /const isFiltered =\s*visibleCount !== totalCount \|\| searchQuery\.trim\(\)\.length > 0 \|\| statusFilter !== 'all';/,
    );
    expect(body).not.toMatch(
      /const hasFilter = searchQuery\.trim\(\)\.length > 0 \|\| statusFilter !== 'all';/,
    );
    expect(body).toMatch(/\{isFiltered \?/);
    expect(body).toMatch(/\{visibleCount\} of \{totalCount\}/);
    expect(body).toMatch(/\{totalCount === 1 \? 'profile' : 'profiles'\}/);
  });

  it('status segmented control is a role="radiogroup" with aria-checked radios — pinned so the segmented affordance stays a proper accessible radio group (button group masquerading as one would fail axe + screen-reader testing)', () => {
    expect(body).toMatch(/role="radiogroup"/);
    expect(body).toMatch(/aria-label="Filter by status"/);
    expect(body).toMatch(/role="radio"/);
    expect(body).toMatch(/aria-checked=\{active\}/);
  });
});
