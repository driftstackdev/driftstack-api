// W-2026-09-21b — drift guard for the stage-2 visual upgrade (design brief:
// docs.internal a2-ai-view/stage-everywhere/DESIGN-BRIEF.md §1/§3; stage-1
// guard: stage1-elevation-and-state-light-baseline.test.ts). Stage 2 closes
// the gap the stage-1 report named as its own "stage 2 candidates":
//
//   1. .stat-card/.panel promoted from --shadow-ambient to --shadow-lift
//      (home page — one unified elevation feel with the quick-action/trust
//      cards stage 1 already lifted).
//   2. .tk-well — a light pooled at an .auth-card's top-left corner,
//      breathing by opacity only, applied to the pages a new or returning
//      customer meets first (login/signup/verify-email/reset-password).
//   3. [data-tk-state='muted'] — the "absence of light" tone, wired into
//      billing.astro's subscription-status badge alongside the existing
//      STATUS_BADGE_CLASS text/colour system (active/trialing → ready,
//      past_due/unpaid/incomplete → busy, everything else → muted).
//   4. usage.astro's stat figures + capture-breakdown rows get the AI
//      view's "one soft headline figure, small hard facts" hierarchy.
//   5. webhooks.astro's delivery-log loading state, the one plain-text
//      "Loading…" left in an app that otherwise uses pulsing skeletons
//      everywhere else, now matches that convention.
//   6. settings.astro's hydration reveal: window.dashboardHydrated is
//      defined by a LATER <script> in DashboardLayout (document order), so
//      this page's two call sites were silent no-ops that always fell back
//      to the layout's 1200ms safety timer — measured in a real browser at
//      ~1224ms before the fix, ~20-170ms after (comparable to pages that
//      gate the same call behind an async fetch). Fixed locally (no change
//      to the shared layout script) by deferring the call to
//      DOMContentLoaded, which fires only once every parser-blocking
//      script — including the layout's later one — has run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASH = resolve(REPO_ROOT, 'apps/customer-dashboard');
const BASE_CSS = resolve(DASH, 'src/styles/base.css');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}
function page(name: string): string {
  return read(resolve(DASH, 'src/pages', name));
}

