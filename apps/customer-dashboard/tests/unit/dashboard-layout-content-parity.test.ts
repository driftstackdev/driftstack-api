// W382.A — drift guard for customer-dashboard DashboardLayout.astro.
// This is the biggest cross-cutting layout (293 lines), wrapping
// every customer-dashboard page (overview / api-keys / audit-log /
// auth / billing / cli / first-session / forgot-password / login /
// profiles / reset-password / select-tier / sessions / settings /
// signup / snapshots / subscription / team / usage / verify-email /
// webhooks / welcome / 404). Drift here affects every dashboard
// surface simultaneously. Existing dashboard-layout-* baselines
// cover landmarks + a11y; this guard pins the load-bearing
// V-141/V-219*/V-331/W211 wiring claims:
//
//   • noindex robots meta (private app surface).
//   • 11 navItems in canonical order.
//   • V-141 ds_web_session_token localStorage convention.
//   • V-219* D-badge + lowercase font-mono "driftstack" wordmark
//     (both withSidebar=true + withSidebar=false branches).
//   • V-331 "Acting as" picker: hidden by default, populated from
//     GET /v1/account/me teams; localStorage ds_act_as_account;
//     x-driftstack-account header. window.driftstackActAsHeaders()
//     global helper.
//   • Acting-as banner: verified admin read+write vs member read-only
//     authority + "Switch back to self" button.
//   • W211 absolute https://driftstack.dev/* legal-doc footer
//     links: Privacy / Terms / DPA / AUP / Sub-processors.
//   • Onboarding pages opt out via withSidebar={false}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W382.A customer-dashboard DashboardLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('Props interface: title required + optional description + optional withSidebar', () => {
    expect(body).toMatch(/interface Props \{/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/When true, render the side-nav\. Onboarding pages opt out\./);
    expect(body).toMatch(/withSidebar\?: boolean;/);
  });

  it('description fallback + withSidebar default true', () => {
    expect(body).toMatch(
      /description = 'Driftstack — manage your account, API keys, and billing\.',/,
    );
    expect(body).toMatch(/withSidebar = true,/);
  });

  it('noindex,nofollow robots meta (private app surface)', () => {
    expect(body).toMatch(/<meta name="robots" content="noindex,nofollow" \/>/);
  });

  it('shared confirm + prompt modals use one cross-type lease and release it only on close', () => {
    expect(body.match(/typeof window\.__driftstackModalOpen !== 'boolean'/g)).toHaveLength(2);
    expect(body).toMatch(
      /if \(window\.__driftstackModalOpen\) \{\s*resolve\(false\);\s*return;\s*\}/,
    );
    expect(body).toMatch(
      /if \(window\.__driftstackModalOpen\) \{\s*resolve\(null\);\s*return;\s*\}/,
    );
    expect(body.match(/window\.__driftstackModalOpen = true;/g)).toHaveLength(2);
    expect(
      body.match(/function done\(result\) \{\s*window\.__driftstackModalOpen = false;/g),
    ).toHaveLength(2);
    expect(body).not.toMatch(/var (?:confirm|prompt)Open/);
  });

  it('destructive confirms require an explicit OK click: focus Cancel and swallow Enter', () => {
    expect(body).toMatch(/var destructive = !!\(opts && opts\.destructive\);/);
    expect(body).toMatch(
      /if \(destructive\) \{\s*if \(cancel && cancel\.focus\) cancel\.focus\(\);/,
    );
    expect(body).toMatch(
      /if \(destructive && e\.key === 'Enter'\) \{ e\.preventDefault\(\); return; \}/,
    );
  });

  it('typed prompts ignore backdrop clicks so incidental taps cannot discard form state', () => {
    const promptStart = body.indexOf('window.driftstackPrompt = function');
    const promptEnd = body.indexOf('</script>', promptStart);
    const prompt = body.slice(promptStart, promptEnd);

    expect(prompt).not.toContain("overlay.addEventListener('click', onOverlay)");
    expect(prompt).not.toContain('function onOverlay');
    expect(prompt).toContain("cancel.addEventListener('click', onCancel)");
    expect(prompt).toContain("if (e.key === 'Escape') { done(null); return; }");
  });

  it('page-title pattern: "${title} · Driftstack"', () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack`;/);
  });

  it('9 navItems pinned in canonical order (2026-07-02 account-portal IA, dashboard redesign slice 2: the operational surfaces — /profiles /snapshots /sessions /agent-sessions /recipes /proxies — moved to the desktop GUI; /subscription left the nav ahead of its slice-3 merge into /billing but stays routable via the billing-page link; 2026-07-03 slice added /security — the Privacy & security page split out of /settings). Sections: General / Developers / Account; parser scans navSections for (href, label) entries.', () => {
    // Scan the navSections array. Items carry an `icon` field; match
    // (href, label) pairs across all sections, preserving encounter order.
    const block = body.match(/const navSections: NavSection\[\] = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const entries = Array.from(
      block![1]!.matchAll(
        /\{ href: '([^']+)', label: '([^']+)', icon: ICON\.[a-z]+(?:, badgeKey: '[a-z]+')? \}/g,
      ),
    ).map((m) => ({ href: m[1], label: m[2] }));
    expect(entries).toEqual([
      { href: '/', label: 'Overview' },
      { href: '/api-keys', label: 'API keys' },
      { href: '/webhooks', label: 'Webhooks' },
      { href: '/usage', label: 'Usage' },
      { href: '/billing', label: 'Billing' },
      { href: '/audit-log', label: 'Audit log' },
      { href: '/team', label: 'Team' },
      { href: '/security', label: 'Privacy & security' },
      { href: '/settings', label: 'Settings' },
    ]);
  });

  it('V-141 ds_web_session_token localStorage convention pinned + V-331 framing', () => {
    expect(body).toMatch(/V-331 — backend API base URL/);
    expect(body).toMatch(/localStorage uses `ds_web_session_token`/);
    expect(body).toMatch(/for the bearer \(V-141\)/);
    expect(body).toMatch(/`ds_act_as_account` for the\s*\n?\s*\/\/\s*optional team-owner override/);
  });

  it('R15 brand mark (/driftstack-mark.svg <img>) appears in both withSidebar=true sidebar + withSidebar=false header branches — replaces the prior bg-gradient-accent + shadow-glow-accent D chip with the real iPhone-D SVG brand asset', () => {
    const markMatches = body.match(/src="\/driftstack-mark\.svg(\?v=\d+)?"/g);
    expect(markMatches).not.toBeNull();
    expect(markMatches!.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/V-219\* — brand alignment with marketing site:/);
  });

  it('withSidebar={false} minimal-header branch present (onboarding pages)', () => {
    expect(body).toMatch(/!withSidebar && \(/);
    expect(body).toMatch(/withSidebar={false} branch: minimal horizontal header so onboarding/);
  });

  it('V-331 "Acting as" picker: hidden by default + label + select element', () => {
    expect(body).toMatch(/V-331 — "Acting as" picker/);
    expect(body).toMatch(/data-act-as-picker-wrap/);
    expect(body).toMatch(/class="hidden border-b border-tk-border px-4 py-3"/);
    expect(body).toMatch(/<label\s*\n?\s*for="act-as-picker"/);
    expect(body).toMatch(/Acting as\s*\n?\s*<\/label>/);
    expect(body).toMatch(/<select\s*\n?\s*id="act-as-picker"\s*\n?\s*data-act-as-picker/);
  });

  it('"Acting as" banner: provisional read-only + exact verified role truth + clear control', () => {
    expect(body).toMatch(/data-act-as-banner/);
    expect(body).toMatch(
      /Team access is being verified\. Until then, treat this workspace as read-only\./,
    );
    expect(body).toContain("Admin access: read + write this team's resources.");
    expect(body).toContain("Member access: read-only for this team's resources.");
    expect(body).not.toContain("All actions read +\n                write that team's resources.");
    expect(body).toMatch(/data-act-as-clear/);
    expect(body).toMatch(/>\s*\n?\s*Switch back to self\s*\n?\s*</);
  });

  it('window.driftstackActAsHeaders() is installed before <slot /> and accepts canonical owner ids only', () => {
    const helperAt = body.indexOf('data-act-as-header-preflight');
    const slotAt = body.indexOf('<slot />');
    expect(helperAt).toBeGreaterThan(-1);
    expect(helperAt).toBeLessThan(slotAt);
    expect(body).toMatch(/window\.driftstackActAsHeaders = actAsHeaders/);
    expect(body).toMatch(/var provisionalOwner = readCanonicalStoredOwner\(\)/);
    expect(body).toMatch(
      /return provisionalOwner \? \{ 'x-driftstack-account': provisionalOwner \} : \{\};/,
    );
    expect(body).toMatch(/localStorage\.getItem\('ds_act_as_account'\)/);
    expect(body).toMatch(/\^acc_\[0-9a-f\]\{8\}/);
    expect(body).toMatch(
      /if \(authorityResolved\) \{\s*return verifiedOwner \? \{ 'x-driftstack-account': verifiedOwner \} : \{\};/,
    );
  });

  it('GET /v1/account/me fetch populates picker while transport failure retains provisional read-only scope', () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/account\/me'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(body).toMatch(/markAuthorityUnavailable\(\)/);
    expect(body).toMatch(/could not be verified\. Treat this workspace as read-only/);
  });

  it('successful authority validates exact unique owner+role and reload-locks removed/malformed owners', () => {
    expect(body).toMatch(/!Array\.isArray\(me\.teams\)/);
    expect(body).toMatch(/candidate\.role === 'admin' \|\| candidate\.role === 'member'/);
    expect(body).toMatch(/teamCounts\.get\(candidate\.owner_account_id\) === 1/);
    expect(body).toMatch(/if \(active && !activeTeam\) \{\s*resetInvalidAuthority\(\);/);
    expect(body).toMatch(/main\.setAttribute\('inert', ''\)/);
    expect(body).toMatch(/window\.location\.reload\(\)/);
    expect(body).toMatch(/setVerifiedOwner\(activeTeam \? activeTeam\.owner_account_id : ''\)/);
  });

  it('picker change → localStorage set + page reload (no SPA-like inline update)', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_act_as_account', v\)/);
    expect(body).toMatch(/window\.location\.reload\(\)/);
  });

  it('Self option in picker: "Self (${me.email || me.id})" framing', () => {
    expect(body).toMatch(/'Self \(' \+ \(me\.email \|\| me\.id\) \+ '\)'/);
  });

  it('W211 absolute-URL footer 5 legal links to https://driftstack.dev/* (Privacy / Terms / DPA / AUP / Sub-processors)', () => {
    expect(body).toMatch(
      /W211 — these pages live on the marketing-site at\s*\n?\s*[\s\S]*?driftstack\.dev/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/privacy\/" class="hover:text-tk-accent-text">Privacy<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/terms\/" class="hover:text-tk-accent-text">Terms<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/dpa\/" class="hover:text-tk-accent-text">DPA<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/aup\/" class="hover:text-tk-accent-text">AUP<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/trust\/sub-processors\/" class="hover:text-tk-accent-text"\s*\n?\s*>Sub-processors<\/a\s*>/,
    );
  });

  it('all 9 navItem targets exist as pages (no dangling sidebar links; 2026-07-02 account-portal IA — the operational pages moved to the desktop GUI)', () => {
    const dir = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');
    expect(existsSync(resolve(dir, 'index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-keys.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'webhooks.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'usage.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'billing.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'audit-log.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'team.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'security.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'settings.astro'))).toBe(true);
    // The retired operational pages must be GONE (they now 404→/ via _redirects).
    for (const gone of [
      'profiles.astro',
      'snapshots.astro',
      'sessions.astro',
      'recipes.astro',
      'proxies.astro',
      'first-session.astro',
    ]) {
      expect(existsSync(resolve(dir, gone)), `${gone} should be deleted`).toBe(false);
    }
  });

  it('2026-05-20 notification SSE banner present + 4-kind subscriber + dismiss affordance', () => {
    expect(body).toMatch(/data-notification-banner/);
    expect(body).toMatch(/data-notification-title/);
    expect(body).toMatch(/data-notification-body/);
    expect(body).toMatch(/data-notification-dismiss/);
    expect(body).toMatch(/notification SSE banner\./);
    expect(body).toMatch(/notification SSE subscriber\./);
    expect(body).toMatch(/'cost\.threshold_alert',/);
    expect(body).toMatch(/'incident\.broadcast',/);
    expect(body).toMatch(/'audit\.high_severity',/);
    expect(body).toMatch(/'session\.errored',/);
    // SSE: EventSource can't set an Authorization header, so the bearer
    // token rides in the ?ds_token= query param (server-side
    // requireAuthEventSource reads it) — same contract as the transcript
    // stream. Drift back to ?token= would 401 every notification connect.
    expect(body).toMatch(
      /apiBaseUrl \+\s*\n?\s*'\/v1\/account\/me\/notifications\?ds_token=' \+ encodeURIComponent\(token\)/,
    );
    expect(body).toMatch(/new EventSource\(url\)/);
    expect(body).toMatch(/es\.addEventListener\(kind,/);
  });

  it('active-route highlighting: exact match for "/" (Overview) OR prefix match for the rest → glow-red bg/text + inset-divider shadow. 2026-05-21 — added the "/" exact-match exception so Overview no longer highlights on every nested route. font-medium now applied on BOTH active + inactive (constant width prevents click-induced layout shift); active state distinguished by bg + text color + inset divider only.', () => {
    expect(body).toMatch(
      /item\.href === '\/'\s*\n?\s*\?\s*pathname === '\/'\s*\n?\s*:\s*pathname === item\.href \|\|\s*\n?\s*pathname\.startsWith\(item\.href \+ '\/'\)/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(/'bg-tk-accent\/10 text-tk-accent-text shadow-inset-divider'/);
    // font-medium is now applied unconditionally on the <a> base class.
    expect(body).toMatch(/text-sm font-medium transition-colors/);
  });

  it('SECURITY — admin SSO bounce validates the redirect origin before attaching the #token= hash (no token exfiltration via ?next-admin=)', () => {
    // 2026-06-03 — the admin bounce builds the redirect from the
    // attacker-controllable ?next-admin= query param:
    //   new URL('https://admin.driftstack.dev' + nextAdmin)
    // Without an origin check, nextAdmin=".evil.com/" or "@evil.com/"
    // parses to a non-admin host and the session token (#token=) would be
    // exfiltrated → account takeover. The guard below MUST stay: on any
    // host escape, reset to the admin root so the token only ever reaches
    // the real admin origin. Dropping it reopens the takeover.
    expect(body).toMatch(/'https:\/\/admin\.driftstack\.dev' \+ nextAdmin/);
    expect(body).toMatch(/if \(u\.origin !== 'https:\/\/admin\.driftstack\.dev'\) \{/);
    expect(body).toMatch(/u = new URL\('https:\/\/admin\.driftstack\.dev\/'\);/);
    expect(body).toMatch(/u\.hash = '#token=' \+ encodeURIComponent\(t\)/);
    // The guard MUST precede the token-hash assignment in source order.
    const guardIdx = body.indexOf("if (u.origin !== 'https://admin.driftstack.dev')");
    const hashIdx = body.indexOf("u.hash = '#token=' + encodeURIComponent(t)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(guardIdx);
  });
});
