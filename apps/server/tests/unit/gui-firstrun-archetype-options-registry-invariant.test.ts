// Cross-source invariant: the GUI FirstRunWizard's customer-facing archetype
// picker (PROFILE_ARCHETYPE_OPTIONS) must stay in sync with the
// customer-selectable set of ARCHETYPE_REGISTRY — i.e. the entries with
// status 'launch' or 'available'. The wizard currently hardcodes its 2-option
// catalog in a parallel list (apps/gui-client/src/views/FirstRunWizard.tsx);
// this guard ensures it can't silently drift from the registry source of
// truth. When Agent-1 populates a new device and it flips to 'available', this
// guard fails until the wizard offers it too (or is wired to derive from the
// registry directly). 'reference'/'planned' entries are intentionally NOT
// customer-selectable, so they must NOT appear as wizard options.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const WIZARD = resolve(REPO_ROOT, 'apps/gui-client/src/views/FirstRunWizard.tsx');

function wizardOptionValues(): string[] {
  const body = readFileSync(WIZARD, 'utf8');
  return (body.match(/value: '([a-z0-9_]+)'/g) || [])
    .map((m) => m.replace(/value: '|'/g, ''))
    .filter((v) => /^(iphone|ipad)/.test(v)); // archetype-shaped option values only
}

const selectable = ARCHETYPE_REGISTRY.filter(
  (a) => a.status === 'launch' || a.status === 'available',
).map((a) => a.id);

describe('GUI FirstRunWizard archetype options ↔ ARCHETYPE_REGISTRY selectable set', () => {
  it('there is a non-empty customer-selectable set (launch|available)', () => {
    expect(selectable.length).toBeGreaterThan(0);
  });

  it('FirstRunWizard offers EXACTLY the selectable archetypes — no stale/extra, none missing', () => {
    expect([...wizardOptionValues()].sort()).toEqual([...selectable].sort());
  });

  it('every FirstRunWizard option is a REGISTERED archetype (catches a slug typo / unregistered device)', () => {
    const allIds = new Set(ARCHETYPE_REGISTRY.map((a) => a.id));
    for (const v of wizardOptionValues()) {
      expect(allIds.has(v), `FirstRunWizard offers '${v}' which is not in ARCHETYPE_REGISTRY`).toBe(
        true,
      );
    }
  });

  it('no internal-only (reference) or unpopulated (planned) archetype leaks into the wizard', () => {
    const nonSelectable = new Set(
      ARCHETYPE_REGISTRY.filter((a) => a.status === 'reference' || a.status === 'planned').map(
        (a) => a.id,
      ),
    );
    for (const v of wizardOptionValues()) {
      expect(nonSelectable.has(v), `wizard offers non-selectable archetype '${v}'`).toBe(false);
    }
  });
});
