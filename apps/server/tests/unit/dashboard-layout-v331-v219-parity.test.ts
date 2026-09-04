// W743 — customer-dashboard DashboardLayout.astro V-219* brand +
// V-331 acting-as + W211 footer-legal-URL parity. Sixty-ninth in the
// cross-SDK drift-guard series.
//
// DashboardLayout is consumed by every page in the dashboard (W735-
// W741 all use it). Drift in its 11-item nav roster, V-331 team-
// switcher behavior, or W211 footer URLs would propagate across the
// entire dashboard simultaneously.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

describe('W743 dashboard DashboardLayout V-219* + V-331 + W211 parity', () => {
  it('DashboardLayout.astro file exists', () => {
    expect(existsSync(LAYOUT)).toBe(true);
  });

  it('CRITICAL Props 3-field interface pinned — title (required) + description (optional, defaults to canonical Driftstack tagline) + withSidebar (optional, defaults true; onboarding pages opt out).', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /interface Props \{\s*\n\s+title: string;\s*\n\s+description\?: string;\s*\n\s+\/\*\* When true, render the side-nav\. Onboarding pages opt out\. \*\/\s*\n\s+withSidebar\?: boolean;\s*\n\}/,
    );

    // Default description.
    expect(l).toMatch(/description = 'Driftstack — manage your account, API keys, and billing\.'/);

    // Default withSidebar = true.
    expect(l).toMatch(/withSidebar = true,/);
  });

  it('CRITICAL nav-item roster pinned (Overview/API keys/Webhooks/Usage/Billing/Audit log/Team/Privacy & security/Settings). 2026-07-02 account-portal IA (redesign slice 2): the operational surfaces (Profiles/Snapshots/Sessions/Agent sessions/Recipes/Proxies) moved to the desktop GUI; Subscription left the nav ahead of its slice-3 merge into Billing. 2026-07-03 — /security (Privacy & security) split out of /settings. Items carry an icon field + group into navSections.', () => {
    const l = read(LAYOUT);

    const expected: Array<[string, string]> = [
      ['/', 'Overview'],
      ['/api-keys', 'API keys'],
      ['/webhooks', 'Webhooks'],
      ['/usage', 'Usage'],
      ['/billing', 'Billing'],
      ['/audit-log', 'Audit log'],
      ['/team', 'Team'],
      ['/security', 'Privacy & security'],
      ['/settings', 'Settings'],
    ];

    for (const [href, label] of expected) {
      expect(l, `nav ${href} → ${label}`).toMatch(
        new RegExp(
          `\\{ href: '${href}', label: '${label}', icon: ICON\\.[a-z]+(?:, badgeKey: '[a-z]+')? \\}`,
        ),
      );
    }
  });

  it('CRITICAL 3-section taxonomy pinned (General / Developers / Account). 2026-07-02 account-portal IA — the section labels are visible chrome and dropping any one collapses the IA.', () => {
    const l = read(LAYOUT);
    expect(l).toMatch(/label: 'General',/);
    expect(l).toMatch(/label: 'Developers',/);
    expect(l).toMatch(/label: 'Account',/);
  });

  it('CRITICAL V-219* brand-alignment framing pinned. Sidebar header gets the L2 brand mark + the W2 DRIFTSTACK two-tone wordmark matching marketing-site Header.astro (Fleet rebrand). The withSidebar:false branch gets a minimal horizontal header + ambient radial-glow background.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/V-219\* — brand alignment with marketing site:/);
    expect(l).toMatch(
      /Sidebar header: L2 brand mark \(driftstack-mark\.svg\) \+ the W2\s*\n\s+DRIFTSTACK black-italic two-tone wordmark, matching\s*\n\s+apps\/marketing-site\/src\/components\/Header\.astro \(Fleet rebrand\)/,
    );
    expect(l).toMatch(/withSidebar=\{false\} branch: minimal horizontal header so onboarding/);
    expect(l).toMatch(/ambient radial-glow background so the auth surfaces feel cohesive/);
  });

  it('CRITICAL ambient radial-glow background gated to !withSidebar. The "sidebar pages have plenty of UI chrome so the ambient glow would be visually noisy" wording justifies the gate; drift to always-show would add visual noise to the dashboard.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/only visible when withSidebar is false \(auth \+/);
    expect(l).toMatch(/The sidebar pages have plenty of UI chrome so the/);
    expect(l).toMatch(
      /\{!withSidebar && \(\s*\n\s+<div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10">/,
    );
  });

  it('CRITICAL Driftstack favicon at /driftstack-mark.svg?v=4 (cache-busted v=3, L2 rebrand bytes). Drift to dropping the version-qstring would let stale-favicon caches persist across deploys.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=4" \/>/,
    );

    // 2 logo IMG references (sidebar + headerless-onboarding) both use v=3.
    const logoCount = (l.match(/\/driftstack-mark\.svg\?v=4/g) ?? []).length;
    expect(logoCount, 'driftstack-mark.svg?v=4 references').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL noindex,nofollow robots meta pinned. The authenticated dashboard must neither be indexed nor contribute followed customer-URL links.', () => {
    const l = read(LAYOUT);
    const exactRobotsPolicy = /<meta name="robots" content="noindex,nofollow" \/>/;
    expect(l).toMatch(exactRobotsPolicy);
    expect(l.replace('noindex,nofollow', 'noindex')).not.toMatch(exactRobotsPolicy);
    expect(l.replace('noindex,nofollow', 'nofollow')).not.toMatch(exactRobotsPolicy);
  });

  it('CRITICAL theme-color #060608 pinned (the token layer dark --bg; Fleet v2 2026-07-02 aligned the meta to the actual dark surface — the old #0b0f14 predated the token layer). The pre-paint theme script + themer rewrite it to #f2f3f6 when light mode is active. Drift to a different color would mismatch the splash screen + browser chrome on mobile.', () => {
    const l = read(LAYOUT);
    expect(l).toMatch(/<meta name="theme-color" content="#060608" \/>/);
  });

  it('CRITICAL fullTitle pattern `${title} · Driftstack` pinned. The "·" (middle-dot) separator is canonical Driftstack-suffix.', () => {
    const l = read(LAYOUT);
    expect(l).toMatch(/const fullTitle = `\$\{title\} · Driftstack`/);
  });

  it('CRITICAL V-331 acting-as picker framing + 4-DOM-element wire pinned. Picker hides until JS confirms user is on >=1 team; switching writes ds_act_as_account + reloads; self-only customers never see the widget.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/V-331 — "Acting as" picker\. Hidden until JS confirms the/);
    expect(l).toMatch(/user is on at least one team\. Switching changes/);
    expect(l).toMatch(/localStorage\.ds_act_as_account \+ reloads the page so/);
    expect(l).toMatch(/downstream fetches pick up the new X-Driftstack-Account/);
    expect(l).toMatch(/header\. Self-only customers never see this widget/);

    // 4 DOM elements: wrap (hidden by default) + select picker + banner + clear button.
    expect(l).toMatch(/data-act-as-picker-wrap/);
    expect(l).toMatch(/data-act-as-picker/);
    expect(l).toMatch(/data-act-as-banner/);
    expect(l).toMatch(/data-act-as-clear/);
  });

  it('CRITICAL V-331 window.driftstackActAsHeaders is installed before <slot />, accepts only canonical stored owners, and locks to authoritative scope for the page life.', () => {
    const l = read(LAYOUT);

    const helperAt = l.indexOf('data-act-as-header-preflight');
    expect(helperAt).toBeGreaterThan(-1);
    expect(helperAt).toBeLessThan(l.indexOf('<slot />'));
    expect(l).toMatch(/var provisionalOwner = readCanonicalStoredOwner\(\)/);
    expect(l).toMatch(
      /return provisionalOwner \? \{ 'x-driftstack-account': provisionalOwner \} : \{\};/,
    );
    expect(l).toMatch(
      /if \(authorityResolved\) \{\s*return verifiedOwner \? \{ 'x-driftstack-account': verifiedOwner \} : \{\};/,
    );
    expect(l).toMatch(/actAsHeaders\.setVerifiedOwner = function \(owner\)/);
    expect(l).toMatch(/window\.driftstackActAsHeaders = actAsHeaders/);
  });

  it('CRITICAL V-331 picker authority distinguishes transport failure from accepted malformed authority, validates one exact owner+role row, and fail-closes stale scope.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/Fetch \/v1\/account\/me to populate the picker\./);
    expect(l).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*\n\s+headers: \{ authorization: 'Bearer ' \+ token \}/,
    );
    expect(l).toMatch(/if \(!r\.ok\) return \{ kind: 'unavailable' \};/);
    expect(l).toMatch(/if \(result\.kind === 'unavailable'\) \{\s*markAuthorityUnavailable\(\);/);
    expect(l).toMatch(/!Array\.isArray\(me\.teams\)/);
    expect(l).toMatch(/candidate\.role === 'admin' \|\| candidate\.role === 'member'/);
    expect(l).toMatch(/teamCounts\.get\(candidate\.owner_account_id\) === 1/);
    expect(l).toMatch(/if \(active && !activeTeam\) \{\s*resetInvalidAuthority\(\);/);
    expect(l).toMatch(/setVerifiedOwner\(activeTeam \? activeTeam\.owner_account_id : ''\)/);
    expect(l).toMatch(/main\.setAttribute\('inert', ''\)/);
    expect(l).toMatch(/window\.location\.reload\(\)/);
  });

  it("CRITICAL V-331 picker options include 'Self' + each team owner with role. The Self option has empty value (which clears ds_act_as_account); each team has owner_account_id + role labeled.", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /const options = \[\{ value: '', label: 'Self \(' \+ \(me\.email \|\| me\.id\) \+ '\)' \}\]/,
    );
    // The option VALUE (what gets written to ds_act_as_account) is still the
    // raw owner_account_id. The LABEL now shows a friendly workspace name via
    // ownerLabel(t) — owner_name / owner_email / owner_slug, falling back to
    // the opaque id — so a multi-team user can tell workspaces apart instead
    // of reading raw UUIDs. The role suffix is preserved.
    expect(l).toMatch(
      /function ownerLabel\(t\) \{\s*\n\s+const name = t\.owner_name \|\| t\.owner_email \|\| t\.owner_slug;\s*\n\s+return name \? String\(name\) : t\.owner_account_id;\s*\n\s+\}/,
    );
    expect(l).toMatch(
      /options\.push\(\{\s*\n\s+value: t\.owner_account_id,\s*\n\s+label: label \+ ' \(' \+ t\.role \+ '\)',/,
    );
  });

  it("CRITICAL V-331 clear button on banner pinned — clears ds_act_as_account + reloads. Same handler shape as picker-change. Drift would break the 'switch back to self' escape.", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /clearBtn\.addEventListener\('click', function \(\) \{\s*\n\s+try \{\s*\n\s+localStorage\.removeItem\('ds_act_as_account'\);\s*\n\s+\} catch \(_\) \{[^}]*\}\s*\n\s+window\.location\.reload\(\);/,
    );
  });

  it("CRITICAL W211 footer-legal-URL absolute-host framing pinned. The marketing-site pages live on driftstack.io, NOT the dashboard's app.driftstack.io origin — absolute URLs are required (relative paths would 404 against Cloudflare Pages).", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/W211 — these pages live on the marketing-site at/);
    expect(l).toMatch(/driftstack\.io, not on the dashboard's own/);
    expect(l).toMatch(/app\.driftstack\.io origin\. Absolute URLs are required;/);
    expect(l).toMatch(
      /relative paths would 404 against the Cloudflare Pages\s*\n\s+project that serves the dashboard/,
    );
  });

  it('CRITICAL footer 5-link roster pinned — Privacy + Terms + DPA + AUP + Sub-processors use canonical absolute marketing-site URLs (never dashboard-relative or redirecting paths).', () => {
    const l = read(LAYOUT);

    const links: Array<[string, string]> = [
      ['Privacy', 'https://driftstack.io/legal/privacy/'],
      ['Terms', 'https://driftstack.io/legal/terms/'],
      ['DPA', 'https://driftstack.io/legal/dpa/'],
      ['AUP', 'https://driftstack.io/legal/aup/'],
      ['Sub-processors', 'https://driftstack.io/trust/sub-processors/'],
    ];

    for (const [label, href] of links) {
      const escaped = href.replace(/\//g, '\\/');
      // Astro may wrap long-attribute anchors so the `>` lands on the
      // next line — allow whitespace between class-attribute close and
      // the opening `>` of the anchor.
      const re = new RegExp(`<a href="${escaped}"[\\s\\S]{0,150}>${label}<\\/a`);
      expect(l, `footer link ${label} → ${href}`).toMatch(re);
    }
    expect(l).not.toMatch(
      /href="https:\/\/driftstack\.io\/(?:legal\/(?:privacy|terms|dpa|aup)|trust\/sub-processors)"/,
    );
  });

  it('CRITICAL DashboardLayout imports resolveApiBaseUrl helper (matches W742 single-source-of-truth pattern). Drift to inlining PUBLIC_API_BASE_URL would skip the prod-throw guard.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(l).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(l).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
  });

  it('CRITICAL active-nav-item highlighting pinned. Exact match for "/" (Overview); prefix match for everything else so /sessions/abc123 still highlights the Sessions nav item. 2026-05-21 — the prefix-match clause now lives inside a ternary that exempts "/" (the Overview anchor) from prefix-matching every nested route (which otherwise stays highlighted across the entire dashboard).', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /item\.href === '\/'\s*\?\s*pathname === '\/'\s*:\s*pathname === item\.href \|\|\s*pathname\.startsWith\(item\.href \+ '\/'\)/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-layout-v331-v219-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
