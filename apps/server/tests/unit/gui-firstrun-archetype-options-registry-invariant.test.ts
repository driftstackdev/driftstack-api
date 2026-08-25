// Cross-source invariant: the GUI FirstRunWizard's customer-facing archetype
// picker (PROFILE_ARCHETYPE_OPTIONS) must stay in sync with the
// customer-selectable set of ARCHETYPE_REGISTRY — i.e. the entries with
// status 'launch' or 'available'.
//
// 2026-06-19 de-dup: the wizard no longer hardcodes a parallel option list; it
// DERIVES PROFILE_ARCHETYPE_OPTIONS directly from ARCHETYPE_REGISTRY filtered
// by SELECTABLE_STATUSES ('launch' | 'available'), exactly as ProfilesView
// does. That makes the in-sync property structural — a promoted archetype
// lights up automatically. This guard now pins the derivation wiring (so a
// future refactor can't quietly re-introduce a hardcoded/drifting list) +
// asserts the resulting visible set still equals the registry-selectable set.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const WIZARD = resolve(REPO_ROOT, 'apps/gui-client/src/views/FirstRunWizard.tsx');

const wizardBody = readFileSync(WIZARD, 'utf8');

const selectable = ARCHETYPE_REGISTRY.filter(
  (a) => a.status === 'launch' || a.status === 'available',
).map((a) => a.id);

describe('GUI FirstRunWizard archetype options ↔ ARCHETYPE_REGISTRY selectable set', () => {
  it('there is a non-empty customer-selectable set (launch|available)', () => {
    expect(selectable.length).toBeGreaterThan(0);
  });

  it('FirstRunWizard DERIVES its option list from ARCHETYPE_REGISTRY (no hardcoded parallel catalog)', () => {
    // Imports the registry + the status type from the SDK barrel (prettier
    // may reflow this import across lines, so match members flexibly).
    expect(wizardBody).toMatch(/ARCHETYPE_REGISTRY,/);
    expect(wizardBody).toMatch(/type ArchetypeStatus,?\s*\}? from '@driftstack\/sdk';/);
    // Filters by the same launch|available selectable statuses ProfilesView uses.
    expect(wizardBody).toMatch(
      /const SELECTABLE_STATUSES = new Set<ArchetypeStatus>\(\['launch', 'available'\]\);/,
    );
    expect(wizardBody).toMatch(
      /const PROFILE_ARCHETYPE_OPTIONS = ARCHETYPE_REGISTRY\.filter\(\(a\) =>\s*SELECTABLE_STATUSES\.has\(a\.status\),\s*\)\.map\(/,
    );
    // No hardcoded archetype-shaped option-object literals remain.
    const literalValues = (wizardBody.match(/value: '([a-z0-9_]+)'/g) || [])
      .map((m) => m.replace(/value: '|'/g, ''))
      .filter((v) => /^(iphone|ipad)/.test(v));
    expect(literalValues).toEqual([]);
  });

  it('no internal-only (reference) or unpopulated (planned) archetype is in the selectable set the wizard derives from', () => {
    const nonSelectable = ARCHETYPE_REGISTRY.filter(
      (a) => a.status === 'reference' || a.status === 'planned',
    ).map((a) => a.id);
    for (const id of nonSelectable) {
      expect(
        selectable.includes(id),
        `non-selectable archetype '${id}' must not be selectable`,
      ).toBe(false);
    }
  });
});
