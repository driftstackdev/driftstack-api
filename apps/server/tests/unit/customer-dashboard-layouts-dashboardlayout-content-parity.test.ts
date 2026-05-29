// Drift guard for apps/customer-dashboard/src/layouts/DashboardLayout.astro.
// Pins the V-219* brand-alignment framing + the V-331 act-as picker
// global helper (window.driftstackActAsHeaders) + the 14-item navItems
// catalog + the withSidebar={false} onboarding branch.
//
// Load-bearing: the inline driftstackActAsHeaders() function is consumed
// by EVERY dashboard page's authedFetch wrapper. Drift here silently
// breaks the team-scoped 'view as another account' flow on every page.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard layouts/DashboardLayout content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Props interface 3-field shape: title (required) + description (optional default + Driftstack catchphrase) + withSidebar (optional default true). Drift to dropping withSidebar would force onboarding pages to render the side-nav (which requires auth that onboarding hasn't completed yet)", () => {
    expect(body).toMatch(
      /interface Props \{\s*\n?\s*title: string;\s*\n?\s*description\?: string;\s*\n?\s*\/\*\* When true, render the side-nav\. Onboarding pages opt out\. \*\/\s*\n?\s*withSidebar\?: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /description = 'Driftstack — manage your account, profiles, sessions, and billing\.',/,
    );
    expect(body).toMatch(/withSidebar = true,/);
  });

  it('V-331 backend URL framing pinned: \'backend API base URL surfaced to the inline "act as" picker script. Per existing pages: localStorage uses ds_web_session_token for the bearer (V-141), and we add ds_act_as_account for the optional team-owner override.\' — pinned so the V-331 act-as cross-reference + V-141 token-storage cross-reference + the dual-key contract (token + act_as) stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-331 — backend API base URL surfaced to the inline "act as" picker\s*\n?\s*\/\/ script\. Per existing pages: localStorage uses `ds_web_session_token`\s*\n?\s*\/\/ for the bearer \(V-141\), and we add `ds_act_as_account` for the\s*\n?\s*\/\/ optional team-owner override\./,
    );
  });

  it('navItems 15-entry catalog pinned: Overview + Profiles + Snapshots + Sessions + Agent sessions + Recipes + API keys + Proxies + Usage + Billing + Subscription + Webhooks + Audit log + Team + Settings. Drift to dropping Agent sessions would orphan the AI-chat surface; drift to dropping Recipes would hide the AI-B4 recipe-library surface; drift to dropping Proxies would hide the EGRESS surface; drift to dropping Team would break the V-298 team-RBAC navigation. 2026-05-21 — items now carry an `icon` field + group into navSections (Browse / Connectivity / Account); each item still matched on (href, label) but with the new `, icon: ICON.X }` suffix.', () => {
    const items: Array<[string, string]> = [
      ['/', 'Overview'],
      ['/profiles', 'Profiles'],
      ['/snapshots', 'Snapshots'],
      ['/sessions', 'Sessions'],
      ['/agent-sessions', 'Agent sessions'],
      ['/recipes', 'Recipes'],
      ['/api-keys', 'API keys'],
      ['/proxies', 'Proxies'],
      ['/usage', 'Usage'],
      ['/billing', 'Billing'],
      ['/subscription', 'Subscription'],
      ['/webhooks', 'Webhooks'],
      ['/audit-log', 'Audit log'],
      ['/team', 'Team'],
      ['/settings', 'Settings'],
    ];
    for (const [href, label] of items) {
      expect(body, `${href} → ${label}`).toMatch(
        new RegExp(
          `\\{ href: '${href}', label: '${label}', icon: ICON\\.[a-z]+(?:, badgeKey: '[a-z]+')? \\},`,
        ),
      );
    }
  });

  it("V-219* brand-alignment framing pinned: '- Sidebar header: D-badge (gradient-accent) + lowercase font-mono \"driftstack\" wordmark matches apps/marketing-site/src/components/Header.astro pattern.' + '- withSidebar={false} branch: minimal horizontal header so onboarding pages have brand presence (Gap 2 from the V-219* audit) + ambient radial-glow background so the auth surfaces feel cohesive with the marketing landing.' + '- Footer (signed-in dashboard) with legal-doc links (Gap 7).' — pinned so the V-219* cross-app brand consistency + Gap 2 + Gap 7 references all survive", () => {
    expect(body).toMatch(
      /V-219\* — brand alignment with marketing site:\s*\n?\s*- Sidebar header: D-badge \(gradient-accent\) \+ lowercase font-mono\s*\n?\s*"driftstack" wordmark matches apps\/marketing-site\/src\/components\/\s*\n?\s*Header\.astro pattern\./,
    );
    expect(body).toMatch(
      /- withSidebar=\{false\} branch: minimal horizontal header so onboarding\s*\n?\s*pages have brand presence \(Gap 2 from the V-219\* audit\) \+\s*\n?\s*ambient radial-glow background/,
    );
    expect(body).toMatch(/- Footer \(signed-in dashboard\) with legal-doc links \(Gap 7\)\./);
  });

  it('Title composition pinned: `${title} · Driftstack` (interpunct + Driftstack). Drift to a different separator or branding would inconsistently render dashboard tabs', () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack`;/);
  });

  it('noindex meta robots pinned + favicon at /driftstack-mark.svg?v=2. Drift to indexed=yes would let Google crawl authenticated dashboard pages (privacy regression); drift to a different favicon version would break the cache-bust strategy', () => {
    expect(body).toMatch(/<meta name="robots" content="noindex" \/>/);
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=2"/,
    );
  });

  it("V-331 act-as picker + global helper framing pinned: 'Acting as picker. Hidden until JS confirms the user is on at least one team. Switching changes localStorage.ds_act_as_account + reloads the page so downstream fetches pick up the new X-Driftstack-Account header. Self-only customers never see this widget.' — pinned so the auto-hide-for-self-only contract + the reload-on-switch behavior stay documented (drift would either show the picker to single-user accounts OR fail to refresh downstream fetches)", () => {
    expect(body).toMatch(
      /V-331 — "Acting as" picker\. Hidden until JS confirms the\s*\n?\s*user is on at least one team\. Switching changes\s*\n?\s*localStorage\.ds_act_as_account \+ reloads the page so\s*\n?\s*downstream fetches pick up the new X-Driftstack-Account\s*\n?\s*header\. Self-only customers never see this widget\./,
    );
  });

  it("window.driftstackActAsHeaders global helper pinned: returns { 'x-driftstack-account': 'acc_<uuid>' } when active OR {} otherwise. Load-bearing — every authedFetch wrapper across the dashboard pages consumes this. Drift to a different header name would silently break team-scoped reads/writes on every page", () => {
    expect(body).toMatch(
      /window\.driftstackActAsHeaders = function \(\) \{\s*\n?\s*try \{\s*\n?\s*const v = localStorage\.getItem\('ds_act_as_account'\);\s*\n?\s*return v && v\.length > 0 \? \{ 'x-driftstack-account': v \} : \{\};\s*\n?\s*\} catch \(_\) \{\s*\n?\s*return \{\};\s*\n?\s*\}\s*\n?\s*\};/,
    );
  });

  it("V-331 'Acting as' indicator banner pinned: visible only when ds_act_as_account differs from self; copy 'Acting as <owner>. All actions read + write that team's resources.' + Clear button reloads page. Drift to dropping the banner would leave the customer unaware they're acting on a team-mate's account", () => {
    expect(body).toMatch(
      /\s*Acting as <span class="font-mono" data-act-as-owner>—<\/span>\. All actions read \+\s*\n?\s*write that team's resources\./,
    );
    expect(body).toMatch(/data-act-as-clear/);
  });

  it('clearBtn click handler removes ds_act_as_account from localStorage + reloads page. Drift to dropping the reload would leave downstream fetches still sending the stale x-driftstack-account header for the next page-life', () => {
    expect(body).toMatch(
      /clearBtn\.addEventListener\('click', function \(\) \{\s*\n?\s*try \{\s*\n?\s*localStorage\.removeItem\('ds_act_as_account'\);\s*\n?\s*\} catch \(_\) \{\s*\n?\s*\/\* swallow \*\/\s*\n?\s*\}\s*\n?\s*window\.location\.reload\(\);\s*\n?\s*\}\);/,
    );
  });

  it('Ambient radial-glow background only renders when withSidebar={false} (auth + onboarding pages); the sidebar pages have plenty of UI chrome so the ambient glow would be visually noisy. Drift would either flood every dashboard page with glow OR leave onboarding pages bare', () => {
    expect(body).toMatch(
      /\{!withSidebar && \(\s*\n?\s*<div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10">\s*\n?\s*<div class="absolute inset-x-0 top-0 h-\[600px\] bg-glow-radial-red" \/>\s*\n?\s*<div class="absolute inset-x-0 bottom-0 h-\[400px\] bg-glow-radial-red-soft" \/>\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
  });

  it("active-link styling pinned: pathname matching → highlighted (bg-glow-red/10 + text-glow-red + shadow-inset-divider). 2026-05-21 — exact match for '/' (so Overview doesn't highlight on every nested route) + prefix match for the rest. font-medium applied on BOTH active + inactive (constant width prevents click-induced layout shift).", () => {
    expect(body).toMatch(
      /item\.href === '\/'\s*\n?\s*\?\s*pathname === '\/'\s*\n?\s*:\s*pathname === item\.href \|\|\s*\n?\s*pathname\.startsWith\(item\.href \+ '\/'\)/,
    );
    expect(body).toMatch(/'bg-glow-red\/10 text-glow-red shadow-inset-divider'/);
    expect(body).toMatch(/text-sm font-medium transition-colors/);
  });
});
