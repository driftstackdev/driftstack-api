// W573.A — drift guard for /docs/marketing/dashboard-admin-visual-audit.md.
// V-219* PHASE-1 visual-consistency audit. Drift here either widens
// the small-scope token-application boundary, drops a gap from the
// 7-gap inventory, or weakens the V-211 anonymity zero-hits posture.
//
//   • V-219*. PHASE 1 audit. PHASE 2 redlines bounded.
//   • base.css byte-for-byte identical (dashboard ⟂ admin).
//   • 7 gaps: wordmark + onboarding-header + empty-state + loading +
//     status-badge + anonymity + dashboard-footer.
//   • PHASE 2: 3-4 layout files (DashboardLayout + AdminLayout +
//     no-sidebar branch + optional badge-colors hoist).
//   • Out-of-scope: logo design + new palette + new typography +
//     illustration + structural layout + marketing site.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/marketing/dashboard-admin-visual-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W573.A /docs/marketing/dashboard-admin-visual-audit.md content parity', () => {
  const body = read(LIB);

  it('Header + V-219*-PHASE-1 + small-scope-tokens-only + base.css-byte-identical + already-aligned framing pinned', () => {
    expect(body).toMatch(
      /^# `V-219\*` — customer-dashboard \+ admin-panel visual-consistency audit$/m,
    );
    expect(body).toMatch(/PHASE 1 of the `V-219\*` Tier 3 visual-consistency cycle\./);
    expect(body).toMatch(/Walks the/);
    expect(body).toMatch(/customer-dashboard \+ admin-panel surfaces against the marketing-site/);
    expect(body).toMatch(/reference design tokens, captures gaps, and proposes a small-scope/);
    expect(body).toMatch(/PHASE 2 redline set\./);
    expect(body).toMatch(/Per the V-211 anonymity policy, the audit also/);
    expect(body).toMatch(/checks for personal-name references on customer-facing surfaces\./);
    expect(body).toMatch(/> \*\*Scope is small\*\* — apply existing design tokens, not new brand/);
    expect(body).toMatch(/> work\. No graphical logo mark, no new colors, no new typography, no/);
    expect(body).toMatch(/> layout structural changes\./);
    expect(body).toMatch(/Existing tokens \(oxblood \+ slate \+/);
    expect(body).toMatch(
      /> emerald\/amber\/red\/blue \+ Geist Sans \+ Berkeley Mono\) already exist/,
    );
    expect(body).toMatch(/## What's already aligned \(no change needed\)/);
    expect(body).toMatch(/`apps\/customer-dashboard\/src\/styles\/base\.css` and/);
    expect(body).toMatch(
      /`apps\/admin-panel\/src\/styles\/base\.css` are \*\*byte-for-byte identical\*\*/,
    );
    expect(body).toMatch(/- `bg-slate-50` body background, `text-slate-900` foreground\./);
    expect(body).toMatch(/- `Geist Sans` body font \(with `cv11` \+ `ss01` features\)/);
    expect(body).toMatch(/- `::selection` background = `oxblood-700`, white text\./);
    expect(body).toMatch(/- `\.btn-primary` = oxblood-700 fill, white text, shadow-sm,/);
    expect(body).toMatch(/focus-ring oxblood-700\./);
    expect(body).toMatch(/\*\*Identical to marketing's `\.btn-primary`\.\*\*/);
    expect(body).toMatch(/\*\*Implication\*\*: the visual-consistency gap isn't a tokens gap —/);
    expect(body).toMatch(/it's a brand-treatment gap on a small set of header \/ wordmark \//);
    expect(body).toMatch(/empty-state copy locations\. PHASE 2 redlines are bounded\./);
  });

  it('Gap 1 (wordmark) + Gap 2 (onboarding header) + Gap 3 (empty state) + Gap 4 (loading) framing pinned', () => {
    expect(body).toMatch(/### Gap 1 — Wordmark treatment in app headers diverges from marketing/);
    expect(body).toMatch(
      /\*\*Marketing site header\*\* \(`apps\/marketing-site\/src\/components\/Header\.astro`\):/,
    );
    expect(body).toMatch(
      /- \*\*Oxblood-700 "D" badge\*\* — 28×28px rounded square, white "D" glyph\./,
    );
    expect(body).toMatch(/- \*\*Lowercase, font-mono "driftstack"\*\* wordmark\./);
    expect(body).toMatch(/\*\*Customer-dashboard sidebar header\*\*/);
    expect(body).toMatch(/- No badge\. Sentence-case "Driftstack"\. Sans-serif \(default body/);
    expect(body).toMatch(/font, not mono\)\./);
    expect(body).toMatch(/\*\*Admin-panel sidebar header\*\*/);
    expect(body).toMatch(/- No badge\. Sentence-case "Driftstack"\. Sans-serif\. Has an "admin"/);
    expect(body).toMatch(/font-mono uppercase pill in oxblood-50 \/ oxblood-700\./);
    expect(body).toMatch(/\*\*Verdict\*\*: Three different brand treatments across three surfaces/);
    expect(body).toMatch(/that should read as one product\./);
    expect(body).toMatch(/Marketing's "D-badge \+ lowercase/);
    expect(body).toMatch(/mono wordmark" is the established treatment per V-138 and is the/);
    expect(body).toMatch(/right alignment target\./);
    expect(body).toMatch(/\*\*PHASE 2 redline\*\*: replicate the marketing wordmark pattern in/);
    expect(body).toMatch(/both dashboard \+ admin sidebar headers\./);
    expect(body).toMatch(/Admin keeps the "admin"/);
    expect(body).toMatch(/pill alongside \(it's the staff-context indicator and earns the/);
    expect(body).toMatch(/visual differentiation\)\./);
    expect(body).toMatch(/### Gap 2 — Onboarding flow page headers also diverge/);
    expect(body).toMatch(
      /`apps\/customer-dashboard\/src\/pages\/\{signup,verify-email,welcome,select-tier,first-session\}\.astro`/,
    );
    expect(body).toMatch(/all set `withSidebar=\{false\}` on the layout, which means the side-nav/);
    expect(body).toMatch(/Visitors landing on `\/signup` see no Driftstack wordmark on the/);
    expect(body).toMatch(/page — just the form\./);
    expect(body).toMatch(/Marketing has a continuous header brand/);
    expect(body).toMatch(/presence across all pages\./);
    expect(body).toMatch(/\*\*PHASE 2 redline\*\*: when `withSidebar=\{false\}`, render a minimal/);
    expect(body).toMatch(/horizontal header with the same wordmark treatment as marketing/);
    expect(body).toMatch(/### Gap 3 — Empty-state copy tone is mostly aligned but not always/);
    expect(body).toMatch(/Spot-checked empty states across customer-dashboard:/);
    expect(body).toMatch(/- `\/sessions` "No sessions running" — direct, on-tone\. ✓/);
    expect(body).toMatch(/- `\/profiles` \(mock state\) — to verify when wired\./);
    expect(body).toMatch(/- `\/api-keys` — uses progressive enhancement; empty state copy/);
    expect(body).toMatch(/comes from inline script \(V-182\)\. On-tone in V-217\./);
    expect(body).toMatch(/- `\/webhooks` \(V-181 \+ V-185\) — direct, on-tone\. ✓/);
    expect(body).toMatch(/- `\/settings` \(V-217\) — Recent activity empty state reads:/);
    expect(body).toMatch(/> "No recent activity yet — your first key mint, session create,/);
    expect(body).toMatch(/> or other account event will appear here\."/);
    expect(body).toMatch(/No instances of overly-casual copy/);
    expect(body).toMatch(/The technical-direct tone established by the/);
    expect(body).toMatch(/V-180–V-194 wiring slices is consistent\./);
    expect(body).toMatch(/### Gap 4 — Loading \/ pending state visual consistency/);
    expect(body).toMatch(/Customer-dashboard pages use the V-180-pattern banner/);
    expect(body).toMatch(/\(`<div data-banner class="hidden \.\.\.">`\) \+ per-section loading/);
    expect(body).toMatch(/text\. Admin-panel pages use the same pattern \(V-187\+\)\./);
    expect(body).toMatch(/\*\*PHASE 2 redline\*\*: none required\./);
  });

  it('Gap 5-7 (status badge + anonymity V-211 + footer) + PHASE 2 surface + Out-of-scope + Verify framing pinned', () => {
    expect(body).toMatch(/### Gap 5 — Status badge palette consistency/);
    expect(body).toMatch(/- Customer `\/sessions` STATUS_BADGE: `creating: amber-50\/700`,/);
    expect(body).toMatch(/`ready: emerald-50\/700`, `busy: blue-50\/700`, `destroyed:/);
    expect(body).toMatch(/`errored: red-50\/700`\./);
    expect(body).toMatch(/- Admin `\/sessions` STATUS_BADGE: same mapping\./);
    expect(body).toMatch(/Color semantics consistent: emerald = good, amber = transient \//);
    expect(body).toMatch(/warning, red = error \/ blocked, slate = inert \/ completed, blue =/);
    expect(body).toMatch(/active-in-use\./);
    expect(body).toMatch(/\*\*PHASE 2 redline\*\*: optional small refactor — hoist `STATUS_BADGE`/);
    expect(body).toMatch(/maps into a shared constant in/);
    expect(body).toMatch(/`apps\/customer-dashboard\/src\/lib\/badge-colors\.ts` \(and admin/);
    expect(body).toMatch(/equivalent\)\./);
    expect(body).toMatch(/Not load-bearing; can defer post-launch\./);
    expect(body).toMatch(/### Gap 6 — Anonymity policy compliance check \(V-211\)/);
    expect(body).toMatch(/Grepped customer-dashboard \+ admin-panel pages and src for/);
    expect(body).toMatch(/`Joël \| Theunissen \| joeltheunissen89` references\. \*\*Zero hits\*\*/);
    expect(body).toMatch(/across both apps\. V-211 audit already cleaned these surfaces; no/);
    expect(body).toMatch(/backslide\./);
    expect(body).toMatch(/\*\*Verdict\*\*: clean\. No PHASE 2 work needed for anonymity\./);
    expect(body).toMatch(/### Gap 7 — Dashboard layout doesn't include a footer/);
    expect(body).toMatch(/Marketing site has a Footer component \(Privacy \/ ToS \/ DPA \/ AUP/);
    expect(body).toMatch(/For staff-only admin panel: no footer is fine\./);
    expect(body).toMatch(/Internal surface;/);
    expect(body).toMatch(/legal-doc links unnecessary\./);
    expect(body).toMatch(/For customer dashboard: the customer is signed-in to a billed/);
    expect(body).toMatch(/relationship — the legal-doc links should reachable from any/);
    expect(body).toMatch(/dashboard page \(per the Privacy Policy \+ DPA discoverability/);
    expect(body).toMatch(/expectation\)\./);
    expect(body).toMatch(/\*\*PHASE 2 redline\*\*: add a minimal footer to `DashboardLayout` —/);
    expect(body).toMatch(/slate-500 small text, links to `\/legal\/privacy` `\/legal\/terms`/);
    expect(body).toMatch(/`\/legal\/dpa` `\/legal\/aup` \(existing pages on `app\.driftstack\.io`/);
    expect(body).toMatch(/## PHASE 2 working-tree drafts — proposed surface/);
    expect(body).toMatch(
      /1\. \*\*`apps\/customer-dashboard\/src\/layouts\/DashboardLayout\.astro`\*\*/,
    );
    expect(body).toMatch(
      /— replace plain "Driftstack" sidebar wordmark with marketing's D-badge \+ lowercase mono "driftstack" treatment\./,
    );
    expect(body).toMatch(/Add a minimal footer with legal-doc links\./);
    expect(body).toMatch(/2\. \*\*`apps\/admin-panel\/src\/layouts\/AdminLayout\.astro`\*\*/);
    expect(body).toMatch(
      /— replace plain "Driftstack" with the same D-badge \+ lowercase mono wordmark, keeping the existing "admin" pill alongside\./,
    );
    expect(body).toMatch(
      /3\. \*\*`apps\/customer-dashboard\/src\/layouts\/DashboardLayout\.astro`\*\* \(no-sidebar branch\)/,
    );
    expect(body).toMatch(
      /— render a minimal horizontal header with the same wordmark when `withSidebar=\{false\}`/,
    );
    expect(body).toMatch(
      /4\. \(Optional\) `apps\/customer-dashboard\/src\/lib\/badge-colors\.ts` \+ admin equivalent/,
    );
    expect(body).toMatch(/— hoisting STATUS_BADGE maps into a shared constant\./);
    expect(body).toMatch(/That's 3 files for the PHASE 2 redline if we skip Gap 5 refactor;/);
    expect(body).toMatch(/4 files if included\./);
    expect(body).toMatch(/## Out of scope/);
    expect(body).toMatch(/- Graphical logo mark design \(text wordmark stays\)\./);
    expect(body).toMatch(/- New color palette \/ new accent colors\./);
    expect(body).toMatch(/- New typography \(Geist Sans \+ Berkeley Mono are locked\)\./);
    expect(body).toMatch(/- Custom illustration \/ photography \/ motion design\./);
    expect(body).toMatch(/- Layout structural changes \(existing page architecture stays\)\./);
    expect(body).toMatch(/- Marketing-site changes \(already done in V-214b\)\./);
    expect(body).toMatch(/## Verify/);
    expect(body).toMatch(/- `grep -rn -i "Joël\|Theunissen\|joeltheunissen"` across customer-/);
    expect(body).toMatch(/dashboard \+ admin-panel app sources: zero hits\./);
    expect(body).toMatch(/- Empty-state copy across audited pages: technical-direct tone,/);
    expect(body).toMatch(/- Status badge color mapping: consistent across pages within each/);
    expect(body).toMatch(/## Next/);
    expect(body).toMatch(/PHASE 2 working-tree drafts on the 3 layout files\. NOT committed/);
    expect(body).toMatch(/until founder redline pass\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
