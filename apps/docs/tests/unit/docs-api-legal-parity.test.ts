// W257.B — drift-guard for docs.driftstack.io/api/legal. Pins:
// 1. /v1/legal/* endpoints documented = endpoints registered.
// 2. document_key values match the live catalog ('tos' not 'terms').
// 3. Returned acceptance id uses `lacc_` prefix (route serialiser).
// 4. Source-of-truth file paths in "Source of truth" section exist on disk.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/legal.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts');
const CATALOG = resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W257.B docs/api/legal ↔ /v1/legal/* parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const catalog = read(CATALOG);

  it('every /v1/legal/* endpoint is documented + registered', () => {
    for (const path of ['/v1/legal/documents', '/v1/legal/required', '/v1/legal/accept']) {
      expect(doc).toContain(path);
      expect(route).toContain(`'${path}'`);
    }
  });

  it('document_key uses the live key set (tos / privacy / dpa / aup)', () => {
    // The live catalog declares these four keys.
    for (const key of ['tos', 'privacy', 'dpa', 'aup']) {
      expect(catalog).toMatch(new RegExp(`['"]${key}['"]`));
    }
    // The doc must use 'tos' not the legacy 'terms'.
    expect(doc).not.toMatch(/"document_key":\s*"terms"/);
    expect(doc).toMatch(/"document_key":\s*"tos"/);
  });

  it('acceptance id uses the lacc_ prefix per route serialiser', () => {
    expect(route).toMatch(/prefixId\(['"]lacc['"]/);
    expect(doc).toMatch(/"id":\s*"lacc_/);
  });

  it('Source of truth file paths exist on disk', () => {
    // Pull every `apps/server/...` path from the doc and assert it exists.
    const paths = [...doc.matchAll(/`(apps\/server\/[\w./-]+\.ts)`/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !existsSync(resolve(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('content-hash mismatch returns 409 with current_version + current_content_hash', () => {
    expect(doc).toMatch(/409 conflict/i);
    expect(doc).toMatch(/current_version/);
    expect(doc).toMatch(/current_content_hash/);
  });
});
