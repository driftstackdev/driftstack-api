// W219.A — drift-guard between /docs/teams and the actual team
// routes. The previous revision claimed paths under /v1/teams/ (the
// real ones are under /v1/team/), an invite-id-in-path accept
// endpoint, and a 201 response shape that the real route doesn't
// return — all enough to send integrators into 404s.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'teams.astro');
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'team.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W219.A teams doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('all endpoints in doc use the singular /v1/team/ prefix', () => {
    // The route registrations are under /v1/team/, never /v1/teams/.
    const stalePathHits = doc.match(/\/v1\/teams\b/g);
    expect(stalePathHits).toBeNull();
    for (const path of [
      '/v1/team/invites',
      '/v1/team/invites/accept',
      '/v1/team/members',
      '/v1/team/owners',
    ]) {
      expect(route, `route should be registered at ${path}`).toContain(`'${path}'`);
      expect(doc, `doc must reference ${path}`).toContain(path);
    }
  });

  it('POST /v1/team/invites/accept takes a token in the body, no id in the path', () => {
    // Confirm the doc shows the token shape and doesn't show the
    // stale id-in-path pattern.
    expect(doc).toMatch(/POST \/v1\/team\/invites\/accept[\s\S]*?"token":/);
    expect(doc).not.toMatch(/\/v1\/team\/invites\/inv_[^/]+\/accept/);
    expect(doc).not.toMatch(/\/v1\/teams\/invites\/[^/]+\/accept/);
  });

  it('DELETE /v1/team/members/:id uses the membership id (mem_), not an account id', () => {
    expect(route).toMatch(/'\/v1\/team\/members\/:id'/);
    expect(doc).toMatch(/DELETE \/v1\/team\/members\/mem_/);
    expect(doc).not.toMatch(/DELETE \/v1\/team\/members\/acc_/);
  });

  it('list responses use the standard {data: [...]} envelope', () => {
    expect(doc).toMatch(/"data":\s*\[/);
    // The stale list envelope the previous doc used:
    expect(doc).not.toMatch(/"members":\s*\[/);
  });

  it('POST /v1/team/invites response is the 202 ack, not the full invite row', () => {
    expect(doc).toMatch(/→ 202 Accepted/);
    expect(doc).not.toMatch(/POST \/v1\/team\/invites[^"]*?\n.*?→ 201/);
  });

  it('doc does not claim a delete-invite endpoint that does not exist', () => {
    // No DELETE /v1/team/invites/... is registered.
    expect(route).not.toMatch(/'\/v1\/team\/invites\/:id'/);
    expect(doc).not.toMatch(/DELETE \/v1\/team(?:s)?\/invites/);
  });

  it('audit-log cross-link uses /v1/account/audit-log, not the stale /v1/account/audit', () => {
    expect(doc).toMatch(/\/v1\/account\/audit-log/);
    expect(doc).not.toMatch(/\/v1\/account\/audit(?!-log)/);
  });
});
