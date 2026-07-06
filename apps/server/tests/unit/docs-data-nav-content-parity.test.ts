// W463.A — drift guard for apps/docs/src/data/nav.ts.
// V-254 doc-site central navigation. Drift here either re-orders
// sections or drops entries from the tree (broken/orphaned sidebar
// links for live docs traffic).
//
// S22.2 SUPERSESSION (2026-07-06) — full lockstep rewrite for the
// founder's Stoplight-style docs redesign: DOC_NAV now carries ALL 50
// routes under src/pages in a 7-section tree (Overview → Get started
// → Guides → SDKs → API reference → Webhooks → Platform reference).
// The superseded posture this replaces: a 28-entry, 6-section nav
// (Overview → Get started → SDKs → Guides → API reference → Webhooks)
// that orphaned 22 pages — ALL 6 /reference/*, 4 /sdk/* quickstarts +
// error-handling, and 12 /api/* resource pages had no sidebar entry
// and were reachable only by URL. That orphaning was the single
// biggest cause of the "docs are unclear" feedback; this suite now
// pins the all-routes tree so a dropped entry is a test failure, not
// a silently unreachable page.
//
//   • V-254 framing + categories-order framing + V-256 expansion
//     framing pinned (heritage comments, unchanged).
//   • DocNavItem href + label + OPTIONAL method (S22.4-reserved badge
//     field, unused in S22.2) + DocNavSection 2-field.
//   • 7-section order pinned.
//   • API reference 26 entries in the S22.2 grouped order: overview
//     pair first, then core automation resources (sessions →
//     agent-sessions → recipes → profiles → profile-snapshots →
//     proxies), then account + access control, then billing, then the
//     remaining surfaces.
//   • Total href count = 50 (one per route; slugs frozen).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/data/nav.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W463.A apps/docs/src/data/nav.ts content parity (S22.2 all-50-routes tree)', () => {
  const body = read(LIB);

  it("V-254 framing pinned: 'V-254 — central doc-site navigation. Single source of truth for the sidebar; pages reference this so adding a topic = one edit here.'", () => {
    expect(body).toMatch(
      /\/\/ V-254 — central doc-site navigation\. Single source of truth for the\s*\n?\s*\/\/ sidebar; pages reference this so adding a topic = one edit here\./,
    );
  });

  it('Heritage framings pinned: categories-order intentional + V-256 expansion; S22.2 full-tree framing pinned (50 routes, prior 28-entry nav orphaned 6 reference + 4 sdk + 12 api pages, labels plain-words, slugs FROZEN)', () => {
    expect(body).toMatch(
      /\/\/ Categories order intentional: Quickstart at the top so a new\s*\n?\s*\/\/ customer's first click lands on a "I just got my key, what now"\s*\n?\s*\/\/ page; Reference \+ Architecture at the bottom for spec-level depth\./,
    );
    expect(body).toMatch(/\/\/ V-256 expanded: Quickstart section \+ per-topic Guides entries\./);
    expect(body).toMatch(/S22\.2 \(2026-07-06, Stoplight relayout\) — FULL-TREE expansion/);
    expect(body).toMatch(
      /every\s*\n?\s*\/\/ one of the 50 routes under src\/pages now has a nav entry/,
    );
    expect(body).toMatch(/page slugs are FROZEN/);
  });

  it('DocNavItem interface: href + label + OPTIONAL method (S22.4-reserved GET/POST badge field, explicitly UNUSED in S22.2) + DocNavSection 2-field (label + items DocNavItem[])', () => {
    expect(body).toMatch(
      /export interface DocNavItem \{\s*\n?\s*href: string;\s*\n?\s*label: string;/,
    );
    expect(body).toMatch(/S22\.4 \(reserved\) — HTTP method badge/);
    expect(body).toMatch(/method\?: 'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE';/);
    expect(body).toMatch(/UNUSED in S22\.2/);
    expect(body).toMatch(
      /export interface DocNavSection \{\s*\n?\s*label: string;\s*\n?\s*items: DocNavItem\[\];\s*\n?\s*\}/,
    );
  });

  it('7-section ordered tree pinned: Overview → Get started → Guides → SDKs → API reference → Webhooks → Platform reference (S22.2 moved Guides ahead of SDKs and added Platform reference for the 6 /reference/* pages)', () => {
    const labels = [...body.matchAll(/^ {4}label: '([^']+)',$/gm)].map((m) => m[1]);
    expect(labels).toEqual([
      'Overview',
      'Get started',
      'Guides',
      'SDKs',
      'API reference',
      'Webhooks',
      'Platform reference',
    ]);
  });

  it("Overview + Get started blocks pinned: '/' Introduction first item; quickstart + license-activation", () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Overview',\s*\n?\s*items: \[\{ href: '\/', label: 'Introduction' \}\],\s*\n?\s*\},\s*\n?\s*\{\s*\n?\s*label: 'Get started',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/quickstart\/', label: 'Quickstart' \},\s*\n?\s*\{ href: '\/license-activation\/', label: 'License activation \(GUI client\)' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
  });

  it('Guides section: 5 entries (overview + profile-management + session-lifecycle + team-rbac + live-video); team-rbac label is the plain-words "Teams & access control" (page slug/title untouched)', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Guides',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/guides\/', label: 'Guides overview' \},\s*\n?\s*\{ href: '\/guides\/profile-management\/', label: 'Profile management' \},\s*\n?\s*\{ href: '\/guides\/session-lifecycle\/', label: 'Session lifecycle' \},\s*\n?\s*\{ href: '\/guides\/team-rbac\/', label: 'Teams & access control' \},\s*\n?\s*\{ href: '\/guides\/live-video\/', label: 'Live video' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
  });

  it('SDKs section: 7 entries — overview + installation + the 3 language quickstarts (previously orphaned) + error-handling (previously orphaned) + versioning', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'SDKs',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/sdk\/', label: 'SDK overview' \},\s*\n?\s*\{ href: '\/sdk\/installation\/', label: 'Installation' \},\s*\n?\s*\{ href: '\/sdk\/typescript-quickstart\/', label: 'TypeScript quickstart' \},\s*\n?\s*\{ href: '\/sdk\/python-quickstart\/', label: 'Python quickstart' \},\s*\n?\s*\{ href: '\/sdk\/go-quickstart\/', label: 'Go quickstart' \},\s*\n?\s*\{ href: '\/sdk\/error-handling\/', label: 'Error handling' \},\s*\n?\s*\{ href: '\/sdk\/versioning\/', label: 'Versioning policy' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
  });

  it('API reference head: overview pair then the core automation resources in order (sessions → agent-sessions → recipes → profiles → profile-snapshots → proxies)', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'API reference',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/api\/', label: 'API overview' \},\s*\n?\s*\{ href: '\/api\/versioning\/', label: 'Versioning policy' \},\s*\n?\s*\/\/ Core automation resources\.\s*\n?\s*\{ href: '\/api\/sessions\/', label: 'Sessions' \},\s*\n?\s*\{ href: '\/api\/agent-sessions\/', label: 'Agent sessions' \},\s*\n?\s*\{ href: '\/api\/recipes\/', label: 'Recipes' \},\s*\n?\s*\{ href: '\/api\/profiles\/', label: 'Profiles' \},\s*\n?\s*\{ href: '\/api\/profile-snapshots\/', label: 'Profile snapshots' \},\s*\n?\s*\{ href: '\/api\/proxies\/', label: 'Account proxies' \},/,
    );
  });

  it('API reference account + access-control group pinned in order: account → auth → mfa → oauth → api-keys → team → usage → audit-log', () => {
    expect(body).toMatch(
      /\/\/ Account \+ access control\.\s*\n?\s*\{ href: '\/api\/account\/', label: 'Account' \},\s*\n?\s*\{ href: '\/api\/auth\/', label: 'Authentication' \},\s*\n?\s*\{ href: '\/api\/mfa\/', label: 'Two-factor auth \(MFA\)' \},\s*\n?\s*\{ href: '\/api\/oauth\/', label: 'OAuth \(third-party clients\)' \},\s*\n?\s*\{ href: '\/api\/api-keys\/', label: 'API keys' \},\s*\n?\s*\{ href: '\/api\/team\/', label: 'Teams & access control' \},\s*\n?\s*\{ href: '\/api\/usage\/', label: 'Usage \+ quotas' \},\s*\n?\s*\{ href: '\/api\/audit-log\/', label: 'Audit log' \},/,
    );
  });

  it('API reference billing group + remaining surfaces pinned: billing → billing-crypto → cost-monitoring, then bundled-llm → byok-anthropic → account-notifications → account-rate-limits → email-preferences → status → legal', () => {
    expect(body).toMatch(
      /\/\/ Billing \+ spend\.\s*\n?\s*\{ href: '\/api\/billing\/', label: 'Billing' \},\s*\n?\s*\{ href: '\/api\/billing-crypto\/', label: 'Crypto checkout' \},\s*\n?\s*\{ href: '\/api\/cost-monitoring\/', label: 'Cost monitoring' \},/,
    );
    expect(body).toMatch(
      /\/\/ Remaining surfaces\.\s*\n?\s*\{ href: '\/api\/bundled-llm\/', label: 'Bundled LLM' \},\s*\n?\s*\{ href: '\/api\/byok-anthropic\/', label: 'Bring your own Anthropic key' \},\s*\n?\s*\{ href: '\/api\/account-notifications\/', label: 'Account notifications \(SSE\)' \},\s*\n?\s*\{ href: '\/api\/account-rate-limits\/', label: 'Account rate limits' \},\s*\n?\s*\{ href: '\/api\/email-preferences\/', label: 'Email preferences' \},\s*\n?\s*\{ href: '\/api\/status\/', label: 'Status page API' \},\s*\n?\s*\{ href: '\/api\/legal\/', label: 'Legal documents' \},/,
    );
  });

  it('Webhooks section: 3 entries (endpoints + events + replay)', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Webhooks',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/webhooks\/endpoints\/', label: 'Endpoints \(CRUD \+ rotate \+ test\)' \},\s*\n?\s*\{ href: '\/webhooks\/events\/', label: 'Event catalog' \},\s*\n?\s*\{ href: '\/webhooks\/replay\/', label: 'Replay deliveries' \},/,
    );
  });

  it('Platform reference section (NEW in S22.2 — all 6 /reference/* pages were orphaned before): errors → rate-limits → pagination → idempotency → scopes → metrics', () => {
    expect(body).toMatch(
      /\{\s*\n?\s*label: 'Platform reference',\s*\n?\s*items: \[\s*\n?\s*\{ href: '\/reference\/errors\/', label: 'Errors' \},\s*\n?\s*\{ href: '\/reference\/rate-limits\/', label: 'Rate limits' \},\s*\n?\s*\{ href: '\/reference\/pagination\/', label: 'Pagination' \},\s*\n?\s*\{ href: '\/reference\/idempotency\/', label: 'Idempotency keys' \},\s*\n?\s*\{ href: '\/reference\/scopes\/', label: 'API key scopes' \},\s*\n?\s*\{ href: '\/reference\/metrics\/', label: 'Prometheus metrics' \},\s*\n?\s*\],\s*\n?\s*\},/,
    );
  });

  it('total tree size = 50 hrefs (one per route under src/pages; a drop below 50 means a page went orphaned again, a rise means a new page landed — extend the tree AND this pin together)', () => {
    const hrefs = [...body.matchAll(/\{ href: '([^']+)', label: /g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(50);
    // No duplicate hrefs (the apps/docs doc-nav-section-label-baseline
    // suite enforces this at runtime too; mirrored here so a server-only
    // run still catches it).
    expect(new Set(hrefs).size).toBe(50);
  });

  it('the 22 previously-orphaned routes are all present (6 reference + 5 sdk/api spillover checks kept explicit for the highest-traffic ones)', () => {
    for (const href of [
      '/reference/errors/',
      '/reference/rate-limits/',
      '/reference/pagination/',
      '/reference/idempotency/',
      '/reference/scopes/',
      '/reference/metrics/',
      '/sdk/typescript-quickstart/',
      '/sdk/python-quickstart/',
      '/sdk/go-quickstart/',
      '/sdk/error-handling/',
      '/api/account/',
      '/api/auth/',
      '/api/oauth/',
      '/api/billing/',
      '/api/billing-crypto/',
      '/api/cost-monitoring/',
      '/api/profile-snapshots/',
      '/api/account-notifications/',
      '/api/account-rate-limits/',
      '/api/email-preferences/',
      '/api/status/',
      '/api/legal/',
    ]) {
      expect(body).toContain(`href: '${href}'`);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
