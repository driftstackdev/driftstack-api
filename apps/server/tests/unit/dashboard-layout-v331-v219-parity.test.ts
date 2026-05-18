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
    expect(l).toMatch(
      /description = 'Driftstack — manage your account, profiles, sessions, and billing\.'/,
    );

    // Default withSidebar = true.
    expect(l).toMatch(/withSidebar = true,/);
  });

  it('CRITICAL 12-item navItems roster pinned. Drift to dropping/renaming would change the dashboard primary navigation across every page. The 12 items match the dashboard surface: Overview/Profiles/Snapshots/Sessions/Agent sessions/API keys/Usage/Billing/Webhooks/Audit log/Team/Settings. Arc 4 Wave 2.C sub-slice 8.24.b added Agent sessions between Sessions and API keys.', () => {
    const l = read(LAYOUT);

    const expected: Array<[string, string]> = [
      ['/', 'Overview'],
      ['/profiles', 'Profiles'],
      ['/snapshots', 'Snapshots'],
      ['/sessions', 'Sessions'],
      ['/agent-sessions', 'Agent sessions'],
      ['/api-keys', 'API keys'],
      ['/usage', 'Usage'],
      ['/billing', 'Billing'],
      ['/webhooks', 'Webhooks'],
      ['/audit-log', 'Audit log'],
      ['/team', 'Team'],
      ['/settings', 'Settings'],
    ];

    for (const [href, label] of expected) {
      expect(l, `nav ${href} → ${label}`).toMatch(
        new RegExp(`\\{ href: '${href}', label: '${label}' \\}`),
      );
    }
  });

  it('CRITICAL V-219* brand-alignment framing pinned. Sidebar header gets D-badge + lowercase font-mono "driftstack" wordmark matching marketing-site Header.astro pattern. The withSidebar:false branch gets a minimal horizontal header + ambient radial-glow background.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/V-219\* — brand alignment with marketing site:/);
    expect(l).toMatch(
      /Sidebar header: D-badge \(gradient-accent\) \+ lowercase font-mono\s*\n\s+"driftstack" wordmark matches apps\/marketing-site\/src\/components\/\s*\n\s+Header\.astro pattern/,
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

  it('CRITICAL Driftstack favicon at /driftstack-mark.svg?v=2 (cache-busted v=2). Drift to dropping the version-qstring would let stale-favicon caches persist across deploys.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=2" \/>/,
    );

    // 2 logo IMG references (sidebar + headerless-onboarding) both use v=2.
    const logoCount = (l.match(/\/driftstack-mark\.svg\?v=2/g) ?? []).length;
    expect(logoCount, 'driftstack-mark.svg?v=2 references').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL noindex robots meta pinned. The dashboard MUST NOT be indexed by search engines (per V-204+ standard for authenticated surfaces). Drift to dropping would let Google index customer URLs.', () => {
    const l = read(LAYOUT);
    expect(l).toMatch(/<meta name="robots" content="noindex" \/>/);
  });

  it('CRITICAL theme-color #0b0f14 pinned (matches dark theme + marketing-site). Drift to a different color would mismatch the splash screen + browser chrome on mobile.', () => {
    const l = read(LAYOUT);
    expect(l).toMatch(/<meta name="theme-color" content="#0b0f14" \/>/);
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

  it("CRITICAL V-331 window.driftstackActAsHeaders global helper pinned — returns { 'x-driftstack-account': 'acc_<uuid>' } when active OR {} when self. Inline-script pages call it when building fetch headers. Drift to a different return shape would break every consumer.", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/Exposes window\.driftstackActAsHeaders\(\) returning either/);
    expect(l).toMatch(/\{ 'x-driftstack-account': 'acc_<uuid>' \} or \{\}/);
    expect(l).toMatch(
      /window\.driftstackActAsHeaders = function \(\) \{\s*\n\s+try \{\s*\n\s+const v = localStorage\.getItem\('ds_act_as_account'\);\s*\n\s+return v && v\.length > 0 \? \{ 'x-driftstack-account': v \} : \{\};/,
    );
  });

  it('CRITICAL V-331 picker GET /v1/account/me fetch + me.teams branch pinned. Quiet failure (no token / network blip leaves the picker hidden) matches W742 graceful-degradation pattern.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/Fetch \/v1\/account\/me to populate the picker\./);
    expect(l).toMatch(/Quiet failure:/);
    expect(l).toMatch(/no token \/ network blip leaves the picker hidden/);

    // Implementation.
    expect(l).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*\n\s+headers: \{ authorization: 'Bearer ' \+ token \}/,
    );
    expect(l).toMatch(
      /if \(!me \|\| !Array\.isArray\(me\.teams\) \|\| me\.teams\.length === 0\) return/,
    );
  });

  it("CRITICAL V-331 picker options include 'Self' + each team owner with role. The Self option has empty value (which clears ds_act_as_account); each team has owner_account_id + role labeled.", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /const options = \[\{ value: '', label: 'Self \(' \+ \(me\.email \|\| me\.id\) \+ '\)' \}\]/,
    );
    expect(l).toMatch(
      /options\.push\(\{\s*\n\s+value: t\.owner_account_id,\s*\n\s+label: t\.owner_account_id \+ ' \(' \+ t\.role \+ '\)',/,
    );
  });

  it("CRITICAL V-331 clear button on banner pinned — clears ds_act_as_account + reloads. Same handler shape as picker-change. Drift would break the 'switch back to self' escape.", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(
      /clearBtn\.addEventListener\('click', function \(\) \{\s*\n\s+try \{\s*\n\s+localStorage\.removeItem\('ds_act_as_account'\);\s*\n\s+\} catch \(_\) \{[^}]*\}\s*\n\s+window\.location\.reload\(\);/,
    );
  });

  it("CRITICAL W211 footer-legal-URL absolute-host framing pinned. The marketing-site pages live on driftstack.dev, NOT the dashboard's app.driftstack.dev origin — absolute URLs are required (relative paths would 404 against Cloudflare Pages).", () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/W211 — these pages live on the marketing-site at/);
    expect(l).toMatch(/driftstack\.dev, not on the dashboard's own/);
    expect(l).toMatch(/app\.driftstack\.dev origin\. Absolute URLs are required;/);
    expect(l).toMatch(
      /relative paths would 404 against the Cloudflare Pages\s*\n\s+project that serves the dashboard/,
    );
  });

  it('CRITICAL footer 5-link roster pinned — Privacy + Terms + DPA + AUP + Sub-processors, all on https://driftstack.dev/legal/* (NOT relative paths). Cross-app URL parity with marketing-site.', () => {
    const l = read(LAYOUT);

    const links: Array<[string, string]> = [
      ['Privacy', 'https://driftstack.dev/legal/privacy'],
      ['Terms', 'https://driftstack.dev/legal/terms'],
      ['DPA', 'https://driftstack.dev/legal/dpa'],
      ['AUP', 'https://driftstack.dev/legal/aup'],
      ['Sub-processors', 'https://driftstack.dev/trust/sub-processors'],
    ];

    for (const [label, href] of links) {
      const escaped = href.replace(/\//g, '\\/');
      // Astro may wrap long-attribute anchors so the `>` lands on the
      // next line — allow whitespace between class-attribute close and
      // the opening `>` of the anchor.
      const re = new RegExp(`<a href="${escaped}"[\\s\\S]{0,150}>${label}<\\/a`);
      expect(l, `footer link ${label} → ${href}`).toMatch(re);
    }
  });

  it('CRITICAL DashboardLayout imports resolveApiBaseUrl helper (matches W742 single-source-of-truth pattern). Drift to inlining PUBLIC_API_BASE_URL would skip the prod-throw guard.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(l).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(l).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
  });

  it('CRITICAL active-nav-item highlighting pinned — `pathname === item.href || pathname.startsWith(item.href + "/")` for nested sub-pages. Drift to strict-equality only would let /sessions/abc123 NOT highlight the Sessions nav item.', () => {
    const l = read(LAYOUT);

    expect(l).toMatch(/pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-layout-v331-v219-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
