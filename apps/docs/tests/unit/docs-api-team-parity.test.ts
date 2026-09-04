// W255.B — drift-guard for docs.driftstack.io/api/team. Pins the
// 5 team endpoints + the role enum + the X-Driftstack-Account
// pattern to the live server source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/team.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W255.B docs/api/team ↔ /v1/team/* parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);

  it('all 5 documented team endpoints are registered', () => {
    for (const path of [
      '/v1/team/invites',
      '/v1/team/invites/accept',
      '/v1/team/members',
      '/v1/team/owners',
      '/v1/team/members/:id',
    ]) {
      expect(route).toContain(`'${path}'`);
      // Doc cites the same path (allow the `:id` rendering with
      // or without backticks).
      const docPath = path.replace(/:id/, ':[a-z_]+');
      const re = new RegExp(docPath.replace(/\//g, '\\/'));
      expect(doc, `doc missing ${path}`).toMatch(re);
    }
  });

  it('role enum is member / admin', () => {
    expect(doc).toMatch(/`member`/);
    expect(doc).toMatch(/`admin`/);
  });

  it('X-Driftstack-Account header is the team-scoping mechanism', () => {
    expect(doc).toMatch(/X-Driftstack-Account/);
  });

  it('membership ids use the mem_ prefix family or `:id` placeholder', () => {
    // The doc may use either; pin that the live route param is :id.
    expect(route).toMatch(/'\/v1\/team\/members\/:id'/);
  });

  it('invite tokens are sha256-hashed at rest with 7-day expiry', () => {
    expect(doc).toMatch(/Token-hashed at\s+rest \(sha256\), 7-day expiry/);
  });
});
