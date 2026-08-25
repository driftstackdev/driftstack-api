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
//
// S22.4 SUPERSESSION (2026-07-06, Stoplight reference furniture) —
// per-endpoint anchor SUB-NODES went live: the 24 API-reference
// resource entries now carry `children` (108 `{ href, label, method }`
// endpoint anchors, extracted from the api/*.md h2 sections; the
// apps/docs docs-nav-endpoint-children-integrity suite re-derives that
// data from the .md sources and deep-equals it, so THIS suite pins
// structure/order, not the endpoint census). Superseded postures this
// replaces:
//   • DocNavItem.method was "(reserved) … UNUSED in S22.2" — now LIVE
//     via the new DocNavChild shape.
//   • API-reference entries were single-line `{ href, label }` — the
//     24 with children are now multi-line objects, so the grouped-order
//     pins below match by ordered top-level href extraction (children
//     hrefs all carry a '#' and are excluded).
//   • Total-count pin split: 50 top-level route hrefs + 108 children
//     anchor hrefs.
//
// S27 SUPERSESSION (2026-07-07, docs reference hygiene) — the children
// census rose 108 → 130 (122 API + 8 webhooks): api/status's
// heading-embedded "… — METHOD /path" h2 format was normalized to
// declaration-line sections (clean anchors — the '#snapshot--get-v1status'
// style slugs are retired), flow-step endpoints were promoted to h2
// sections (oauth 1/2/4, mfa enroll/verify, auth cli-authorize
// initiate/bind/exchange, agent-sessions takeover/handback/resume),
// profiles Export / Import split into two sections, and the Webhooks
// section now carries children too (endpoints + replay; events is a
// catalog with none). Top-level slugs stay FROZEN at 50.
//
// S29 SUPERSESSION (2026-07-07, docs content-enrichment batch 1) —
// top-level census 50 → 55: five NEW pages migrated from the legacy
// marketing /docs mirror (every factual claim re-verified against
// server/SDK/api-types source first). Get started gains
// /quickstart-curl/ ("Quickstart (curl)", between the SDK quickstart
// and license-activation); Guides gains /guides/concurrency/
// ("Concurrency & backpressure", after session-lifecycle),
// /guides/migrate-from-puppeteer/, /guides/migrate-from-browserless/
// (after live-video), and /guides/sentry/ (last). Children census
// UNCHANGED at 130 — the new pages are guides/get-started content,
// and children extraction only covers the API reference + Webhooks
// sections. The superseded "exactly 5 Guides entries / exactly 2 Get
// started entries / 50 routes" pins below were re-pinned in lockstep.
//
// S33 SUPERSESSION 2026-07-07 (fable-truth-audit) — children census
// 130 → 139 (131 API + 8 webhooks): 9 live-but-undocumented endpoints
// were registered in openapi.ts + documented, so agent-sessions gains
// 7 sub-nodes (page-state / cookie read+import / history step / file
// upload / downloads list+fetch), profiles gains trim, and auth gains
// resend-verification. Top-level census unchanged at 55.
//
// S37 SUPERSESSION 2026-07-07 (docs content-enrichment batch 2) —
// top-level census 55 → 60: five NEW pages adapted from the legacy
// marketing /docs mirror (claims re-verified against the crypto
// routes/service, email-service send sites, and the post-S30
// residency posture). Guides gains /guides/paying-with-crypto/ +
// /guides/crypto-troubleshooting/ (after sentry); Webhooks gains
// /webhooks/crypto-events/ ("Crypto order events", a catalog page
// with NO children, between the event catalog and replay); Platform
// reference gains /reference/emails/ + /reference/data-residency/
// (last). Children census unchanged at 139.

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

