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
//   • W211 absolute https://driftstack.io/* legal-doc footer
//     links: Privacy / Terms / DPA / AUP / Sub-processors.
//   • Onboarding pages opt out via withSidebar={false}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no types in this workspace; every dashboard page test imports it this way
import { JSDOM } from 'jsdom';
import { SESSION_STOPPED_FALLBACK_TITLE, SESSION_STOPPED_TITLES } from '@driftstack/api-types';
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
    expect(body).toMatch(/`ds_act_as_account` for the\s*\/\/\s*optional team-owner override/);
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
    expect(body).toMatch(/<label\s*for="act-as-picker"/);
    expect(body).toMatch(/Acting as\s*<\/label>/);
    expect(body).toMatch(/<select\s*id="act-as-picker"\s*data-act-as-picker/);
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
    expect(body).toMatch(/>\s*Switch back to self\s*</);
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

  it('W211 absolute-URL footer 5 legal links to https://driftstack.io/* (Privacy / Terms / DPA / AUP / Sub-processors)', () => {
    expect(body).toMatch(/W211 — these pages live on the marketing-site at[\s\S]*?driftstack\.io/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.io\/legal\/privacy\/" class="hover:text-tk-accent-text">Privacy<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.io\/legal\/terms\/" class="hover:text-tk-accent-text">Terms<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.io\/legal\/dpa\/" class="hover:text-tk-accent-text">DPA<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.io\/legal\/aup\/" class="hover:text-tk-accent-text">AUP<\/a>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.io\/trust\/sub-processors\/" class="hover:text-tk-accent-text"\s*>Sub-processors<\/a\s*>/,
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
      /apiBaseUrl \+\s*'\/v1\/account\/me\/notifications\?ds_token=' \+ encodeURIComponent\(token\)/,
    );
    expect(body).toMatch(/new EventSource\(url\)/);
    expect(body).toMatch(/es\.addEventListener\(kind,/);
  });

  it('active-route highlighting: exact match for "/" (Overview) OR prefix match for the rest → glow-red bg/text + inset-divider shadow. 2026-05-21 — added the "/" exact-match exception so Overview no longer highlights on every nested route. font-medium now applied on BOTH active + inactive (constant width prevents click-induced layout shift); active state distinguished by bg + text color + inset divider only.', () => {
    expect(body).toMatch(
      /item\.href === '\/'\s*\?\s*pathname === '\/'\s*:\s*pathname === item\.href \|\|\s*pathname\.startsWith\(item\.href \+ '\/'\)/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(/'bg-tk-accent\/10 text-tk-accent-text shadow-inset-divider'/);
    // font-medium is now applied unconditionally on the <a> base class.
    expect(body).toMatch(/text-sm font-medium transition-colors/);
  });

  it('SECURITY — admin SSO bounce validates the redirect origin before attaching the #token= hash (no token exfiltration via ?next-admin=)', () => {
    // 2026-06-03 — the admin bounce builds the redirect from the
    // attacker-controllable ?next-admin= query param:
    //   new URL('https://admin.driftstack.io' + nextAdmin)
    // Without an origin check, nextAdmin=".evil.com/" or "@evil.com/"
    // parses to a non-admin host and the session token (#token=) would be
    // exfiltrated → account takeover. The guard below MUST stay: on any
    // host escape, reset to the admin root so the token only ever reaches
    // the real admin origin. Dropping it reopens the takeover.
    expect(body).toMatch(/'https:\/\/admin\.driftstack\.io' \+ nextAdmin/);
    expect(body).toMatch(/if \(u\.origin !== 'https:\/\/admin\.driftstack\.io'\) \{/);
    expect(body).toMatch(/u = new URL\('https:\/\/admin\.driftstack\.io\/'\);/);
    expect(body).toMatch(/u\.hash = '#token=' \+ encodeURIComponent\(t\)/);
    // The guard MUST precede the token-hash assignment in source order.
    const guardIdx = body.indexOf("if (u.origin !== 'https://admin.driftstack.io')");
    const hashIdx = body.indexOf("u.hash = '#token=' + encodeURIComponent(t)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(guardIdx);
  });
});

// ⛔ The banner for a stopped session printed its raw code:
// `'Session ' + id + ' stopped with an error: ' + event.errorClass`. A session
// with no proxy of its own now stops with `default_egress_unavailable`, and
// every proxy and connection code before it leaked the same way. The banner
// reads the SAME mapping the desktop app's notification title reads — the
// api-types table, handed to the inline script through `define:vars` — so the
// two surfaces cannot say different things about one stop.
//
// This arm RUNS the layout's own subscriber script, with the define:vars
// values the build would inject, against a fake EventSource, and reads what
// the banner shows. A source-text regex could not tell a mapped title from a
// raw token rendered next to one.
describe('the stopped-session banner says what happened, never the raw code', () => {
  const layout = read(LAYOUT);

  /** Every `<script is:inline define:vars={{ … }}>` block, with its var names. */
  function defineVarScripts(): { vars: string[]; body: string }[] {
    const out: { vars: string[]; body: string }[] = [];
    const re = /<script is:inline define:vars=\{\{([^}]*)\}\}>([\s\S]*?)<\/script>/g;
    for (let m = re.exec(layout); m !== null; m = re.exec(layout)) {
      out.push({
        vars: (m[1] ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== ''),
        body: m[2] ?? '',
      });
    }
    return out;
  }

  function subscriberScript(): { vars: string[]; body: string } {
    const found = defineVarScripts().filter((s) => s.body.includes('data-notification-banner'));
    expect(found, 'exactly one inline script subscribes the banner').toHaveLength(1);
    return found[0]!;
  }

  /** Run the subscriber as the build would (define:vars → consts in an IIFE)
   *  and return what the banner shows for one `session.errored` event. */
  function bannerFor(errorClass: string): { title: string; body: string; hidden: boolean } {
    const { vars, body } = subscriberScript();
    // The values the frontmatter hands over. A define:vars name this table does
    // not know is a wiring change this arm has not been taught — fail loudly.
    const known: Record<string, unknown> = {
      apiBaseUrl: 'https://api.example.test',
      SESSION_STOPPED_TITLES,
      SESSION_STOPPED_FALLBACK_TITLE,
    };
    for (const v of vars) expect(Object.keys(known), `define:vars name ${v}`).toContain(v);
    const dom = new JSDOM(
      '<!doctype html><div data-notification-banner class="hidden"><p data-notification-title></p><p data-notification-body></p><button data-notification-dismiss></button></div>',
      { runScripts: 'outside-only', url: 'https://dashboard.example.test/' },
    );
    const w = dom.window as unknown as {
      localStorage: Storage;
      EventSource: unknown;
      eval: (src: string) => unknown;
      document: Document;
    };
    w.localStorage.setItem('ds_web_session_token', 'tok');
    const listeners: Record<string, (e: { data: string }) => void> = {};
    w.EventSource = class {
      addEventListener(kind: string, fn: (e: { data: string }) => void): void {
        listeners[kind] = fn;
      }
      close(): void {}
    };
    const preamble = vars.map((v) => `const ${v} = ${JSON.stringify(known[v])};`).join('\n');
    w.eval(`(function () {\n${preamble}\n${body}\n})();`);
    const fire = listeners['session.errored'];
    expect(fire, 'the subscriber listens for session.errored').toBeTypeOf('function');
    fire!({
      data: JSON.stringify({
        kind: 'session.errored',
        accountId: 'acc_1',
        sessionId: 'as_1',
        errorClass,
        at: '2026-09-25T12:00:00.000Z',
      }),
    });
    const doc = w.document;
    return {
      title: doc.querySelector('[data-notification-title]')?.textContent ?? '',
      body: doc.querySelector('[data-notification-body]')?.textContent ?? '',
      hidden: doc.querySelector('[data-notification-banner]')?.classList.contains('hidden') ?? true,
    };
  }

  it('⛔ a failure of the connection Driftstack provides reads as that, not as its code', () => {
    const shown = bannerFor('default_egress_unavailable');
    expect(shown.hidden).toBe(false);
    expect(shown.title).toBe("A session stopped: Driftstack's connection failed");
    expect(`${shown.title} ${shown.body}`).not.toContain('default_egress_unavailable');
    expect(`${shown.title} ${shown.body}`).not.toMatch(/egress/i);
  });

  it('a refused proxy sign-in is named as that', () => {
    expect(bannerFor('proxy_auth_failed').title).toBe(
      'A session stopped: your proxy refused its sign-in',
    );
  });

  it('⛔ an unknown code reads as the generic title, never the raw token', () => {
    for (const code of ['zz_internal_thing', 'constructor', '__proto__']) {
      const shown = bannerFor(code);
      expect(shown.title, code).toBe('A session stopped');
      expect(shown.body, code).not.toContain(code);
    }
  });

  it('the banner and the desktop app read the SAME table — the layout imports it from api-types', () => {
    expect(layout).toMatch(
      /import \{[^}]*\bSESSION_STOPPED_TITLES\b[^}]*\} from '@driftstack\/api-types';/,
    );
    expect(subscriberScript().vars).toEqual(
      expect.arrayContaining(['SESSION_STOPPED_TITLES', 'SESSION_STOPPED_FALLBACK_TITLE']),
    );
  });
});
