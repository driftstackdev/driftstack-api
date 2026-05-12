// W217.B — drift-guard between /docs/api-keys and the
// api_key_scope Postgres enum + actual server behavior. The
// previous revision listed a fictional `read:recordings` scope and
// referenced a fictional `X-Api-Key-Id` response header. Both
// would mislead integrators (the scope wouldn't validate against
// the enum; the header doesn't exist).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'api-keys.astro');
const SCHEMA_PATH = join(REPO, 'apps', 'server', 'src', 'db', 'schema.ts');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function enumScopes(): string[] {
  const schema = read(SCHEMA_PATH);
  const block = schema.split("pgEnum('api_key_scope', [")[1]!.split(']')[0]!;
  return Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
}

function docScopes(): string[] {
  const doc = read(DOC_PATH);
  return Array.from(doc.matchAll(/\{ name: '([^']+)',/g)).map((m) => m[1]!);
}

describe('W217.B api-keys doc parity', () => {
  const doc = read(DOC_PATH);

  it('every scope listed in /docs/api-keys exists in the api_key_scope enum', () => {
    const allowed = new Set(enumScopes());
    const listed = docScopes();
    expect(listed.length, 'doc must list at least one scope').toBeGreaterThan(0);
    const offenders = listed.filter((s) => !allowed.has(s));
    expect(offenders, `scopes not in enum: ${offenders.join(', ')}`).toEqual([]);
  });

  it('doc does not list the fictional read:recordings scope', () => {
    expect(docScopes()).not.toContain('read:recordings');
  });

  it('doc does not reference the nonexistent X-Api-Key-Id response header', () => {
    function grepDir(dir: string): boolean {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (grepDir(p)) return true;
        } else if (entry.name.endsWith('.ts')) {
          if (/['"]x-api-key-id['"]/i.test(readFileSync(p, 'utf8'))) return true;
        }
      }
      return false;
    }
    const headerExists = grepDir(SERVER_SRC);
    expect(headerExists).toBe(false);
    expect(doc).not.toMatch(/X-Api-Key-Id/);
  });

  it('granular scopes table includes every customer-facing verb:resource scope from the enum', () => {
    const customerVisible = enumScopes().filter((s) => s.includes(':'));
    const listed = new Set(docScopes());
    const missing = customerVisible.filter((s) => !listed.has(s));
    expect(missing, `granular scope table is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
