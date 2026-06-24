// W380.A — drift guard for admin-panel /leads.astro page content.
// Lead capture isn't wired yet (no /v1/admin/leads route, no leads
// table). The page previously SSG-rendered fabricated demo lead rows
// with dead /leads/{id} links + dead #convert / #archive anchors (no
// handlers, no backend), presenting fake records as real ops data. It
// is now an honest "coming soon" empty state. This guard pins:
//
//   • NO fabricated demo rows: no MOCK_LEADS import/render.
//   • NO dead action links (/leads/{id}, #convert-, #archive-, mailto:).
//   • NO unimplemented-backend claim ("Conversion creates an account
//     row + sends a magic-link signup email").
//   • Honest header + "coming soon" empty-state card explaining the
//     surface isn't wired yet.
//   • Uses AdminLayout title="Leads".

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W380.A admin-panel /leads.astro page content parity', () => {
  const body = read(PAGE);

  it('uses AdminLayout title="Leads"', () => {
    expect(body).toMatch(/import AdminLayout from '\.\.\/layouts\/AdminLayout\.astro';/);
    expect(body).toMatch(/<AdminLayout title="Leads">/);
  });

  it('does NOT import or render demo lead fixtures (no fabricated rows in the prod artifact)', () => {
    expect(body).not.toMatch(/MOCK_LEADS/);
    expect(body).not.toMatch(/from '\.\.\/data\/mocks/);
  });

  it('honest header + hero subtitle (no claim that convert/archive works today)', () => {
    expect(body).toMatch(/<h1 class="text-3xl font-semibold tracking-tight text-tk-ink">/);
    expect(body).toMatch(/>Leads</);
    expect(body).toMatch(
      /Pre-signup interest captured from the marketing site, docs, and inbound\s+email will appear here once lead capture is wired\./,
    );
  });

  it('"Coming soon" empty-state card explains lead capture isn\'t wired yet (no backend route)', () => {
    expect(body).toMatch(
      /<h2 class="text-lg font-semibold tracking-tight text-tk-ink">Coming soon<\/h2>/,
    );
    expect(body).toMatch(
      /Lead capture isn't wired yet — there's no backend route for leads\. Once\s+the marketing site captures signup intent, leads will land here for\s+sales follow-up\./,
    );
  });

  it('no dead action links: no /leads/{id} detail link, no #convert- / #archive- anchors, no mailto: per-row action', () => {
    expect(body).not.toMatch(/href=\{`\/leads\//);
    expect(body).not.toMatch(/#convert-/);
    expect(body).not.toMatch(/#archive-/);
    expect(body).not.toMatch(/mailto:/);
  });

  it('no unimplemented-backend claim in the footer (magic-link signup / "Conversion creates an account row")', () => {
    expect(body).not.toMatch(/Conversion creates an account row/);
    expect(body).not.toMatch(/sends a magic-link signup email/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });
});
