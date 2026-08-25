// Drift guard for packages/sdk-python/src/driftstack/resources/
// profile_snapshots.py. Pins the V-312 framing + the 7-method
// surface (capture/list_for_profile/list/iterate/get/restore/delete)
// + sync/async mirror + the iterate() pagination helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/profile_snapshots.py',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-python resources/profile_snapshots content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('Module-level docstring V-312 framing pinned: immutable point-in-time copies. Drift to dropping V-312 would orphan the engineering history; drift to claiming snapshots ARE mutable would break the load-bearing immutability contract pinned by slice 161 docs', () => {
    expect(body).toMatch(
      /Profile snapshots resource — \/v1\/profiles\/:id\/snapshots \+\s*\/v1\/profile-snapshots \(V-312\)/,
    );
    expect(body).toMatch(/Immutable point-in-time copies of\s*saved profiles\./);
  });

  it('Pydantic-models-TODO framing pinned: dict[str, Any] pending scripts/generate.sh regeneration. Drift to dropping the TODO would let the next reader miss that this resource is on the list for typed-model upgrades', () => {
    expect(body).toMatch(/Type annotations on request\/response bodies use ``dict\[str, Any\]``/);
    expect(body).toMatch(/pending the next ``scripts\/generate\.sh`` regeneration pass/);
  });

  it('Sync ProfileSnapshotsResource 7-method surface pinned: capture/list_for_profile/list/iterate/get/restore/delete. Drift to dropping the across-account list() would force customers to iterate profiles to enumerate snapshots (matches slice 161 docs framing)', () => {
    expect(body).toMatch(/class ProfileSnapshotsResource:/);
    expect(body).toMatch(/def capture\(self, profile_id: str, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/def list_for_profile\(/);
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\)/,
    );
    expect(body).toMatch(/def iterate\(self, \*, limit: int \| None = None\) -> Iterator/);
    expect(body).toMatch(/def get\(self, snapshot_id: str\)/);
    expect(body).toMatch(/def restore\(self, snapshot_id: str, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/def delete\(self, snapshot_id: str\) -> None:/);
  });

  it('Async AsyncProfileSnapshotsResource mirror pinned: same 7-method surface. Drift would break FastAPI/asyncio consumers OR break the sync/async parity contract', () => {
    expect(body).toMatch(/class AsyncProfileSnapshotsResource:/);
    expect(body).toMatch(/async def capture\(/);
    expect(body).toMatch(/async def list_for_profile\(/);
    expect(body).toMatch(/async def list\(/);
    expect(body).toMatch(/def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator/);
    expect(body).toMatch(/async def get\(/);
    expect(body).toMatch(/async def restore\(/);
    expect(body).toMatch(/async def delete\(/);
  });

  it('iterate() consumes the shared pagination helper pinned: iterate_paginated (sync) + aiterate_paginated (async). Drift to a hand-rolled cursor loop would diverge from the cross-resource pagination contract', () => {
    expect(body).toMatch(
      /from driftstack\.pagination import aiterate_paginated, iterate_paginated/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
    expect(body).toMatch(/return aiterate_paginated\(fetch_page\)/);
  });

  it("restore() docstring tier-cap + name-conflict warning pinned: 'Tier-cap + name-conflict checked.' Drift to dropping the warning would mislead customers about why a restore would fail (matches the slice 161 'restore-counts-against-tier-cap' framing)", () => {
    expect(body).toMatch(/Restore into a new profile\. Tier-cap \+ name-conflict checked\./);
  });

  it("URL-encoded path-segment pattern pinned: quote(snapshot_id, safe='') + quote(profile_id, safe=''). Drift to dropping the URL-encoding would break customers whose snapshot ids contain reserved URI chars (rare but real)", () => {
    expect(body).toMatch(/quote\(snapshot_id, safe=''\)/);
    expect(body).toMatch(/quote\(profile_id, safe=''\)/);
  });
});
