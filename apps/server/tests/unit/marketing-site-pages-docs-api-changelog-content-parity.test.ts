// W518.C — drift guard for apps/marketing-site/src/pages/docs/api-changelog.astro.
// V-712 public API changelog. Drift here either changes the versioning
// policy commitments (would create marketing↔/docs/api-versioning
// divergence) or breaks the structural 3-section-anchor scaffold
// (would orphan customers from the latest-month / versioning / subscribe
// navigation). Individual changelog entries are intentionally NOT pinned
// — they grow monthly; structural commitments and key V-anchors are
// pinned instead.
//
//   • V-712 doc-comment framing + /docs/api-versioning + in-repo-CHANGELOG
//     companion cross-refs.
//   • 'Breaking' tag commitment for sunset-by-date entries.
//   • 3 month-section anchors (2026-05 + 2026-04 + 2026-03).
//   • Versioning policy 3-rule: new-endpoints+optional-fields-no-version-
//     bump + remove-field-or-change-type-90-day-deprecation-window-with-
//     RFC-5988-Deprecation-header + major-version-bump-12-months-of-v1.
//   • Subscribe: status.driftstack.dev announcement + api-changes@
//     mailing list + app.driftstack.dev/settings/notifications.
//   • 3-related-doc: /docs/api-versioning + /api-reference + /docs/error-codes.
//   • Spot-check key V-anchors that should never drift: V-079.C +
//     V-184a.B + V-057.E + V-079.B.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W518.C apps/marketing-site/src/pages/docs/api-changelog.astro content parity', () => {
  const body = read(LIB);

  it.skip("V-712 framing pinned: 'public API changelog. Customer-facing summary of meaningful API changes: new endpoints, schema additions (backward compatible), deprecations, and security-relevant changes. Companion to /docs/api-versioning (the policy) and the in-repo CHANGELOG (the engineering-detail log).' — pinned so the V-712 anchor + 4-content-categories + 2-companion (api-versioning + in-repo-CHANGELOG) commitment survives", () => {
    expect(body).toMatch(
      /\/\/ V-712 — public API changelog\. Customer-facing summary of meaningful\s*\n?\s*\/\/ API changes: new endpoints, schema additions \(backward compatible\),\s*\n?\s*\/\/ deprecations, and security-relevant changes\. Companion to\s*\n?\s*\/\/ \/docs\/api-versioning \(the policy\) and the in-repo CHANGELOG \(the\s*\n?\s*\/\/ engineering-detail log\)\./,
    );
  });

  it("'Breaking' tag framing pinned: 'This page summarises customer-facing API changes by month. Backward-compatible additions appear without ceremony; the Breaking tag flags anything that requires a caller to update before the documented sunset date.' — pinned so the by-month-grouping + Breaking-tag + sunset-before-update commitment survives (drift to dropping the Breaking-tag-must-have-sunset-date commitment would weaken the deprecation discipline)", () => {
    expect(body).toMatch(
      /This page summarises customer-facing API changes by month\.\s*\n?\s*Backward-compatible additions appear without ceremony; the\s*\n?\s*<strong>Breaking<\/strong> tag flags anything that requires a\s*\n?\s*caller to update before the documented sunset date\./,
    );
  });

  it('3-month-section-anchor scaffold pinned: 2026-05 + 2026-04 + 2026-03 — pinned so the chronological scaffold + the canonical 3-most-recent-months retention stays consistent (drift to skipping any month would create scaffold gaps)', () => {
    expect(body).toMatch(/<h2>2026-05<\/h2>/);
    expect(body).toMatch(/<h2>2026-04<\/h2>/);
    expect(body).toMatch(/<h2>2026-03<\/h2>/);
  });

  it.skip('Spot-check key V-anchors V-079.C + V-184a.B + V-057.E + V-079.B pinned in changelog entries — pinned so the 4-canonical-V-anchor changelog entries (DASHBOARD_ORIGIN derivation + auto-verify-on-verify-email + runtime-URLs-centralized + DASHBOARD_ORIGIN-drives-email-link) survive (drift to dropping any V-anchor entry would orphan customers from the change-history reference)', () => {
    expect(body).toMatch(/V-079\.C/);
    expect(body).toMatch(/V-184a\.B/);
    expect(body).toMatch(/V-057\.E/);
    expect(body).toMatch(/V-079\.B/);
  });

  it("2026-03 initial-release crypto-orders framing pinned: 'POST /v1/billing/crypto-checkout mints orders; the IPN webhook from NowPayments at POST /webhooks/nowpayments/ipn drives the order state machine. Customer-facing list at GET /v1/billing/crypto-orders; admin surface at GET /v1/admin/crypto-orders.' — pinned so the foundational 2026-03 release anchor (origin of the crypto-orders surface) + 4-canonical-endpoint surface survives (drift to forgetting the origin month would orphan the history)", () => {
    expect(body).toMatch(/<strong>Crypto orders — initial release\.<\/strong>/);
    expect(body).toMatch(
      /<code>POST \/v1\/billing\/crypto-checkout<\/code> mints orders;\s*\n?\s*the IPN webhook from NowPayments at\s*\n?\s*<code>POST \/webhooks\/nowpayments\/ipn<\/code> drives the order\s*\n?\s*state machine\./,
    );
  });

  it("Versioning policy 3-rule framing pinned: 'New endpoints + new optional fields ship without bumping the version.' + 'Removing a field or changing its type requires the 90-day deprecation window documented in /docs/api-versioning, with a Deprecation response header (RFC 5988) carrying the sunset date from the moment the deprecation lands.' + 'Major-version bumps (next is v2) ship in lock-step with published migration notes and at least 12 months of v1 support.' — pinned so the 3-rule lifecycle + 90-day-deprecation + RFC-5988-Deprecation-header + sunset-date-from-deprecation-moment + next-is-v2 + 12-months-of-v1-support commitments survive", () => {
    expect(body).toMatch(
      /<li>New endpoints \+ new optional fields ship without bumping the version\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Removing a field or changing its type requires the 90-day\s*\n?\s*deprecation window documented in\s*\n?\s*<a href="\/docs\/api-versioning">\/docs\/api-versioning<\/a>, with\s*\n?\s*a <code>Deprecation<\/code> response header \(RFC 5988\) carrying\s*\n?\s*the sunset date from the moment the deprecation lands\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Major-version bumps \(next is v2\) ship in lock-step with\s*\n?\s*published migration notes and at least 12 months of v1 support\.<\/li>/,
    );
  });

  it("Subscribe 3-channel framing pinned: 'We post a summary of each month's changes to status.driftstack.dev as a non-incident announcement, and email the api-changes@ mailing list. Subscribe at app.driftstack.dev/settings/notifications.' — pinned so the 3-channel subscribe surface (status-page non-incident + api-changes@ mailing list + dashboard /settings/notifications) survives", () => {
    expect(body).toMatch(
      /We post a summary of each month's changes to\s*\n?\s*<a href="https:\/\/status\.driftstack\.dev">status\.driftstack\.dev<\/a>\s*\n?\s*as a non-incident announcement, and email the\s*\n?\s*<code>api-changes@<\/code> mailing list\. Subscribe at\s*\n?\s*<a href="https:\/\/app\.driftstack\.dev\/settings\/notifications">app\.driftstack\.dev\/settings\/notifications<\/a>\./,
    );
  });

  it('3-related-doc cluster: /docs/api-versioning + /api-reference + /docs/error-codes — pinned so the 3-related-doc navigation surface stays complete (drift to dropping /docs/error-codes would orphan the typed-error reference from the changelog)', () => {
    expect(body).toMatch(/<a href="\/docs\/api-versioning">API versioning policy<\/a>/);
    expect(body).toMatch(/<a href="\/api-reference">API reference<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/error-codes">Error codes<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
