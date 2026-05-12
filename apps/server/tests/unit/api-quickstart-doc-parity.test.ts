// W213.D — drift-guard parity test for /docs/api-quickstart.
//
// The quickstart is the most-read entry point for new integrators.
// When example shapes drift from the server (request bodies, response
// envelopes, id prefixes), every reader who paste-runs the curl
// hits 400/404 and bounces. Pin the doc to source-of-truth.
//
// Source files this test guards:
//   - apps/server/src/routes/sessions.ts (publicSession shape +
//     capture response shape + 'ses' id prefix)
//   - packages/api-types/src/sessions.ts (CreateSessionRequestSchema
//     fields)
//   - apps/server/src/routes/account-me.ts (flat response, no
//     "account" envelope)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreateSessionRequestSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'api-quickstart.astro',
);
const SESSIONS_ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'sessions.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W213.D api-quickstart doc parity', () => {
  const doc = read(DOC_PATH);

  it('session id prefix in examples is ses_, not the stale sess_', () => {
    expect(read(SESSIONS_ROUTE_PATH)).toMatch(/uuidFromPrefixedId\(request\.params\.id, 'ses'\)/);
    expect(doc).toMatch(/"id":\s*"ses_/);
    // The whole doc must not contain the stale `sess_` prefix
    // anywhere — fail fast if it crept back in.
    expect(doc).not.toMatch(/\bsess_/);
  });

  it('GET /v1/account/me example is a flat object (no "account" envelope)', () => {
    // Search for the account/me curl section + its arrow output.
    // The flat shape is identified by "id": "acc_…" appearing as the
    // first key in the response, not nested inside an "account" key.
    const slice = doc.split('/v1/account/me')[1] ?? '';
    expect(slice).not.toMatch(/"account":\s*\{/);
    // And the doc should not contain the wrapped pattern at all
    // (the old version was the only place that used it).
    expect(doc).not.toMatch(/"account":\s*\{\s*"id":\s*"acc_/);
  });

  it('POST /v1/sessions body uses archetype/purpose, not target_url/profile_archetype', () => {
    const shape = CreateSessionRequestSchema.shape;
    // Real fields the schema accepts:
    expect(shape).toHaveProperty('archetype');
    expect(shape).toHaveProperty('purpose');
    expect(shape).toHaveProperty('label');
    expect(shape).toHaveProperty('metadata');
    // The schema MUST NOT have these — fail if someone adds them
    // back without also updating the doc.
    expect(shape).not.toHaveProperty('target_url');
    expect(shape).not.toHaveProperty('profile_archetype');
    // The doc example MUST NOT use the stale fields.
    expect(doc).not.toMatch(/"target_url":/);
    expect(doc).not.toMatch(/"profile_archetype":/);
    // The doc example MUST use the real fields:
    expect(doc).toMatch(/"archetype":/);
    expect(doc).toMatch(/"purpose":/);
  });

  it('POST /v1/sessions response is flat (no "session" envelope) and exposes the real fields', () => {
    // The actual publicSession returns a flat record. The old doc
    // wrapped it in `{ "session": { … } }`.
    expect(doc).not.toMatch(/"session":\s*\{\s*"id":\s*"ses_/);
    // Confirm the real field names appear in at least one example:
    expect(doc).toMatch(/"account_id":\s*"acc_/);
    expect(doc).toMatch(/"api_key_id":\s*"key_/);
  });

  it('capture response shape mentions encoding + byte_size, not the fictional cap_id/url', () => {
    expect(read(SESSIONS_ROUTE_PATH)).toMatch(/encoding: result\.encoding/);
    expect(read(SESSIONS_ROUTE_PATH)).toMatch(/byte_size: result\.byteSize/);
    expect(doc).toMatch(/"encoding":/);
    expect(doc).toMatch(/"byte_size":/);
    // Rule out the stale shape:
    expect(doc).not.toMatch(/"cap_/);
    expect(doc).not.toMatch(/r2-.*sig=/);
  });

  it('navigate is mentioned as the way to send a session to a URL', () => {
    expect(doc).toMatch(/\/v1\/sessions\/.*\/navigate/);
  });
});
