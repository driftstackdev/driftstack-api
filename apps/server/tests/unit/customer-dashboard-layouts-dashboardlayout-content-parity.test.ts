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

  it('2026-05-29 branded confirm modal: the [data-ds-confirm] overlay markup + the global window.driftstackConfirm(message, opts) → Promise<boolean> helper are present (the dashboard-wide replacement for native window.confirm — "no more alert boxes"). Drift here breaks every page that awaits driftstackConfirm before a destructive action', () => {
    expect(body).toMatch(/data-ds-confirm\b/);
    expect(body).toMatch(/data-ds-confirm-message/);
    expect(body).toMatch(/data-ds-confirm-ok/);
    expect(body).toMatch(/data-ds-confirm-cancel/);
    expect(body).toMatch(/window\.driftstackConfirm = function \(message, opts\)/);
    expect(body).toMatch(/return new Promise\(function \(resolve\)/);
  });

  it('2026-05-29 branded prompt modal: the [data-ds-prompt] overlay + text input + the global window.driftstackPrompt(message, opts) → Promise<string|null> helper are present (branded replacement for native window.prompt; null on Cancel/Escape, Enter submits). Drift breaks every page that awaits driftstackPrompt for text input', () => {
    expect(body).toMatch(/data-ds-prompt\b/);
    expect(body).toMatch(/data-ds-prompt-input/);
    expect(body).toMatch(/data-ds-prompt-ok/);
    expect(body).toMatch(/data-ds-prompt-cancel/);
    expect(body).toMatch(/window\.driftstackPrompt = function \(message, opts\)/);
    expect(body).toMatch(/data-ds-prompt-input\s+aria-label="Response"/);
  });

  it('2026-05-29 modal UX hardening: body scroll-lock while open + backdrop-click-to-dismiss — pinned so the branded modals behave like professional dialogs (no background scroll, click-outside cancels). Drift would regress the modals to a less-polished feel', () => {
    expect(body).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(body).toMatch(/document\.body\.style\.overflow = ''/);
    expect(body).toMatch(/if \(e\.target === overlay\)/);
  });

  it('notification SSE documents and uses the live EventSource query-token contract without launch-placeholder copy', () => {
    expect(body).toContain("'/v1/account/me/notifications?ds_token=' + encodeURIComponent(token)");
    expect(body).toContain('es = new EventSource(url);');
    expect(body).toContain("route's dedicated");
    expect(body).not.toMatch(/change deferred to v0\.2/i);
  });

  it('a11y focus restore: both modals capture the trigger (document.activeElement) on open and return focus to it on close — pinned so keyboard users keep their place after a confirm/prompt (WCAG 2.4.3 dialog pattern)', () => {
    // Two modals (confirm + prompt), each captures + restores once.
    expect(body.match(/var prevFocus = document\.activeElement;/g)?.length).toBe(2);
    expect(body.match(/if \(prevFocus && prevFocus\.focus\) prevFocus\.focus\(\);/g)?.length).toBe(
      2,
    );
  });

  it('a11y focus trap: both modals cycle Tab/Shift+Tab within their focusable controls so keyboard focus cannot escape to the page behind the overlay (WCAG 2.4.3 dialog pattern)', () => {
    expect(body.match(/if \(e\.key === 'Tab'\)/g)?.length).toBe(2);
    expect(body).toMatch(/e\.shiftKey && document\.activeElement === f\[0\]/);
  });

  it("Props interface 3-field shape: title (required) + description (optional default + Driftstack catchphrase) + withSidebar (optional default true). Drift to dropping withSidebar would force onboarding pages to render the side-nav (which requires auth that onboarding hasn't completed yet)", () => {
    expect(body).toMatch(
      /interface Props \{\s*title: string;\s*description\?: string;\s*\/\*\* When true, render the side-nav\. Onboarding pages opt out\. \*\/\s*withSidebar\?: boolean;\s*\}/,
    );
    expect(body).toMatch(
      /description = 'Driftstack — manage your account, API keys, and billing\.',/,
    );
    expect(body).toMatch(/withSidebar = true,/);
  });

  it('V-331 backend URL framing pinned: \'backend API base URL surfaced to the inline "act as" picker script. Per existing pages: localStorage uses ds_web_session_token for the bearer (V-141), and we add ds_act_as_account for the optional team-owner override.\' — pinned so the V-331 act-as cross-reference + V-141 token-storage cross-reference + the dual-key contract (token + act_as) stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-331 — backend API base URL surfaced to the inline "act as" picker\s*\/\/ script\. Per existing pages: localStorage uses `ds_web_session_token`\s*\/\/ for the bearer \(V-141\), and we add `ds_act_as_account` for the\s*\/\/ optional team-owner override\./,
    );
  });

  it('navItems 9-entry catalog pinned: Overview + API keys + Webhooks + Usage + Billing + Audit log + Team + Privacy & security + Settings (2026-07-02 account-portal IA, redesign slice 2 — the operational surfaces Profiles/Snapshots/Sessions/Agent sessions/Recipes/Proxies moved to the desktop GUI; Subscription left the nav ahead of its slice-3 merge into Billing but stays routable via the billing-page link; 2026-07-03 — /security split the Privacy & security surfaces out of /settings). Drift to dropping Team would break the V-298 team-RBAC navigation; sections are General / Developers / Account.', () => {
    const items: Array<[string, string]> = [
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
    for (const [href, label] of items) {
      expect(body, `${href} → ${label}`).toMatch(
        new RegExp(
          `\\{ href: '${href}', label: '${label}', icon: ICON\\.[a-z]+(?:, badgeKey: '[a-z]+')? \\}`,
        ),
      );
    }
    // The operational hrefs must be GONE from the nav (they 404 for the
    // account portal's job; the GUI owns them).
    for (const gone of [
      "'/profiles'",
      "'/snapshots'",
      "'/sessions'",
      "'/agent-sessions'",
      "'/recipes'",
      "'/proxies'",
      "'/subscription'",
    ]) {
      expect(body, `nav must not contain ${gone}`).not.toMatch(
        new RegExp(`href: ${gone.replace(/[/']/g, (c) => '\\' + c)}, label:`),
      );
    }
  });

  it("V-219* brand-alignment framing pinned: '- Sidebar header: L2 brand mark (driftstack-mark.svg) + the W2 DRIFTSTACK black-italic two-tone wordmark, matching apps/marketing-site/src/components/Header.astro (Fleet rebrand).' + '- withSidebar={false} branch: minimal horizontal header so onboarding pages have brand presence (Gap 2 from the V-219* audit) + ambient radial-glow background so the auth surfaces feel cohesive with the marketing landing.' + '- Footer (signed-in dashboard) with legal-doc links (Gap 7).' — pinned so the V-219* cross-app brand consistency + Gap 2 + Gap 7 references all survive", () => {
    expect(body).toMatch(
      /V-219\* — brand alignment with marketing site:\s*- Sidebar header: L2 brand mark \(driftstack-mark\.svg\) \+ the W2\s*DRIFTSTACK black-italic two-tone wordmark, matching\s*apps\/marketing-site\/src\/components\/Header\.astro \(Fleet rebrand\)\./,
    );
    expect(body).toMatch(
      /- withSidebar=\{false\} branch: minimal horizontal header so onboarding\s*pages have brand presence \(Gap 2 from the V-219\* audit\) \+\s*ambient radial-glow background/,
    );
    expect(body).toMatch(/- Footer \(signed-in dashboard\) with legal-doc links \(Gap 7\)\./);
  });

  it('Title composition pinned: `${title} · Driftstack` (interpunct + Driftstack). Drift to a different separator or branding would inconsistently render dashboard tabs', () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack`;/);
  });

  it('noindex,nofollow meta robots pinned + favicon at /driftstack-mark.svg?v=4. Drift to indexed=yes would let search engines crawl authenticated dashboard pages or follow private links (privacy regression); drift to a different favicon version would break the cache-bust strategy', () => {
    expect(body).toMatch(/<meta name="robots" content="noindex,nofollow" \/>/);
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg\?v=4"/,
    );
  });

  it("V-331 act-as picker + global helper framing pinned: 'Acting as picker. Hidden until JS confirms the user is on at least one team. Switching changes localStorage.ds_act_as_account + reloads the page so downstream fetches pick up the new X-Driftstack-Account header. Self-only customers never see this widget.' — pinned so the auto-hide-for-self-only contract + the reload-on-switch behavior stay documented (drift would either show the picker to single-user accounts OR fail to refresh downstream fetches)", () => {
    expect(body).toMatch(
      /V-331 — "Acting as" picker\. Hidden until JS confirms the\s*user is on at least one team\. Switching changes\s*localStorage\.ds_act_as_account \+ reloads the page so\s*downstream fetches pick up the new X-Driftstack-Account\s*header\. Self-only customers never see this widget\./,
    );
  });

  it('window.driftstackActAsHeaders is pre-slot, canonical-id-only, and locks to the verified owner after authority resolves', () => {
    const helperAt = body.indexOf('data-act-as-header-preflight');
    expect(helperAt).toBeGreaterThan(-1);
    expect(helperAt).toBeLessThan(body.indexOf('<slot />'));
    expect(body).toMatch(/window\.driftstackActAsHeaders = actAsHeaders/);
    expect(body).toMatch(/var provisionalOwner = readCanonicalStoredOwner\(\)/);
    expect(body).toMatch(
      /return provisionalOwner \? \{ 'x-driftstack-account': provisionalOwner \} : \{\};/,
    );
    expect(body).toMatch(
      /if \(authorityResolved\) \{\s*return verifiedOwner \? \{ 'x-driftstack-account': verifiedOwner \} : \{\};/,
    );
    expect(body).toMatch(/actAsHeaders\.setVerifiedOwner = function \(owner\)/);
  });

  it("V-331 'Acting as' banner pins provisional read-only, authoritative admin read+write, and authoritative member read-only copy", () => {
    expect(body).toMatch(
      /Team access is being verified\. Until then, treat this workspace as read-only\./,
    );
    expect(body).toContain("Admin access: read + write this team's resources.");
    expect(body).toContain("Member access: read-only for this team's resources.");
    expect(body).not.toMatch(/All actions read \+[\s\S]*?write that team's resources/);
    expect(body).toMatch(/data-act-as-clear/);
  });

  it('successful account authority admits one exact valid role row and fail-closes removed, duplicate, malformed, or zero-team owners before reload', () => {
    expect(body).toMatch(/!Array\.isArray\(me\.teams\)/);
    expect(body).toMatch(/candidate\.role === 'admin' \|\| candidate\.role === 'member'/);
    expect(body).toMatch(/teamCounts\.get\(candidate\.owner_account_id\) === 1/);
    expect(body).toMatch(/if \(active && !activeTeam\) \{\s*resetInvalidAuthority\(\);/);
    expect(body).toMatch(/setVerifiedOwner\(''\);\s*clearStoredOwner\(\);/);
    expect(body).toMatch(/main\.setAttribute\('inert', ''\)/);
    expect(body).toMatch(/window\.location\.reload\(\)/);
  });

  it('transport/non-auth HTTP failure keeps the provisional owner but publishes unverified read-only truth', () => {
    expect(body).toMatch(/if \(!r\.ok\) return \{ kind: 'unavailable' \};/);
    expect(body).toMatch(
      /if \(result\.kind === 'unavailable'\) \{\s*markAuthorityUnavailable\(\);/,
    );
    expect(body).toMatch(
      /could not be verified\. Treat this workspace as read-only until you reload/,
    );
  });

  it('clearBtn click handler removes ds_act_as_account from localStorage + reloads page. Drift to dropping the reload would leave downstream fetches still sending the stale x-driftstack-account header for the next page-life', () => {
    expect(body).toMatch(
      /clearBtn\.addEventListener\('click', function \(\) \{\s*try \{\s*localStorage\.removeItem\('ds_act_as_account'\);\s*\} catch \(_\) \{\s*\/\* swallow \*\/\s*\}\s*window\.location\.reload\(\);\s*\}\);/,
    );
  });

  it('Ambient radial-glow background only renders when withSidebar={false} (auth + onboarding pages); the sidebar pages have plenty of UI chrome so the ambient glow would be visually noisy. Drift would either flood every dashboard page with glow OR leave onboarding pages bare', () => {
    expect(body).toMatch(
      /\{!withSidebar && \(\s*<div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10">\s*<div class="absolute inset-x-0 top-0 h-\[600px\] bg-glow-radial-accent" \/>\s*<div class="absolute inset-x-0 bottom-0 h-\[400px\] bg-glow-radial-accent-soft" \/>\s*<\/div>\s*\)\}/,
    );
  });

  it("active-link styling pinned: pathname matching → highlighted (bg-tk-accent/10 + text-tk-accent-text + shadow-inset-divider; S23 2026-07-06 — active label is TEXT, so it reads the AA-safe accent-text tone). 2026-05-21 — exact match for '/' (so Overview doesn't highlight on every nested route) + prefix match for the rest. font-medium applied on BOTH active + inactive (constant width prevents click-induced layout shift).", () => {
    expect(body).toMatch(
      /item\.href === '\/'\s*\?\s*pathname === '\/'\s*:\s*pathname === item\.href \|\|\s*pathname\.startsWith\(item\.href \+ '\/'\)/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(/'bg-tk-accent\/10 text-tk-accent-text shadow-inset-divider'/);
    expect(body).toMatch(/text-sm font-medium transition-colors/);
  });
});
