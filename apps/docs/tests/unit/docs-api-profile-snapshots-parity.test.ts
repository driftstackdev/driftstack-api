// W256.C — drift-guard for docs.driftstack.io/api/profile-snapshots.
// Previous revision rendered snapshot ids as `snap_<uuid>` but the
// live server emits `psnap_<uuid>`. Pin the prefix + endpoints.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profile-snapshots.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W256.C docs/api/profile-snapshots ↔ live snapshot route parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);

  it('snapshot ids use the psnap_ prefix, not the legacy snap_', () => {
    // Live server emits `psnap_<id>` (see route serialiser).
    expect(route).toMatch(/`psnap_\$\{[^}]+\}`/);
    // Doc must match.
    expect(doc).toMatch(/"id":\s*"psnap_/);
    expect(doc).not.toMatch(/"id":\s*"snap_<uuid>"/);
  });

  it('POST /v1/profiles/:id/snapshots is the documented capture endpoint', () => {
    expect(doc).toMatch(/POST \/v1\/profiles\/:id\/snapshots/);
    expect(route).toContain(`'/v1/profiles/:id/snapshots'`);
  });

  it('cross-account list endpoint /v1/profile-snapshots is registered', () => {
    expect(route).toContain(`'/v1/profile-snapshots'`);
  });
});
