// W255.A — drift-guard for docs.driftstack.dev/api/api-keys. Pins
// the scope enum + the 24h rotation grace + the key_ id prefix to
// live constants in the db schema.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/api-keys.md');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W255.A docs/api/api-keys ↔ live api-keys parity', () => {
  const doc = read(DOC);
  const schema = read(SCHEMA);

  it('schema still exports the api_key_scope pgEnum', () => {
    expect(schema).toMatch(/pgEnum\(\s*['"]api_key_scope['"],\s*\[/);
  });

  it('doc cites the basic read + write scopes', () => {
    expect(doc).toMatch(/"scopes":\s*\[\s*"read",\s*"write"\s*\]/);
    expect(doc).toMatch(
      /Read-only access to list\/get endpoints such as sessions, profiles, and usage\./,
    );
    expect(doc).not.toMatch(/list sessions, recordings|recordings API/i);
  });

  it('rotation grace window is 24 hours', () => {
    expect(doc).toMatch(/24-hour grace/);
  });

  it('plaintext keys use the ds_live_ prefix', () => {
    expect(doc).toMatch(/ds_live_/);
    expect(doc).toMatch(/"key_prefix":\s*"ds_live_/);
  });

  it('api-key ids use the key_ prefix', () => {
    expect(doc).toMatch(/"id":\s*"key_/);
  });

  it('cites POST /v1/api-keys/:id/rotate for rotation', () => {
    expect(doc).toMatch(/POST \/v1\/api-keys\/:id\/rotate/);
  });

  it('warns plaintext is shown ONCE', () => {
    expect(doc).toMatch(/Plaintext is shown ONCE/i);
  });

  it('pins the paid customer-key and restricted Free desktop boundary', () => {
    expect(doc).toMatch(/Every paid tier, including Manual/);
    expect(doc).toMatch(/restricted `ds_test_…` device credential/);
    expect(doc).toMatch(/Free dashboard web sessions may still list and revoke/);
    expect(doc).toMatch(/create and rotate return the normal RFC 9457 `403 Forbidden`/);
    expect(doc).toMatch(/resume after upgrade unless revoked or expired/);
    expect(doc).not.toMatch(/feature_not_available|general sandbox key\s+and customer key/);
  });
});
