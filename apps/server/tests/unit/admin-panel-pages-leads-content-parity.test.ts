// W487.A — drift guard for apps/admin-panel/src/pages/leads.astro.
// Lead capture isn't wired yet (no /v1/admin/leads route, no leads table).
// The page previously SSG-rendered fabricated MOCK_LEADS rows with dead
// /leads/{id} links + dead #convert / #archive anchors (no handlers, no
// backend), presenting fake records as real ops data. It is now an honest
// "coming soon" empty state. Drift here either re-introduces the fabricated
// mock rows / dead action links, or invents an unimplemented backend.
//
//   • Honest header + subhead (no claim that conversion/archive works).
//   • "Coming soon" empty-state card explaining there's no backend yet.
//   • NO MOCK_LEADS import / render.
//   • NO dead action links (/leads/{id}, #convert-, #archive-, mailto:).
//   • NO unimplemented audit-log "Conversion creates an account row…" claim.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W487.A apps/admin-panel/src/pages/leads.astro content parity', () => {
  const body = read(LIB);

  it("Page-header framing: 'Leads' h1 (oxblood gradient) + honest subhead that the surface 'will appear here once lead capture is wired' (no longer claims active convert/archive) — pinned so the header doesn't promise functionality the backend doesn't have", () => {
    expect(body).toMatch(/<h1 class="text-3xl font-semibold tracking-tight text-tk-ink">/);
    expect(body).toMatch(/>Leads</);
    expect(body).toMatch(
      /Pre-signup interest captured from the marketing site, docs, and inbound\s*\n?\s*email will appear here once lead capture is wired\./,
    );
  });

  it("'Coming soon' empty-state card: explains lead capture isn't wired yet (no backend route for leads) so operators don't mistake an empty surface for a broken one — pinned so the page stays an honest not-yet-built state rather than fabricated demo rows", () => {
    expect(body).toMatch(
      /<h2 class="text-lg font-semibold tracking-tight text-tk-ink">Coming soon<\/h2>/,
    );
    expect(body).toMatch(
      /Lead capture isn't wired yet — there's no backend route for leads\. Once\s*\n?\s*the marketing site captures signup intent, leads will land here for\s*\n?\s*sales follow-up\./,
    );
  });

  it('NO fabricated mock rows: leads.astro must NOT import or render MOCK_LEADS — pinned so the page never SSG-renders fake leads (with real-looking capture dates + emails) into the prod artifact', () => {
    expect(body).not.toMatch(/MOCK_LEADS/);
    expect(body).not.toMatch(/from '\.\.\/data\/mocks/);
  });

  it('NO dead action links: no /leads/{id} detail link (no leads/[id].astro exists), no #convert- / #archive- fragment anchors (no handlers), no mailto: per-row action — pinned so the page never ships affordances that go nowhere', () => {
    expect(body).not.toMatch(/href=\{`\/leads\//);
    expect(body).not.toMatch(/#convert-/);
    expect(body).not.toMatch(/#archive-/);
    expect(body).not.toMatch(/mailto:/);
  });

  it("NO unimplemented backend claim: the footnote 'Conversion creates an account row + sends a magic-link signup email…' is gone (it described functionality that doesn't exist) — pinned so the page doesn't document a non-existent feature as if it were live", () => {
    expect(body).not.toMatch(/Conversion creates an account row/);
    expect(body).not.toMatch(/sends a magic-link signup email/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
