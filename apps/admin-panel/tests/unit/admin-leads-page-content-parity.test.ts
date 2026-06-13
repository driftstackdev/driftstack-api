// W380.A — drift guard for admin-panel /leads.astro page content.
// Existing admin-leads-deferred-state-parity + leads-page-source-
// taxonomy-parity cover the deferred-state machinery + the source
// enum derivation. This guard pins the load-bearing page-content
// claims a sales-ops admin user anchors on:
//
//   • MOCK_LEADS-driven (pre-shipping deferred state — until the
//     lead-capture endpoint lands, the page renders mock fixtures).
//   • 4 SOURCE_BADGE color rows (pricing_cta=oxblood, docs_signup
//     =blue, email_inbound=emerald, other=slate).
//   • 4 SOURCE_LABEL strings ("Pricing CTA" / "Docs signup" /
//     "Email inbound" / "Other").
//   • Hero copy: "Pre-signup interest captured from the marketing
//     site, docs, and inbound email."
//   • Filter bar: email/notes search + 4-option source select.
//   • Empty-state UX present (No leads yet + "Once the marketing
//     site captures signup intent" framing).
//   • 3 lead-row actions: Convert to account / Archive / Email
//     reply (mailto).
//   • Footer claim: "Conversion creates an account row + sends a
//     magic-link signup email" + audit-logged.
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

  it('imports MOCK_LEADS from local data source (pre-shipping deferred-state)', () => {
    expect(body).toMatch(/import \{ MOCK_LEADS \} from '\.\.\/data\/mocks\.ts';/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts'))).toBe(true);
  });

  it('4 SOURCE_BADGE color rows pinned (pricing_cta=oxblood / docs_signup=blue / email_inbound=emerald / other=slate)', () => {
    expect(body).toMatch(/pricing_cta: 'bg-tk-accent\/10 text-tk-accent'/);
    expect(body).toMatch(/docs_signup: 'bg-blue-50 text-blue-700'/);
    expect(body).toMatch(/email_inbound: 'bg-emerald-50 text-emerald-700'/);
    expect(body).toMatch(/other: 'bg-tk-hover text-tk-ink-2'/);
  });

  it('4 SOURCE_LABEL strings pinned ("Pricing CTA" / "Docs signup" / "Email inbound" / "Other")', () => {
    expect(body).toMatch(/pricing_cta: 'Pricing CTA'/);
    expect(body).toMatch(/docs_signup: 'Docs signup'/);
    expect(body).toMatch(/email_inbound: 'Email inbound'/);
    expect(body).toMatch(/other: 'Other'/);
  });

  it('hero subtitle: "Pre-signup interest captured from the marketing site, docs, and inbound email."', () => {
    expect(body).toMatch(
      /Pre-signup interest captured from the marketing site, docs, and inbound\s+email\. Convert to account or archive once contacted\./,
    );
  });

  it('filter bar: email/notes search + 4-option source select', () => {
    expect(body).toMatch(/placeholder="Filter by email or notes…"/);
    expect(body).toMatch(/<option value="">All sources<\/option>/);
    expect(body).toMatch(/<option value="pricing_cta">Pricing CTA<\/option>/);
    expect(body).toMatch(/<option value="docs_signup">Docs signup<\/option>/);
    expect(body).toMatch(/<option value="email_inbound">Email inbound<\/option>/);
    expect(body).toMatch(/<option value="other">Other<\/option>/);
  });

  it('empty-state UX: "No leads yet" + "Once the marketing site captures signup intent" framing', () => {
    expect(body).toMatch(/No leads yet/);
    expect(body).toMatch(
      /Once the marketing site captures signup intent, leads land here for\s+sales follow-up/,
    );
  });

  it('lead row 3 actions: Convert to account / Archive / Email reply (mailto)', () => {
    expect(body).toMatch(/Convert to account →/);
    expect(body).toMatch(/>\s*Archive\s*</);
    expect(body).toMatch(/href=\{`mailto:\$\{lead\.email\}`\}/);
    expect(body).toMatch(/>\s*Email reply\s*</);
  });

  it('lead row uses fmtIso helper for capturedAt (ISO display normalization)', () => {
    expect(body).toMatch(/function fmtIso\(iso: string\): string/);
    expect(body).toMatch(
      /new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC'/,
    );
    expect(body).toMatch(/Captured \{fmtIso\(lead\.capturedAt\)\}/);
  });

  it('lead row exposes id (font-mono) + email + optional notes', () => {
    expect(body).toMatch(/\{lead\.email\}/);
    expect(body).toMatch(/<p class="mt-1 font-mono text-xs text-tk-ink-3">\{lead\.id\}<\/p>/);
    expect(body).toMatch(/\{lead\.notes !== null && \(/);
  });

  it('source badge fallback: SOURCE_BADGE[lead.source] ?? SOURCE_BADGE.other', () => {
    expect(body).toMatch(/SOURCE_BADGE\[lead\.source\] \?\? SOURCE_BADGE\.other/);
    expect(body).toMatch(/SOURCE_LABEL\[lead\.source\] \?\? lead\.source/);
  });

  it('footer audit-log + magic-link signup claim pinned', () => {
    expect(body).toMatch(
      /Conversion creates an account row \+ sends a magic-link signup email\.\s+Archive marks the lead resolved without account creation\. All actions\s+audit-logged\./,
    );
  });

  it('"Open" link per row points to /leads/${lead.id} (detail-page route)', () => {
    expect(body).toMatch(/href=\{`\/leads\/\$\{lead\.id\}`\}/);
    expect(body).toMatch(/>\s*Open\s*</);
  });
});