describe('customer dashboard stage-2 elevation + well + state-light baseline', () => {
  const css = read(BASE_CSS);

  it('.stat-card and .panel are promoted to --shadow-lift (not left at --shadow-ambient)', () => {
    expect(css).toMatch(/\.stat-card\s*\{\s*@apply[^}]*shadow-lift/);
    expect(css).toMatch(/\.panel\s*\{\s*@apply[^}]*shadow-lift/);
    // The promotion must be real, not additive — neither class may still
    // carry the old ambient token (that would mean two shadows stacked,
    // not a promotion).
    expect(css).not.toMatch(/\.stat-card\s*\{\s*@apply[^}]*shadow-ambient\b/);
    expect(css).not.toMatch(/\.panel\s*\{\s*@apply[^}]*shadow-ambient\b/);
  });

  it('.tk-well pools a light at the top-left corner, breathing by opacity only, with an explicit reduced-motion still', () => {
    expect(css).toMatch(/\.tk-well\s*\{\s*position:\s*relative;\s*isolation:\s*isolate;\s*\}/);
    const afterBlock = css.match(/\.tk-well::after\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? '';
    expect(afterBlock).toMatch(/z-index:\s*-1;/);
    expect(afterBlock).toMatch(/animation:\s*hero-glow-pulse\s+9s\s+var\(--tk-ease\)\s+infinite;/);
    // opacity-only: no transform/scale property anywhere in the device.
    expect(afterBlock).not.toMatch(/transform:/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tk-well::after\s*\{\s*animation:\s*none;\s*opacity:[^;]+;/,
    );
  });

  it("[data-tk-state='muted'] extends the state-light vocabulary with the absence-of-light tone", () => {
    expect(css).toMatch(/\[data-tk-state='muted'\]\s*\{\s*--tk-state-rgb:\s*var\(--ink-3-rgb\);/);
  });

  for (const [file, label] of [
    ['login.astro', 'login'],
    ['signup.astro', 'signup'],
    ['verify-email.astro', 'verify-email'],
    ['reset-password.astro', 'reset-password'],
  ] as const) {
    it(`${label}.astro's auth-card carries tk-well (the first-run-wizard "stage well" treatment)`, () => {
      const body = page(file);
      expect(body).toMatch(/class="auth-card mt-8 tk-well"/);
    });
  }

  it('welcome.astro and the other non-primary auth-card pages are untouched — tk-well is scoped to the four named entry pages only', () => {
    const welcome = page('welcome.astro');
    expect(welcome).toMatch(/class="auth-card"/);
    expect(welcome).not.toMatch(/tk-well/);
  });

  it('billing.astro wires [data-tk-state] onto the subscription badge: active/trialing read as ready, past_due/unpaid/incomplete read as busy, everything else (including the SSR default) reads as muted — colour is reinforcement, the badge TEXT stays the authoritative signal', () => {
    const body = page('billing.astro');
    // SSR default.
    expect(body).toMatch(/data-field="sub-status-badge"\s*\n\s*data-tk-state="muted"/);
    // Live-JS mapping — a small map alongside STATUS_BADGE_CLASS, not a
    // rewrite of it (STATUS_BADGE_CLASS itself is pinned byte-for-byte by
    // dashboard-billing-page-v183-v331b-parity.test.ts in apps/server).
    const stateLight = body.match(/const STATE_LIGHT = \{([\s\S]*?)\};/)?.[1] ?? '';
    expect(stateLight).toMatch(/active:\s*'ready'/);
    expect(stateLight).toMatch(/trialing:\s*'ready'/);
    expect(stateLight).toMatch(/past_due:\s*'busy'/);
    expect(stateLight).toMatch(/unpaid:\s*'busy'/);
    expect(stateLight).toMatch(/incomplete:\s*'busy'/);
    // canceled/incomplete_expired/paused/no_subscription are deliberately
    // absent from STATE_LIGHT — they fall through to the 'muted' default.
    expect(stateLight).not.toMatch(/canceled:/);
    expect(body).toMatch(
      /el\.setAttribute\('data-tk-state',\s*STATE_LIGHT\[toneKey\]\s*\|\|\s*'muted'\);/,
    );
    // STATUS_BADGE_CLASS itself must stay byte-identical (the apps/server
    // parity pin depends on it) — this guard fails loudly if this file's
    // edit ever touches that object instead of adding beside it.
    expect(body).toMatch(
      /const STATUS_BADGE_CLASS: Record<string, string> = \{\s*active: 'bg-tk-ready\/10 text-tk-ready-text',/,
    );
  });

  it("usage.astro's four tile figures and the two capture-breakdown rows are the soft headline figure (font-light, tabular-nums); their labels stay the small hard fact (font-mono uppercase)", () => {
    const body = page('usage.astro');
    for (const stat of ['session_minute', 'navigate', 'interact', 'captures_total']) {
      expect(body).toMatch(
        new RegExp(`text-3xl font-light tabular-nums text-tk-ink" data-stat="${stat}"`),
      );
    }
    for (const stat of ['screenshot_capture', 'state_capture']) {
      expect(body).toMatch(
        new RegExp(`text-xl font-light tabular-nums text-tk-ink" data-stat="${stat}"`),
      );
    }
    // The capture-breakdown dt labels moved to the same mono/uppercase/hard
    // treatment the tile labels above already use, so the two sections read
    // as one hierarchy system rather than two different ones.
    expect(body).toMatch(
      /<dt class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">Screenshots<\/dt>/,
    );
  });

  it("webhooks.astro's delivery log has no bare-text loading state left — both the SSR placeholder and the live re-fetch use the same pulsing skeleton the rest of the app uses", () => {
    const body = page('webhooks.astro');
    expect(body).not.toMatch(/Loading deliveries…/);
    expect(body).not.toMatch(/>Loading…</);
    expect(body).toMatch(/function deliverySkeleton\(\)\s*\{/);
    // Both call sites route through the same skeleton function (not two
    // independent copies that could drift apart): 1 definition + 2 calls.
    const occurrences = body.match(/deliverySkeleton\(\)/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it('audit-log + webhook-delivery rows share one interactive rhythm: both row templates carry the same hover treatment', () => {
    const auditLog = page('audit-log.astro');
    const webhooks = page('webhooks.astro');
    expect(auditLog).toMatch(/<li class="px-6 py-3 transition-colors hover:bg-tk-hover">/);
    expect(webhooks).toMatch(
      /<li class="-mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-tk-hover">/,
    );
  });

  it("settings.astro's two dashboardHydrated call sites both route through callDashboardHydrated (DOMContentLoaded-gated) rather than a bare synchronous/microtask call that races the layout's own later <script>", () => {
    const body = page('settings.astro');
    expect(body).toMatch(/function callDashboardHydrated\(\)\s*\{/);
    expect(body).toMatch(
      /if \(document\.readyState === 'loading'\)\s*\{\s*document\.addEventListener\('DOMContentLoaded', fire, \{ once: true \}\);/,
    );
    // Both call sites use the helper.
    const callSites = body.match(/callDashboardHydrated\(\);/g) ?? [];
    expect(callSites.length).toBe(2);
    // The old racy patterns are gone, not just supplemented.
    expect(body).not.toMatch(
      /queueMicrotask\(function \(\) \{\s*if \(typeof window\.dashboardHydrated/,
    );
  });
});