describe('W463.A apps/docs/src/data/nav.ts content parity (S22.2 all-50-routes tree + S22.4 endpoint children)', () => {
  const body = read(LIB);

  it("V-254 framing pinned: 'V-254 — central doc-site navigation. Single source of truth for the sidebar; pages reference this so adding a topic = one edit here.'", () => {
    expect(body).toMatch(
      /\/\/ V-254 — central doc-site navigation\. Single source of truth for the\s*\/\/ sidebar; pages reference this so adding a topic = one edit here\./,
    );
  });

  it('Heritage framings pinned: categories-order intentional + V-256 expansion; S22.2 full-tree framing pinned (50 routes, prior 28-entry nav orphaned 6 reference + 4 sdk + 12 api pages, labels plain-words, slugs FROZEN)', () => {
    expect(body).toMatch(
      /\/\/ Categories order intentional: Quickstart at the top so a new\s*\/\/ customer's first click lands on a "I just got my key, what now"\s*\/\/ page; Reference \+ Architecture at the bottom for spec-level depth\./,
    );
    expect(body).toMatch(/\/\/ V-256 expanded: Quickstart section \+ per-topic Guides entries\./);
    expect(body).toMatch(/S22\.2 \(2026-07-06, Stoplight relayout\) — FULL-TREE expansion/);
    expect(body).toMatch(/every\s*\/\/ one of the 50 routes under src\/pages now has a nav entry/);
    expect(body).toMatch(/page slugs are FROZEN/);
  });

  it('DocNavItem interface (S22.4 — method chip LIVE, was "(reserved)/UNUSED in S22.2"): href + label + OPTIONAL method + OPTIONAL children (DocNavChild[] anchor sub-nodes; anchors not pages — breadcrumbs/prev-next walk top-level only) + DocNavChild 3-field + DocNavSection 2-field', () => {
    expect(body).toMatch(/export interface DocNavItem \{\s*href: string;\s*label: string;/);
    expect(body).toMatch(/S22\.4 — HTTP method chip \(GET\/POST\/PUT\/PATCH\/DELETE\)/);
    expect(body).toMatch(/method\?: 'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE';/);
    expect(body).not.toMatch(/UNUSED in S22\.2/);
    expect(body).toMatch(/S22\.4 — per-endpoint anchor sub-nodes/);
    expect(body).toMatch(/only while the parent is the ACTIVE page/);
    expect(body).toMatch(
      /breadcrumbs \+ prev\/next keep walking top-level items only\. \*\/\s*children\?: DocNavChild\[\];/,
    );
    expect(body).toMatch(
      /export interface DocNavChild \{\s*href: string;\s*label: string;\s*method\?: DocNavItem\['method'\];\s*\}/,
    );
    expect(body).toMatch(
      /export interface DocNavSection \{\s*label: string;\s*items: DocNavItem\[\];\s*\}/,
    );
    // The S22.4 header framing (extraction rules + lockstep integrity
    // suite pointer) is pinned so the regeneration contract survives.
    expect(body).toMatch(/S22\.4 \(2026-07-06, Stoplight reference furniture\) — per-endpoint/);
    expect(body).toMatch(/docs-nav-endpoint-children-integrity/);
    expect(body).toMatch(
      /children render only for\s*\/\/ the ACTIVE resource page \(Stoplight behavior\)/,
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

  it("Overview + Get started blocks pinned: '/' Introduction first item; quickstart + quickstart-curl (S29) + license-activation", () => {
    expect(body).toMatch(
      /\{\s*label: 'Overview',\s*items: \[\{ href: '\/', label: 'Introduction' \}\],\s*\},\s*\{\s*label: 'Get started',\s*items: \[\s*\{ href: '\/quickstart\/', label: 'Quickstart' \},\s*\{ href: '\/quickstart-curl\/', label: 'Quickstart \(curl\)' \},\s*\{ href: '\/license-activation\/', label: 'License activation \(GUI client\)' \},\s*\],\s*\},/,
    );
  });

  it('Guides section: 11 entries (S29 added concurrency + the two migration guides + sentry; S37 added paying-with-crypto + crypto-troubleshooting); team-rbac label is the plain-words "Teams & access control" (page slug/title untouched)', () => {
    expect(body).toMatch(
      /\{\s*label: 'Guides',\s*items: \[\s*\{ href: '\/guides\/', label: 'Guides overview' \},\s*\{ href: '\/guides\/profile-management\/', label: 'Profile management' \},\s*\{ href: '\/guides\/session-lifecycle\/', label: 'Session lifecycle' \},\s*\{ href: '\/guides\/concurrency\/', label: 'Concurrency & backpressure' \},\s*\{ href: '\/guides\/team-rbac\/', label: 'Teams & access control' \},\s*\{ href: '\/guides\/live-video\/', label: 'Live video' \},\s*\{ href: '\/guides\/migrate-from-puppeteer\/', label: 'Migrating from Puppeteer \/ Playwright' \},\s*\{ href: '\/guides\/migrate-from-browserless\/', label: 'Migrating from Browserless' \},\s*\{ href: '\/guides\/sentry\/', label: 'Sentry integration' \},\s*\{ href: '\/guides\/paying-with-crypto\/', label: 'Paying with crypto' \},\s*\{ href: '\/guides\/crypto-troubleshooting\/', label: 'Crypto payment troubleshooting' \},\s*\],\s*\},/,
    );
  });

  it('SDKs section: 7 entries — overview + installation + the 3 language quickstarts (previously orphaned) + error-handling (previously orphaned) + versioning', () => {
    expect(body).toMatch(
      /\{\s*label: 'SDKs',\s*items: \[\s*\{ href: '\/sdk\/', label: 'SDK overview' \},\s*\{ href: '\/sdk\/installation\/', label: 'Installation' \},\s*\{ href: '\/sdk\/typescript-quickstart\/', label: 'TypeScript quickstart' \},\s*\{ href: '\/sdk\/python-quickstart\/', label: 'Python quickstart' \},\s*\{ href: '\/sdk\/go-quickstart\/', label: 'Go quickstart' \},\s*\{ href: '\/sdk\/error-handling\/', label: 'Error handling' \},\s*\{ href: '\/sdk\/versioning\/', label: 'Versioning policy' \},\s*\],\s*\},/,
    );
  });

  // S22.4 — the resource entries are multi-line objects carrying
  // `children`, so the three grouped-order pins below extract the ordered
  // TOP-LEVEL hrefs of the API-reference section (children anchors all
  // contain '#' and are filtered out) instead of regexing single-line
  // `{ href, label }` literals.
  const apiSlice = body.slice(
    body.indexOf("label: 'API reference',"),
    body.indexOf("label: 'Webhooks',"),
  );
  const apiTopHrefs = [...apiSlice.matchAll(/href: '([^']+)',/g)]
    .map((m) => m[1]!)
    .filter((h) => !h.includes('#'));

  it('API reference: 27 top-level entries in grouped order, including the public archetype catalog', () => {
    expect(apiTopHrefs).toEqual([
      '/api/',
      '/api/versioning/',
      '/api/archetypes/',
      '/api/sessions/',
      '/api/agent-sessions/',
      '/api/recipes/',
      '/api/profiles/',
      '/api/profile-snapshots/',
      '/api/proxies/',
      '/api/account/',
      '/api/auth/',
      '/api/mfa/',
      '/api/oauth/',
      '/api/api-keys/',
      '/api/team/',
      '/api/usage/',
      '/api/audit-log/',
      '/api/billing/',
      '/api/billing-crypto/',
      '/api/cost-monitoring/',
      '/api/bundled-llm/',
      '/api/byok-anthropic/',
      '/api/account-notifications/',
      '/api/account-rate-limits/',
      '/api/email-preferences/',
      '/api/status/',
      '/api/legal/',
    ]);
    for (const comment of [
      '// Core automation resources.',
      '// Account + access control.',
      '// Billing + operational estimate.',
      '// Remaining surfaces.',
    ]) {
      expect(apiSlice).toContain(comment);
    }
  });

  it('API reference labels pinned (plain-words rule; page slugs frozen)', () => {
    for (const [href, label] of [
      ['/api/', 'API overview'],
      ['/api/versioning/', 'Versioning policy'],
      ['/api/archetypes/', 'Archetypes'],
      ['/api/sessions/', 'Sessions'],
      ['/api/agent-sessions/', 'Agent sessions'],
      ['/api/recipes/', 'Recipes'],
      ['/api/profiles/', 'Profiles'],
      ['/api/profile-snapshots/', 'Profile snapshots'],
      ['/api/proxies/', 'Account proxies'],
      ['/api/account/', 'Account'],
      ['/api/auth/', 'Authentication'],
      ['/api/mfa/', 'Two-factor auth (MFA)'],
      ['/api/oauth/', 'OAuth (third-party clients)'],
      ['/api/api-keys/', 'API keys'],
      ['/api/team/', 'Teams & access control'],
      ['/api/usage/', 'Usage + quotas'],
      ['/api/audit-log/', 'Audit log'],
      ['/api/billing/', 'Billing'],
      ['/api/billing-crypto/', 'Crypto checkout'],
      ['/api/cost-monitoring/', 'Operational cost estimate'],
      ['/api/bundled-llm/', 'Bundled LLM'],
      ['/api/byok-anthropic/', 'Bring your own Anthropic key'],
      ['/api/account-notifications/', 'Account notifications (SSE)'],
      ['/api/account-rate-limits/', 'Account rate limits'],
      ['/api/email-preferences/', 'Email preferences'],
      ['/api/status/', 'Status page API'],
      ['/api/legal/', 'Legal documents'],
    ] as const) {
      // Multi-line (children-carrying) and single-line forms both render
      // href then label as consecutive fields.
      const re = new RegExp(
        `href: '${href.replace(/[/]/g, '\\/')}',\\s*\\n?\\s*label: '${label
          .replace(/[()]/g, '\\$&')
          .replace(/\+/g, '\\+')}',?`,
      );
      expect(body).toMatch(re);
    }
  });

  it('operational estimate child uses the canonical current heading anchor', () => {
    expect(body).toMatch(
      /href: '\/api\/cost-monitoring\/#read-the-estimate',\s*label: 'Read the estimate',\s*method: 'GET'/,
    );
    expect(body).not.toContain('/api/cost-monitoring/#read-your-cost');
  });

  it('S22.4 children shape spot-checks: sessions carries its 12 endpoint anchors in page order (full census + md lockstep live in the apps/docs docs-nav-endpoint-children-integrity suite)', () => {
    expect(body).toMatch(
      /href: '\/api\/sessions\/',\s*label: 'Sessions',\s*children: \[\s*\{ href: '\/api\/sessions\/#create', label: 'Create', method: 'POST' \},\s*\{ href: '\/api\/sessions\/#list', label: 'List', method: 'GET' \},/,
    );
    expect(body).toMatch(
      /\{ href: '\/api\/sessions\/#login', label: 'Login', method: 'POST' \},\s*\{ href: '\/api\/sessions\/#destroy', label: 'Destroy', method: 'DELETE' \},\s*\],/,
    );
    // S27 (2026-07-07) — status.md's heading-embedded method format was
    // normalized to declaration lines, so the anchor is the clean slug
    // (was '#snapshot--get-v1status' under the retired S22.4 format).
    expect(body).toMatch(
      /\{ href: '\/api\/status\/#snapshot', label: 'Snapshot', method: 'GET' \},/,
    );
  });

  it('Webhooks section: 4 entries (endpoints + events + crypto-events + replay); S27 — endpoints + replay carry children (webhooks extraction sweep); events + the S37 crypto-events page are catalogs with none', () => {
    expect(body).toMatch(
      /\{\s*label: 'Webhooks',\s*items: \[\s*\{\s*href: '\/webhooks\/endpoints\/',\s*label: 'Endpoints \(CRUD \+ rotate \+ test\)',\s*children: \[/,
    );
    expect(body).toMatch(
      /\{ href: '\/webhooks\/events\/', label: 'Event catalog' \},\s*\{ href: '\/webhooks\/crypto-events\/', label: 'Crypto order events' \},/,
    );
    expect(body).toMatch(
      /\{\s*href: '\/webhooks\/replay\/',\s*label: 'Replay deliveries',\s*children: \[\s*\{\s*href: '\/webhooks\/replay\/#replay-a-delivery',\s*label: 'Replay a delivery',\s*method: 'POST',/,
    );
  });

  it('Platform reference section (S22.2 un-orphaned the 6 /reference/* pages; S37 added emails + data-residency): errors → rate-limits → pagination → idempotency → scopes → metrics → emails → data-residency', () => {
    expect(body).toMatch(
      /\{\s*label: 'Platform reference',\s*items: \[\s*\{ href: '\/reference\/errors\/', label: 'Errors' \},\s*\{ href: '\/reference\/rate-limits\/', label: 'Rate limits' \},\s*\{ href: '\/reference\/pagination\/', label: 'Pagination' \},\s*\{ href: '\/reference\/idempotency\/', label: 'Idempotency keys' \},\s*\{ href: '\/reference\/scopes\/', label: 'API key scopes' \},\s*\{ href: '\/reference\/metrics\/', label: 'Prometheus metrics' \},\s*\{ href: '\/reference\/emails\/', label: 'Emails Driftstack sends' \},\s*\{ href: '\/reference\/data-residency\/', label: 'Data residency' \},\s*\],\s*\},/,
    );
  });

  it('V-1080 total tree size: 61 top-level routes + 145 child anchors — the agent-session LIST endpoint joined the tree, a live route all three SDKs wrap whose page carried no section for it. Including the archetype catalog and its list endpoint. V-847 raised it from 141 — V-843 documented the crypto quote and receipt endpoints and V-846 gave them nav children, but this census lives in a DIFFERENT file from the one V-846 raised, so it kept the old number', () => {
    const hrefs = [...body.matchAll(/href: '([^']+)',/g)].map((m) => m[1]!);
    const topLevel = hrefs.filter((h) => !h.includes('#'));
    const anchors = hrefs.filter((h) => h.includes('#'));
    expect(topLevel).toHaveLength(61);
    // +1 anchor: the organization taxonomy child added alongside `98d767a73`.
    // Refreshed after the endpoint-children integrity guard proved the tree
    // matches every page's h2 set exactly.
    expect(anchors).toHaveLength(145);
    // No duplicate hrefs at either level (the apps/docs
    // doc-nav-section-label-baseline suite enforces the top-level rule at
    // runtime too; mirrored here so a server-only run still catches it).
    expect(new Set(topLevel).size).toBe(61);
    // Set size must track the count — equality here is what proves NO duplicate
    // anchor was introduced along with the new child.
    expect(new Set(anchors).size).toBe(145);
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
