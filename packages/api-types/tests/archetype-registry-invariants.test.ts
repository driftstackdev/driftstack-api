// The archetype registry decides what a customer can select, so its shape is a
// product surface, not a data table.
//
// What existed before this file was a source-text pin asserting that a
// representative spread of slugs appears and that each status literal appears
// SOMEWHERE. That cannot see an entry being added, removed, or re-statused —
// which is exactly the change this registry is expected to undergo: A1's
// catalog carries three chrome-iOS slugs my registry does not, and 27 slugs on
// the 26.0/26.3 bands are pending a decision to move to `planned`.
//
// The same pin's prose said "the full 81-slug Agent-1 catalog folds in". Both
// numbers were stale: the registry holds 82 entries (a naive grep says 81
// because the launch entry uses LOCKED_ARCHETYPE_ID rather than a literal) and
// the catalog holds 84. Counting by hand from a regex is how that drifted.
//
// These arms run against the imported registry rather than its source text, so
// they measure what the API will actually do.

import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_REGISTRY,
  LOCKED_ARCHETYPE_ID,
  isSelectableArchetypeId,
  type ArchetypeStatus,
} from '../src/common.js';

/** Every status the type declares. Adding one must be a deliberate act here. */
const DECLARED_STATUSES: readonly ArchetypeStatus[] = [
  'launch',
  'available',
  'reference',
  'planned',
];

/** Statuses a customer may select. `reference` and `planned` are deliberately not. */
const SELECTABLE_STATUSES: readonly ArchetypeStatus[] = ['launch', 'available'];

describe('the archetype registry keeps its shape', () => {
  it('CRITICAL exactly one entry is the launch default, and it is the locked id', () => {
    const launch = ARCHETYPE_REGISTRY.filter((a) => a.status === 'launch');
    expect(
      launch.map((a) => a.id),
      'the launch default must be exactly one entry — a second would make the default ambiguous ' +
        'and a zeroth would leave new sessions with no archetype to fall back to',
    ).toEqual([LOCKED_ARCHETYPE_ID]);
  });

  it('CRITICAL every entry carries a declared status', () => {
    // TypeScript enforces this at the literal, but a cast or a generated entry
    // can slip past it, and an unrecognised status silently drops out of the
    // selectable filter — the archetype disappears from the API with no error.
    const undeclared = ARCHETYPE_REGISTRY.filter((a) => !DECLARED_STATUSES.includes(a.status)).map(
      (a) => `${a.id}: ${String(a.status)}`,
    );
    expect(undeclared, 'an entry carries a status the type does not declare').toEqual([]);
  });

  it('CRITICAL selectability is derived from status, for every entry', () => {
    // Not a spot-check: the whole registry is compared against the rule. A
    // hand-maintained selectable list, or a filter that stops consulting
    // status, fails here rather than in a customer's create call.
    const wrong = ARCHETYPE_REGISTRY.filter(
      (a) => isSelectableArchetypeId(a.id) !== SELECTABLE_STATUSES.includes(a.status),
    ).map((a) => `${a.id} (${a.status}) selectable=${String(isSelectableArchetypeId(a.id))}`);
    expect(
      wrong,
      'an archetype’s selectability disagrees with its status. Either a non-selectable slug is ' +
        'dispatchable through POST /v1/sessions, or a customer-visible one cannot be selected',
    ).toEqual([]);
  });

  it('CRITICAL ids are unique and slug-shaped', () => {
    const ids = ARCHETYPE_REGISTRY.map((a) => a.id);
    expect(new Set(ids).size, 'a duplicate id makes the later entry unreachable').toBe(ids.length);
    const malformed = ids.filter((id) => !/^[a-z0-9_]{3,60}$/.test(id));
    expect(
      malformed,
      'an id that fails the request-schema regex can never be selected, whatever its status',
    ).toEqual([]);
  });

  it('the registry population is pinned, so an add or a removal is deliberate', () => {
    // Deliberately a bare count. The registry is expected to change — three
    // chrome-iOS slugs may arrive from A1's catalog, and 27 slugs on the
    // 26.0/26.3 bands may move to `planned` — and each of those should be a
    // decision someone made, not a diff nobody noticed. Update the numbers with
    // the change.
    const byStatus = ARCHETYPE_REGISTRY.reduce<Record<string, number>>((acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(ARCHETYPE_REGISTRY.length, 'registry size changed').toBe(82);
    expect(byStatus, 'the status mix changed').toEqual({ launch: 1, available: 80, reference: 1 });
  });

  it('CRITICAL the legacy reference baseline stays non-selectable', () => {
    // It predates the catalog and is retained so existing rows stay readable,
    // cloneable and launchable — but it must never be offered as a choice.
    const reference = ARCHETYPE_REGISTRY.filter((a) => a.status === 'reference');
    expect(reference.length, 'the reference baseline went missing').toBeGreaterThanOrEqual(1);
    for (const entry of reference) {
      expect(
        isSelectableArchetypeId(entry.id),
        `${entry.id} is a reference baseline and must not be customer-selectable`,
      ).toBe(false);
    }
  });
});
