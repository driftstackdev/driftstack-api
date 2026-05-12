// W303.B — drift guard for docs/reference/scopes.md coverage. The
// reference page must enumerate every member of ApiKeyScopeSchema.
// Pairs with W265.A (which already covers individual scope
// citations); this one asserts complete coverage and that no
// fictional scopes leak in.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W303.B docs/reference/scopes.md ↔ ApiKeyScopeSchema full coverage', () => {
  const doc = read(DOC);
  const liveScopes = ApiKeyScopeSchema.options;

  it('reference page mentions every ApiKeyScope', () => {
    const missing: string[] = [];
    for (const s of liveScopes) {
      // Doc cites scopes inside backticks in the scope-list table.
      if (!new RegExp(`\`${s}\``).test(doc)) {
        missing.push(s);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every cited verb:resource scope is in the schema', () => {
    const cited = [...doc.matchAll(/`((?:read|write|admin):[a-z][a-z-]+)`/g)].map((m) => m[1]!);
    const liveSet = new Set(liveScopes);
    const offenders = cited.filter((s) => !liveSet.has(s as never));
    expect(offenders).toEqual([]);
  });
});
