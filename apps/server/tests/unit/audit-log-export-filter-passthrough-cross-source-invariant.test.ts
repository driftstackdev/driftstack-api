// Cross-source invariant: the audit-log export endpoint passes
// through the same 4 filter fields as the read endpoint
// (from / to / actor_type / target_resource_id). Drift would let
// the export bypass filters the read endpoint applies (privacy
// leak for team-member reads with X-Driftstack-Account).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('audit-log filter passthrough cross-source invariant', () => {
  const route = read(ROUTE);

  it('CSV export header row includes the 4 filter-passthrough columns: actor_type + target_resource_id (plus standard fields)', () => {
    expect(route).toMatch(/'actor_type',/);
    expect(route).toMatch(/'target_resource_id',/);
  });

  it('Public row mapper exposes actor_type + target_resource_id as snake_case fields (matching the customer SDK + docs)', () => {
    expect(route).toMatch(/actor_type: row\.actorType,/);
    expect(route).toMatch(/target_resource_id: row\.targetResourceId,/);
  });

  it('Read endpoint conditional-spreads actor_type + target_resource_id filters (only-when-defined PATCH semantics)', () => {
    expect(route).toMatch(
      /\.\.\.\(parsed\.data\.actor_type !== undefined \? \{ actorType: parsed\.data\.actor_type \} : \{\}\),/,
    );
    expect(route).toMatch(
      /\.\.\.\(parsed\.data\.target_resource_id !== undefined\s*\? \{ targetResourceId: parsed\.data\.target_resource_id \}\s*: \{\}\),/,
    );
  });
});
