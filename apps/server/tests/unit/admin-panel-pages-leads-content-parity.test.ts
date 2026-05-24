// W487.A — drift guard for apps/admin-panel/src/pages/leads.astro.
// Pre-signup interest tracking page. Drift here either swaps the
// SOURCE_BADGE/SOURCE_LABEL 4-key catalogue (badges go grey when a
// new source variant lands without a matching label entry) or
// drops the audit-log framing ('All actions audit-logged') which
// is the operator's contract that lead-conversion writes the
// admin_audit_log.
//
//   • SOURCE_BADGE + SOURCE_LABEL 4-key catalogue (pricing_cta /
//     docs_signup / email_inbound / other).
//   • Convert-to-account + Archive + Email reply per-row actions.
//   • 'Conversion creates an account row + sends a magic-link
//     signup email. Archive marks the lead resolved without
//     account creation. All actions audit-logged.' framing.
//   • MOCK_LEADS empty-state branch.

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

  it("Page-header framing: 'Leads' h1 + 'Pre-signup interest captured…' subhead. 2026-05-23 — h1 wrapped in oxblood gradient span (admin-panel visual unification); pin loosened to label-presence + subhead anchor.", () => {
    expect(body).toMatch(/<h1 class="text-3xl font-semibold tracking-tight text-slate-900">/);
    expect(body).toMatch(/>Leads</);
    expect(body).toMatch(
      /Pre-signup interest captured from the marketing site, docs, and inbound\s*\n?\s*email\. Convert to account or archive once contacted\./,
    );
  });

  it("SOURCE_BADGE + SOURCE_LABEL 4-key catalogue: pricing_cta ('Pricing CTA' / oxblood-50) / docs_signup ('Docs signup' / blue-50) / email_inbound ('Email inbound' / emerald-50) / other ('Other' / slate-100) — pinned so the badge colour ↔ label mapping stays in sync (drift to a 3-key catalogue would silently grey out a real source when the lookup falls through)", () => {
    expect(body).toMatch(
      /const SOURCE_BADGE: Record<string, string> = \{\s*\n?\s*pricing_cta: 'bg-oxblood-50 text-oxblood-700',\s*\n?\s*docs_signup: 'bg-blue-50 text-blue-700',\s*\n?\s*email_inbound: 'bg-emerald-50 text-emerald-700',\s*\n?\s*other: 'bg-slate-100 text-slate-600',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const SOURCE_LABEL: Record<string, string> = \{\s*\n?\s*pricing_cta: 'Pricing CTA',\s*\n?\s*docs_signup: 'Docs signup',\s*\n?\s*email_inbound: 'Email inbound',\s*\n?\s*other: 'Other',\s*\n?\s*\};/,
    );
  });

  it("Per-row 3-action surface: Convert-to-account → href=#convert-{id} + Archive → href=#archive-{id} + Email reply → mailto:{email} — pinned so the action vocabulary stays consistent (convert / archive / email) and the email-reply path uses the customer's address as a true mailto: link (not an in-app composer that doesn't exist)", () => {
    expect(body).toMatch(
      /<a href=\{`#convert-\$\{lead\.id\}`\} class="text-sm text-oxblood-700 hover:underline">\s*\n?\s*Convert to account →\s*\n?\s*<\/a>/,
    );
    expect(body).toMatch(
      /<a href=\{`#archive-\$\{lead\.id\}`\} class="text-sm text-slate-600 hover:underline">\s*\n?\s*Archive\s*\n?\s*<\/a>/,
    );
    expect(body).toMatch(/href=\{`mailto:\$\{lead\.email\}`\}/);
  });

  it("Empty-state branch: MOCK_LEADS.length === 0 → 'No leads yet' + 'Once the marketing site captures signup intent, leads land here for sales follow-up.' — pinned so operators visiting the page with zero leads see a clear 'this is working, just empty' message instead of a bare empty table that looks broken", () => {
    expect(body).toMatch(/No leads yet/);
    expect(body).toMatch(
      /Once the marketing site captures signup intent, leads land here for\s*\n?\s*sales follow-up\./,
    );
  });

  it("Audit-log framing pinned: 'Conversion creates an account row + sends a magic-link signup email. Archive marks the lead resolved without account creation. All actions audit-logged.' — pinned so the audit-log invariant stays explicit on the page that operators do conversion/archive from (drift to a softer 'logged' phrasing weakens the audit-trail contract)", () => {
    expect(body).toMatch(
      /Conversion creates an account row \+ sends a magic-link signup email\.\s*\n?\s*Archive marks the lead resolved without account creation\. All actions\s*\n?\s*audit-logged\./,
    );
  });

  it("Filter bar: search input ('Filter by email or notes…') + source <select> with 5 options (All sources / pricing_cta / docs_signup / email_inbound / other) — pinned so the filter taxonomy mirrors the SOURCE_BADGE catalogue (adding a 5th source means the select needs the 5th option too — drift would make the new source unfilterable)", () => {
    expect(body).toMatch(/placeholder="Filter by email or notes…"/);
    expect(body).toMatch(/<option value="">All sources<\/option>/);
    expect(body).toMatch(/<option value="pricing_cta">Pricing CTA<\/option>/);
    expect(body).toMatch(/<option value="docs_signup">Docs signup<\/option>/);
    expect(body).toMatch(/<option value="email_inbound">Email inbound<\/option>/);
    expect(body).toMatch(/<option value="other">Other<\/option>/);
  });

  it("fmtIso helper: ISO → 'YYYY-MM-DD HH:MM UTC' format (slice(0, 16) + ' UTC') — pinned so the captured-at timestamps stay in a consistent UTC display format across the admin panel (drift to a locale-dependent format would make timestamps interpretation-dependent for ops staff in different timezones)", () => {
    expect(body).toMatch(
      /function fmtIso\(iso: string\): string \{\s*\n?\s*return new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC';\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
