// W227.A — drift-guard for /docs/migration-from-puppeteer. The
// previous revision claimed body fields (`profile_id`, `record`) and
// SDK methods (`client.sessions.state`, `navigate(id, urlString)`)
// that don't exist. An integrator copying the curl examples would
// hit 400s on every body.

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
  'migration-from-puppeteer.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W227.A migration-from-puppeteer doc parity', () => {
  const doc = read(DOC_PATH);

  it('session-create example uses schema-accepted fields', () => {
    const shape = CreateSessionRequestSchema.shape;
    expect(shape).toHaveProperty('archetype');
    expect(shape).not.toHaveProperty('profile_id');
    expect(shape).not.toHaveProperty('record');
    // Doc body must use the real fields:
    expect(doc).toMatch(/"archetype":\s*"default"/);
    // And not the stale ones:
    expect(doc).not.toMatch(/"profile_id":/);
    expect(doc).not.toMatch(/"record":\s*true/);
  });

  it('state-fetch example uses GET /v1/sessions/:id/state', () => {
    expect(doc).toMatch(/GET \/v1\/sessions\/ses_/);
    // Old wording showed POST for the same path.
    expect(doc).not.toMatch(/POST \/v1\/sessions\/ses_[^/]+\/state/);
  });

  it('SDK example uses real method names + signatures', () => {
    // navigate takes a body object, not a URL string.
    expect(doc).toMatch(/sessions\.navigate\(session\.id, \{ url:/);
    expect(doc).not.toMatch(/sessions\.navigate\(session\.id, '/);
    // getState is the real method, not state.
    expect(doc).toMatch(/sessions\.getState\(/);
    expect(doc).not.toMatch(/sessions\.state\(/);
    // Create body uses archetype, not profileId.
    expect(doc).toMatch(/archetype:\s*'default'/);
    expect(doc).not.toMatch(/profileId:/);
  });

  it('does not document the fictional GET /v1/sessions/:id/recording', () => {
    expect(doc).not.toMatch(/\/v1\/sessions\/ses_[^/]+\/recording/);
    // Concept-table cell should now point to the roadmap doc.
    expect(doc).toMatch(/\/docs\/recordings/);
  });
});
