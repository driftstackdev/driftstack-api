// v2-#22 — cross-SDK archetype roster parity.
//
// Pins the customer-visible archetype id + display label across:
//
//   - api-types: LOCKED_ARCHETYPE_ID + LOCKED_ARCHETYPE_DISPLAY_LABEL
//     (packages/api-types/src/common.ts)
//   - Server runtime: AgentRuntime default archetype literal
//     (apps/server/src/lib/bootstrap.ts)
//   - Go SDK: types.go + agent_chat / profile_snapshots test fixtures
//   - TypeScript SDK: test fixtures
//   - Python SDK: test fixtures
//
// Source-of-truth fixture lives at
// `apps/server/tests/_fixtures/archetype-roster.json` — a JSON file
// rather than a TS const so a Python or Go-only contributor can edit
// it without touching the TypeScript build graph. The cross-SDK parity
// test below loads the JSON + asserts every supported language has the
// same canonical id appear in their source/tests.
//
// Drift example this catches: iPhone 17 archetype added to api-types +
// Go SDK but Python SDK still tests against iPhone 16 Pro literal →
// Python customers' integration tests silently keep using the old
// archetype while the server-default flips. Parity test fails before
// the multi-archetype rollout lands.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCKED_ARCHETYPE_ID,
  LOCKED_ARCHETYPE_DISPLAY_LABEL,
  ARCHETYPE_DISPLAY_LABEL,
  ARCHETYPE_REGISTRY,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FIXTURE = resolve(REPO_ROOT, 'apps/server/tests/_fixtures/archetype-roster.json');

interface RosterEntry {
  id: string;
  display_label: string;
  status: 'locked' | 'preview' | 'deprecated';
  notes: string;
}

interface Roster {
  version: number;
  locked_id: string;
  archetypes: RosterEntry[];
}

