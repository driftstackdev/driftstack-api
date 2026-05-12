// W215.C — drift-guard between /docs/sessions and the actual
// sessions surface. The previous /docs/sessions page included
// extensive fictional content: nonexistent endpoints
// (GET /v1/sessions/:id/recording), nonexistent body fields
// (`target_url`, `profile_archetype`, `profile_id`, `record`),
// nonexistent status values (`running`, `completed`, `failed`), a
// nonexistent response envelope (`{ "session": { … } }`), and an
// incorrect pagination response shape (`{sessions, nextCursor}`).
//
// Source-of-truth files this test pins to:
//   - apps/server/src/routes/sessions.ts  (publicSession + routes)
//   - packages/api-types/src/sessions.ts  (CreateSessionRequestSchema)
//   - packages/api-types/src/common.ts    (PaginationQuerySchema)
//   - apps/server/src/db/schema.ts         (session_status enum)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreateSessionRequestSchema, PaginationQuerySchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'sessions.astro');
const ROUTES_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'sessions.ts');
const SCHEMA_PATH = join(REPO, 'apps', 'server', 'src', 'db', 'schema.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W215.C sessions doc parity', () => {
  const doc = read(DOC_PATH);

  it('lifecycle table matches the session_status enum', () => {
    const schema = read(SCHEMA_PATH);
    const block = schema.split("pgEnum('session_status', [")[1]!.split(']')[0]!;
    const enumValues = Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
    for (const v of enumValues) {
      expect(doc, `lifecycle table missing ${v}`).toContain(v);
    }
    // Stale lifecycle states the previous doc claimed:
    for (const stale of ['queued', 'starting', 'completed', 'failed']) {
      expect(doc, `doc must not reference stale status ${stale}`).not.toMatch(
        new RegExp(`"status":\\s*"${stale}"`),
      );
    }
  });

  it('POST /v1/sessions request body uses only schema-accepted fields', () => {
    const shape = CreateSessionRequestSchema.shape;
    for (const field of Object.keys(shape)) {
      expect(doc, `request example missing field ${field}`).toContain(`"${field}":`);
    }
    for (const stale of ['target_url', 'profile_archetype', 'profile_id', 'record']) {
      expect(doc, `request body must not reference stale field ${stale}`).not.toMatch(
        new RegExp(`"${stale}":`),
      );
      expect(shape).not.toHaveProperty(stale);
    }
  });

  it('response examples are flat — no { "session": { … } } envelope', () => {
    expect(doc).not.toMatch(/"session":\s*\{[^}]*"id":\s*"ses/);
    expect(doc).not.toMatch(/"session":\s*\{[^}]*"id":\s*"sess/);
  });

  it('list response shape matches PaginationListSchema (data / has_more / next_cursor)', () => {
    expect(doc).toMatch(/"data":/);
    expect(doc).toMatch(/"has_more":/);
    expect(doc).toMatch(/"next_cursor":/);
    // Rule out the stale envelope:
    expect(doc).not.toMatch(/"sessions":\s*\[/);
    expect(doc).not.toMatch(/"nextCursor":/);
  });

  it('default and max page sizes match PaginationQuerySchema', () => {
    // Source-of-truth: limit default 50, max 100.
    expect(PaginationQuerySchema.shape.limit).toBeDefined();
    expect(doc).toMatch(/Default page size is <strong>50<\/strong>/);
    expect(doc).toMatch(/max\s+<strong>100<\/strong>/);
  });

  it('session id prefix in examples is ses_, not the stale sess_', () => {
    expect(read(ROUTES_PATH)).toMatch(/uuidFromPrefixedId\(request\.params\.id, 'ses'\)/);
    expect(doc).toMatch(/"id":\s*"ses_/);
    expect(doc).not.toMatch(/\bsess_/);
  });

  it('doc does not reference the fictional GET /v1/sessions/:id/recording endpoint', () => {
    // The server registers no /recording route under /v1/sessions.
    expect(read(ROUTES_PATH)).not.toMatch(/'\/v1\/sessions\/[^']*\/recording/);
    expect(doc).not.toMatch(/\/v1\/sessions\/[^\s"]*\/recording/);
    expect(doc).not.toMatch(/"playback_url":/);
  });

  it('capture response example matches the real shape', () => {
    expect(read(ROUTES_PATH)).toMatch(/byte_size: result\.byteSize/);
    expect(doc).toMatch(/"byte_size":/);
    expect(doc).toMatch(/"encoding":/);
  });

  it('concurrency-limit response is 429, not 409', () => {
    // Documented in /docs/concurrency; pin the sessions doc not to
    // contradict.
    expect(doc).toMatch(/429/);
    expect(doc).not.toMatch(/409 Conflict/);
  });
});
