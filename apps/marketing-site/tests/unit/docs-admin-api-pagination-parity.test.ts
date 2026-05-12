// W355.A — drift guard for /docs/admin-api-pagination. The
// V-717 reference for cursor pagination on the admin surface.
// V-666.AM introduced the convention on /v1/admin/crypto-orders;
// this page is the canonical contract description.
//
// Pinned:
//   • limit default 50, max 200 on /v1/admin/crypto-orders — both
//     ↔ the server-side Zod schema + error message in
//     admin-crypto-orders.ts (the page advertises both numbers).
//   • Response envelope (orders + next_cursor) matches what the
//     server returns.
//   • next_cursor=null sentinel on end-of-walk pinned.
//   • Cursor opacity claim: "Do not try to parse it."
//   • 512-character cursor cap → 400 Bad Request.
//   • Malformed-cursor → empty page (benign decode-failure
//     posture).
//   • Filter composition: status / search / account_id all named.
//   • Cross-links to /docs/admin-api + /docs/admin-csv-export +
//     /docs/api-changelog resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-api-pagination.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W355.A /docs/admin-api-pagination parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('default limit=50, max=200 on /v1/admin/crypto-orders matches the server (Zod + error message)', () => {
    expect(body).toMatch(/default <code>limit=50<\/code>/);
    expect(body).toMatch(/max\s*<code>200<\/code>/);
    // Server's narrowed error message uses "between 1 and 200" — pin
    // both directions so a bump on either side requires the other to
    // update.
    expect(route).toMatch(/limit must be an integer between 1 and 200/);
  });

  it('response envelope (orders + next_cursor) shape pinned', () => {
    expect(body).toMatch(/<code>orders<\/code>/);
    expect(body).toMatch(/<code>next_cursor<\/code>/);
    expect(body).toMatch(/<code>null<\/code>\s*when the page\s*reaches the end of the list/);
  });

  it("cursor opacity claim pinned ('treat as opaque bytes')", () => {
    expect(body).toMatch(/Do not\s*try to parse the cursor/);
    expect(body).toMatch(/Treat it as\s*opaque bytes/);
  });

  it('512-character cursor cap returns 400', () => {
    expect(body).toMatch(
      /longer than 512 characters returns[\s\S]{0,100}<code>400 Bad Request<\/code>/,
    );
  });

  it('malformed cursor returns an empty page with next_cursor: null (benign decode-failure)', () => {
    expect(body).toMatch(
      /malformed cursor[\s\S]{0,200}empty page with\s*<code>next_cursor: null<\/code>/,
    );
    expect(body).toMatch(/prefers a benign\s*empty result/);
  });

  it('filter composition (status + search + account_id) named on the page', () => {
    for (const filter of ['status', 'search', 'account_id']) {
      expect(body).toContain(`<code>${filter}</code>`);
    }
  });

  it('"changing a filter mid-walk is undefined; start a fresh walk" posture pinned', () => {
    expect(body).toMatch(/Changing a filter mid-walk is undefined/);
    expect(body).toMatch(/start a fresh walk \(drop the cursor\)/);
  });

  it('walk-loop snippet uses /v1/admin/crypto-orders + limit=50', () => {
    expect(body).toContain('/v1/admin/crypto-orders');
    expect(body).toMatch(/limit:\s*['"]50['"]/);
  });

  it("'assume an endpoint does NOT paginate until its docs list next_cursor' rollout posture pinned", () => {
    expect(body).toMatch(
      /assume an\s*endpoint does NOT paginate until its documentation lists the\s*field/,
    );
  });

  it('cross-links to /docs/admin-api + /docs/admin-csv-export + /docs/api-changelog resolve', () => {
    expect(body).toContain('/docs/admin-api');
    expect(body).toContain('/docs/admin-csv-export');
    expect(body).toContain('/docs/api-changelog');
    for (const path of [
      'apps/marketing-site/src/pages/docs/admin-api.astro',
      'apps/marketing-site/src/pages/docs/admin-csv-export.astro',
      'apps/marketing-site/src/pages/docs/api-changelog.astro',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `missing file: ${path}`).toBe(true);
    }
  });
});