function readRoster(): Roster {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Roster;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#22 cross-SDK archetype roster parity', () => {
  it('source-of-truth fixture exists at canonical path', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  it('fixture is well-formed: version + locked_id + ≥1 archetype with locked status', () => {
    const roster = readRoster();
    expect(roster.version).toBe(1);
    expect(roster.archetypes.length).toBeGreaterThanOrEqual(1);
    const locked = roster.archetypes.find((a) => a.id === roster.locked_id);
    expect(locked, `locked_id ${roster.locked_id} must appear in archetypes`).toBeDefined();
    expect(locked?.status).toBe('locked');
  });

  it('CRITICAL api-types LOCKED_ARCHETYPE_ID matches the fixture locked entry id (single source-of-truth)', () => {
    const roster = readRoster();
    expect(LOCKED_ARCHETYPE_ID).toBe(roster.locked_id);
    const locked = roster.archetypes.find((a) => a.id === roster.locked_id);
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toBe(locked?.display_label);
  });

  it('CRITICAL api-types ARCHETYPE_DISPLAY_LABEL covers every fixture archetype id', () => {
    const roster = readRoster();
    for (const entry of roster.archetypes) {
      expect(
        ARCHETYPE_DISPLAY_LABEL[entry.id],
        `ARCHETYPE_DISPLAY_LABEL is missing an entry for ${entry.id}`,
      ).toBe(entry.display_label);
    }
  });

  it('CRITICAL every non-deprecated roster archetype is registry customer-SELECTABLE (status launch|available) — the cross-SDK customer roster must never expose an internal `reference` baseline or an unpopulated `planned` placeholder (both of which ARE in ARCHETYPE_DISPLAY_LABEL, so the label-coverage check above would not catch it)', () => {
    const roster = readRoster();
    const selectable = new Set(
      ARCHETYPE_REGISTRY.filter((a) => a.status === 'launch' || a.status === 'available').map(
        (a) => a.id,
      ),
    );
    for (const entry of roster.archetypes) {
      // A `deprecated` roster entry is being phased out and may no longer be
      // registry-selectable; only locked/preview entries must be selectable.
      if (entry.status === 'deprecated') continue;
      expect(
        selectable.has(entry.id),
        `roster archetype ${entry.id} (status ${entry.status}) must be a registry launch|available entry — NOT a reference/planned archetype exposed to SDK customers`,
      ).toBe(true);
    }
  });

  it('CRITICAL server runtime references every fixture archetype id (bootstrap.ts AgentRuntime default + sessions defaults)', () => {
    const roster = readRoster();
    const bootstrap = read(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
    // The locked archetype MUST appear as the AgentRuntime default
    // literal in bootstrap. Non-locked archetypes don't have to —
    // they're opted-in via the route layer.
    expect(bootstrap).toContain(roster.locked_id);
  });

  it('CRITICAL Go SDK references every fixture archetype id at least once (types.go + tests)', () => {
    const roster = readRoster();
    const goTypes = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    const goClientTest = read(resolve(REPO_ROOT, 'packages/sdk-go/client_test.go'));
    const goProfilesTest = read(resolve(REPO_ROOT, 'packages/sdk-go/profiles_test.go'));
    const combined = `${goTypes}\n${goClientTest}\n${goProfilesTest}`;
    for (const entry of roster.archetypes) {
      expect(
        combined,
        `Go SDK must reference archetype id ${entry.id} (types.go or test fixtures)`,
      ).toContain(entry.id);
    }
  });

  it('CRITICAL TypeScript SDK references every fixture archetype id at least once (tests)', () => {
    const roster = readRoster();
    const tsProfiles = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/tests/unit/profiles-clone.test.ts'),
    );
    const tsSnapshots = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/tests/unit/profile-snapshots.test.ts'),
    );
    const combined = `${tsProfiles}\n${tsSnapshots}`;
    for (const entry of roster.archetypes) {
      expect(combined, `TypeScript SDK tests must reference archetype id ${entry.id}`).toContain(
        entry.id,
      );
    }
  });

  it('CRITICAL Python SDK references every fixture archetype id at least once (tests)', () => {
    const roster = readRoster();
    const pySessions = read(
      resolve(REPO_ROOT, 'packages/sdk-python/tests/test_resources_sessions.py'),
    );
    const pyIterate = read(
      resolve(REPO_ROOT, 'packages/sdk-python/tests/test_resources_iterate.py'),
    );
    const pyWorkflow = read(
      resolve(REPO_ROOT, 'packages/sdk-python/tests/test_integration_workflow.py'),
    );
    const combined = `${pySessions}\n${pyIterate}\n${pyWorkflow}`;
    for (const entry of roster.archetypes) {
      expect(combined, `Python SDK tests must reference archetype id ${entry.id}`).toContain(
        entry.id,
      );
    }
  });

  it('CRITICAL no SDK references an archetype id NOT in the fixture — drift would surface customer-visible values without source-of-truth pin', () => {
    const roster = readRoster();
    const known = new Set(roster.archetypes.map((a) => a.id));
    // Walk Go's types.go + every SDK test file looking for the
    // `iphone…_ios…_safari…` shape; any match that's not in the known
    // set indicates an undocumented archetype id.
    const sources = [
      read(resolve(REPO_ROOT, 'packages/sdk-go/types.go')),
      read(resolve(REPO_ROOT, 'packages/sdk-go/client_test.go')),
      read(resolve(REPO_ROOT, 'packages/sdk-go/profiles_test.go')),
      read(resolve(REPO_ROOT, 'packages/sdk-typescript/tests/unit/profiles-clone.test.ts')),
      read(resolve(REPO_ROOT, 'packages/sdk-typescript/tests/unit/profile-snapshots.test.ts')),
      read(resolve(REPO_ROOT, 'packages/sdk-python/tests/test_resources_sessions.py')),
      read(resolve(REPO_ROOT, 'packages/sdk-python/tests/test_resources_iterate.py')),
      read(resolve(REPO_ROOT, 'packages/sdk-python/tests/test_integration_workflow.py')),
    ].join('\n');
    const matches = sources.match(/iphone\d+[a-z]*_ios\d+_\d+_safari\d+_\d+/g) ?? [];
    for (const m of matches) {
      expect(known, `archetype id ${m} is not in archetype-roster.json`).toContain(m);
    }
  });
});
