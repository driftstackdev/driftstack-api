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
//   • Acting-as banner: "All actions read + write that team's
//     resources" + "Switch back to self" button.
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
      /description = 'Driftstack — manage your account, profiles, sessions, and billing\.',/,
    );
    expect(body).toMatch(/withSidebar = true,/);
  });

  it('noindex robots meta (private app surface)', () => {
    expect(body).toMatch(/<meta name="robots" content="noindex" \/>/);
  });

  it('page-title pattern: "${title} · Driftstack"', () => {
    expect(body).toMatch(/const fullTitle = `\$\{title\} · Driftstack`;/);
  });

  it('11 navItems pinned in canonical order', () => {
    const block = body.match(/const navItems = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const entries = Array.from(block![1]!.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)).map(
      (m) => ({ href: m[1], label: m[2] }),
    );
    expect(entries).toEqual([
      { href: '/', label: 'Overview' },
      { href: '/profiles', label: 'Profiles' },
      { href: '/snapshots', label: 'Snapshots' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/api-keys', label: 'API keys' },
      { href: '/usage', label: 'Usage' },
      { href: '/billing', label: 'Billing' },
      { href: '/webhooks', label: 'Webhooks' },
      { href: '/audit-log', label: 'Audit log' },
      { href: '/team', label: 'Team' },
      { href: '/settings', label: 'Settings' },
    ]);
  });

  it('V-141 ds_web_session_token localStorage convention pinned + V-331 framing', () => {
    expect(body).toMatch(/V-331 — backend API base URL/);
    expect(body).toMatch(/localStorage uses `ds_web_session_token`/);
    expect(body).toMatch(/for the bearer \(V-141\)/);
    expect(body).toMatch(/`ds_act_as_account` for the\s*\n?\s*\/\/\s*optional team-owner override/);
  });

  it('R15 brand mark (/driftstack-mark.svg <img>) appears in both withSidebar=true sidebar + withSidebar=false header branches — replaces the prior bg-gradient-accent + shadow-glow-red D chip with the real iPhone-D SVG brand asset', () => {
    const markMatches = body.match(/src="\/driftstack-mark\.svg"/g);
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
    expect(body).toMatch(/class="hidden border-b border-white\/10 px-4 py-3"/);
    expect(body).toMatch(/<label\s*\n?\s*for="act-as-picker"/);
    expect(body).toMatch(/Acting as\s*\n?\s*<\/label>/);
    expect(body).toMatch(/<select\s*\n?\s*id="act-as-picker"\s*\n?\s*data-act-as-picker/);
  });

  it('"Acting as" banner: x-team-resources framing + "Switch back to self" button', () => {
    expect(body).toMatch(/data-act-as-banner/);
    expect(body).toMatch(
      /Acting as <span class="font-mono" data-act-as-owner>—<\/span>\. All actions read \+\s*\n?\s*write that team's resources/,
    );
    expect(body).toMatch(/data-act-as-clear/);
    expect(body).toMatch(/>\s*\n?\s*Switch back to self\s*\n?\s*</);
  });

  it('window.driftstackActAsHeaders() global helper exposed (x-driftstack-account header pickup)', () => {
    expect(body).toMatch(/window\.driftstackActAsHeaders = function/);
    expect(body).toMatch(/'x-driftstack-account': v/);
    expect(body).toMatch(/localStorage\.getItem\('ds_act_as_account'\)/);
  });

  it('GET /v1/account/me fetch populates picker (quiet failure leaves picker hidden)', () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/account\/me'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(body).toMatch(/swallow — picker stays hidden/);
  });

  it('picker self-only opt-out: empty teams array hides the widget', () => {
    expect(body).toMatch(
      /if \(!me \|\| !Array\.isArray\(me\.teams\) \|\| me\.teams\.length === 0\) return;/,
    );
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
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/privacy" class="hover:text-glow-red">Privacy<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/terms" class="hover:text-glow-red">Terms<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/dpa" class="hover:text-glow-red">DPA<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/aup" class="hover:text-glow-red">AUP<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/trust\/sub-processors" class="hover:text-glow-red"\s*\n?\s*>Sub-processors<\/a\s*>/,
    );
  });

  it('all 11 navItem targets exist as pages (no dangling sidebar links)', () => {
    const dir = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');
    expect(existsSync(resolve(dir, 'index.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'profiles.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'snapshots.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'sessions.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-keys.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'usage.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'billing.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'webhooks.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'audit-log.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'team.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'settings.astro'))).toBe(true);
  });

  it('active-route highlighting: pathname === href OR startsWith href+"/" → glow-red bg/text + inset-divider shadow', () => {
    expect(body).toMatch(
      /pathname === item\.href \|\| pathname\.startsWith\(item\.href \+ '\/'\)\s*\n?\s*\?\s*'bg-glow-red\/10 font-medium text-glow-red shadow-inset-divider'/,
    );
  });
});
