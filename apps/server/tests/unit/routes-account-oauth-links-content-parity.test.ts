// Drift guard for apps/server/src/routes/account-oauth-links.ts. Pins
// V-667.C-followup GET /v1/account/me/oauth-links — the customer-
// facing read of the OAuth links table. Drift to surfacing the
// provider_avatar_url / provider_name fields would leak first-link-
// only IDP signals (Verdict 3); drift to dropping the active_only
// filter would force the dashboard to filter Verdict-2 revoked links
// client-side.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-oauth-links.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/account-oauth-links content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C-followup module-level framing pinned: 'customer-facing read of the OAuth links table. GET /v1/account/me/oauth-links — list the authenticated account's active sign-in-with-IDP links.' — pinned so the V-667.C-followup anchor + route-path + endpoint-purpose stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-667\.C-followup — customer-facing read of the OAuth links table\./,
    );
    expect(body).toMatch(
      /\/\/\s+GET \/v1\/account\/me\/oauth-links — list the authenticated account's\s*\/\/\s+active sign-in-with-IDP links\./,
    );
  });

  it("Dashboard-consumer + DELETE-as-separate-slice framing pinned: 'Used by the customer dashboard's account/security page to show \"Linked accounts: Google (connected 2026-05-12), GitHub (revoked upstream — re-link or use password)\". DELETE / revoke from driftstack-side is a separate slice (V-667.C-followup#2).' — pinned so the dashboard-consumer + read-only-no-delete-yet contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Used by the customer dashboard's account\/security page to show\s*\/\/ "Linked accounts: Google \(connected 2026-05-12\), GitHub \(revoked\s*\/\/ upstream — re-link or use password\)"\. DELETE \/ revoke from\s*\/\/ driftstack-side is a separate slice \(V-667\.C-followup#2\)\./,
    );
  });

  it('PublicOAuthLink 6-field shape pinned: id (ol_-prefix) + provider + provider_email (nullable) + linked_at + last_login_at (nullable) + last_revoked_at (nullable). Drift to surfacing provider_avatar_url or provider_name on this endpoint would leak Verdict 3 first-link-only IDP signals; drift to dropping the nullable on email would crash on accounts that linked before email-collection was added', () => {
    expect(body).toMatch(/interface PublicOAuthLink \{\s*id: string;/);
    expect(body).toMatch(/provider: string;/);
    expect(body).toMatch(/provider_email: string \| null;/);
    expect(body).toMatch(/linked_at: string;/);
    expect(body).toMatch(/last_login_at: string \| null;/);
    expect(body).toMatch(/last_revoked_at: string \| null;/);
  });

  it("publicLink mapper pinned: ol_<id> prefix + provider passthrough + null-safe ISO toISOString on linkedAt/lastLoginAt/lastRevokedAt. Drift to dropping the ol_ prefix would break the dashboard's id-routing pattern", () => {
    expect(body).toMatch(
      /function publicLink\(row: OAuthLinkRow\): PublicOAuthLink \{\s*return \{\s*id: `ol_\$\{row\.id\}`,\s*provider: row\.provider,\s*provider_email: row\.providerEmail,\s*linked_at: row\.linkedAt\.toISOString\(\),\s*last_login_at: row\.lastLoginAt \? row\.lastLoginAt\.toISOString\(\) : null,\s*last_revoked_at: row\.lastRevokedAt \? row\.lastRevokedAt\.toISOString\(\) : null,/,
    );
  });

  it("Verdict 3 first-link-only avoid-leak framing pinned: 'provider_avatar_url + provider_name are first-link-only IDP signals (Verdict 3) and used internally; not surfaced on this customer-facing endpoint so a future re-link change doesn't leak as a profile update.' — pinned so the don't-leak-IDP-update-as-profile-change contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-667\.C — provider_avatar_url \+ provider_name are first-link-\s*\/\/ only IDP signals \(Verdict 3\) and used internally; not surfaced\s*\/\/ on this customer-facing endpoint so a future re-link change\s*\/\/ doesn't leak as a profile update\./,
    );
  });

  it("?active_only=true filter framing pinned: 'filters Verdict-2 revoked links so the dashboard's \"Connected accounts\" UI doesn't have to filter client-side. Defaults to false (show all) so audit views see the full history.' + .filter((r) => r.lastRevokedAt === null) — pinned so the dashboard-convenience + default-shows-all-for-audit contract stays documented (drift to default-true would hide revoked-link history from audit views)", () => {
    expect(body).toMatch(
      /\/\/ \?active_only=true filters Verdict-2 revoked links so the\s*\/\/ dashboard's "Connected accounts" UI doesn't have to filter\s*\/\/ client-side\. Defaults to false \(show all\) so audit views see\s*\/\/ the full history\./,
    );
    // V-1367 — the filter used to be read straight off request.query. A repeated query
    // key parses to an array, which never equals 'true', so the filter silently did not
    // apply and the revoked links came back with a 200. The read now goes through a
    // schema, and the pin follows it; the filter expression itself is unchanged.
    expect(body).toMatch(
      /const query = ListOAuthLinksQuerySchema\.safeParse\(request\.query\);\s*if \(!query\.success\) throw new ValidationError\(query\.error\.flatten\(\)\);\s*const activeOnly = query\.data\.active_only === 'true';\s*const filtered = activeOnly \? rows\.filter\(\(r\) => r\.lastRevokedAt === null\) : rows;\s*return \{ data: filtered\.map\(publicLink\) \};/,
    );
  });

  // V-1367 — and the schema stays a string rather than an enum. The two admin routes with
  // a boolean query param use z.enum(['true','false']); adopting it here would newly reject
  // ?active_only=1 and ?active_only= on a documented customer endpoint, which is a different
  // change from fixing the array. Executed both ways in the integration file.
  it('CRITICAL the active_only schema narrows the TYPE, not the accepted values — an enum here would be a customer-facing rejection change rather than the array fix', () => {
    expect(body).toMatch(
      /const ListOAuthLinksQuerySchema = z\.object\(\{\s*active_only: z\.string\(\)\.optional\(\),\s*\}\);/,
    );
    expect(body, 'an enum would change which single values are accepted').not.toMatch(
      /active_only: z\.enum\(/,
    );
  });

  it("Auth posture pinned: requireAuth + broad read scope + rateLimit('global') preHandler + ctx.account.id used as listForAccount key. Drift to a granular/zero-scope read would expose linked identity metadata outside the account-wide read boundary", () => {
    expect(body).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \}/,
    );
    expect(body).toMatch(
      /const ctx = request\.account;\s*if \(!ctx\) throw new Error\('account context missing after requireAuth'\);\s*const rows = await opts\.links\.listForAccount\(ctx\.account\.id\);/,
    );
  });
});
