// W559.B — drift guard for /docs/architecture/customer-dashboard-stack.md.
// V-084 Tier-3 architectural proposal. Drift here either weakens the
// Astro+React-islands-recommendation (would re-open Next.js/Svelte/
// htmx debate), drops the 4-option-trade-off taxonomy, or loosens
// the founder-review-required gate.
//
//   • V-084. 2026-05-03. Proposal pending founder review.
//   • 5-surface inventory: marketing + dashboard + admin + onboarding
//     + GUI client.
//   • 4-option taxonomy: A=Astro+React-islands (recommended) +
//     B=Next.js (Vercel/CF) + C=SvelteKit + D=server-rendered+htmx.
//   • Decision authority: Tier-3 architectural, surfaces for review.
//   • 6 constraints: solo-team + server-side-auth + Stripe-redirect
//     + TS-stack + EU-residency + marketing-site-untouched.
//   • Astro+React-islands recommendation 5-reason.
//   • 4-out-of-scope (real-time + offline + PWA + i18n).
//   • 4-open-question for founder verdict.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/customer-dashboard-stack.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W559.B /docs/architecture/customer-dashboard-stack.md content parity', () => {
  const body = read(LIB);

  it("Header + V-084 + 5-surface inventory framing pinned: '# Customer dashboard — stack proposal' + '**Status:** Proposal pending founder review' + '**Date:** 2026-05-03' + '**Tier:** Architectural (vendor / structural — surfaces for review per Decision authority)' + '**Related V-entry:** V-084 (this proposal). Workstream C (admin panel) and Workstream F (onboarding flow) both consume the chosen stack.' + '**Marketing site** — `apps/marketing-site/`, Astro static-build on Cloudflace Pages.' + 'Already live (V-064-V-067).' + '**Customer dashboard** — does NOT exist yet.' + '**Admin panel** — does NOT exist yet. Workstream C.' + '**Onboarding flow** — does NOT exist yet. Workstream F.' + '**GUI client** — separate Tauri-based desktop app. Out of scope for this doc.' + 'The decision: **what stack do we use for surfaces 2 + 3 + 4?**' — pinned so the V-084-2026-05-03-pending + Tier-3-architectural-surfaces-review + Workstream-C-F-consume + 5-surface-inventory + 2+3+4-decision-scope commitment survives", () => {
    expect(body).toMatch(/^# Customer dashboard — stack proposal$/m);
    expect(body).toMatch(/\*\*Status:\*\* Proposal pending founder review/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(
      /\*\*Tier:\*\* Architectural \(vendor \/ structural — surfaces for review per Decision authority\)/,
    );
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-084 \(this proposal\)\. Workstream C \(admin panel\) and Workstream F \(onboarding flow\) both consume the chosen stack\./,
    );
    expect(body).toMatch(
      /\*\*Marketing site\*\* — `apps\/marketing-site\/`, Astro static-build on Cloudflace Pages\./,
    );
    expect(body).toMatch(/Already live \(V-064-V-067\)\./);
    expect(body).toMatch(/\*\*Customer dashboard\*\* — does NOT exist yet\./);
    expect(body).toMatch(/\*\*Admin panel\*\* — does NOT exist yet\. Workstream C\./);
    expect(body).toMatch(/\*\*Onboarding flow\*\* — does NOT exist yet\. Workstream F\./);
    expect(body).toMatch(
      /\*\*GUI client\*\* — separate Tauri-based desktop app\. Out of scope for this doc\./,
    );
    expect(body).toMatch(/The decision: \*\*what stack do we use for surfaces 2 \+ 3 \+ 4\?\*\*/);
  });

  it("6-constraint framing pinned: '**Solo engineering team.** Two stacks (one for marketing, one for dashboard) is already a maintenance cost' + '**Server-side auth.** The V-079 web-session model uses opaque token cookies' + '**Stripe Checkout / Customer Portal redirect.**' + '**Rest of stack is TypeScript.** SDK + control plane + marketing site all TS.' + '**EU residency.** Whatever runtime hosts the dashboard runs on EU infrastructure.' + 'Cloudflare Pages (Workers in EU regions), Hetzner (Helsinki/Falkenstein)' + '**Keep the marketing-site framing intact.** The marketing site stays Astro' + 'The dashboard is a separate sub-domain (`app.driftstack.dev`).' — pinned so the 6-constraint (solo-team + V-079-server-auth + Stripe-redirect + TS-stack + EU-residency-CF-Hetzner + marketing-untouched-app.driftstack.dev) commitment survives", () => {
    expect(body).toMatch(
      /- \*\*Solo engineering team\.\*\* Two stacks \(one for marketing, one for dashboard\) is already a maintenance cost/,
    );
    expect(body).toMatch(
      /- \*\*Server-side auth\.\*\* The V-079 web-session model uses opaque token cookies/,
    );
    expect(body).toMatch(/- \*\*Stripe Checkout \/ Customer Portal redirect\.\*\*/);
    expect(body).toMatch(
      /- \*\*Rest of stack is TypeScript\.\*\* SDK \+ control plane \+ marketing site all TS\./,
    );
    expect(body).toMatch(
      /- \*\*EU residency\.\*\* Whatever runtime hosts the dashboard runs on EU infrastructure\./,
    );
    expect(body).toMatch(
      /Cloudflare Pages \(Workers in EU regions\), Hetzner \(Helsinki\/Falkenstein\)/,
    );
    expect(body).toMatch(
      /- \*\*Keep the marketing-site framing intact\.\*\* The marketing site stays Astro/,
    );
    expect(body).toMatch(/The dashboard is a separate sub-domain \(`app\.driftstack\.dev`\)\./);
  });

  it("4-option taxonomy framing pinned: '### Option A — Astro + React islands (shared with marketing site)' + 'Same repo, separate Astro project at `apps/customer-dashboard/` with React-island interactivity' + '### Option B — Next.js (App Router) on Vercel or Cloudflare' + 'New `apps/customer-dashboard/` as a Next.js project. Server components + use-server for the read paths' + '### Option C — SvelteKit' + 'Drop-in alternative to Next.js with a smaller mental model + smaller bundle.' + '### Option D — Server-rendered HTML + htmx (no SPA framework)' + 'The Fastify control plane serves dashboard pages directly. htmx handles dynamic interactions' + 'Brand surface mismatch: marketing site is a polished Astro+Tailwind product' — pinned so the 4-option-taxonomy (A-Astro-shared + B-Next.js-Vercel/CF + C-SvelteKit + D-Fastify+htmx) commitment survives", () => {
    expect(body).toMatch(/### Option A — Astro \+ React islands \(shared with marketing site\)/);
    expect(body).toMatch(
      /Same repo, separate Astro project at `apps\/customer-dashboard\/` with React-island interactivity/,
    );
    expect(body).toMatch(/### Option B — Next\.js \(App Router\) on Vercel or Cloudflare/);
    expect(body).toMatch(
      /New `apps\/customer-dashboard\/` as a Next\.js project\. Server components \+ use-server for the read paths/,
    );
    expect(body).toMatch(/### Option C — SvelteKit/);
    expect(body).toMatch(
      /Drop-in alternative to Next\.js with a smaller mental model \+ smaller bundle\./,
    );
    expect(body).toMatch(/### Option D — Server-rendered HTML \+ htmx \(no SPA framework\)/);
    expect(body).toMatch(
      /The Fastify control plane serves dashboard pages directly\. htmx handles dynamic interactions/,
    );
    expect(body).toMatch(
      /Brand surface mismatch: marketing site is a polished Astro\+Tailwind product/,
    );
  });

  it("Recommendation 5-reason framing pinned: '## Recommendation' + '**Lean Option A (Astro + React islands)** for these reasons:' + '**Same toolchain as the marketing site.** Solo engineering team's biggest cost is context-switching.' + '**The dashboard's actual interactivity surface is shallow.** Most pages are read-mostly' + '**The onboarding flow's multi-step form** is the one place where Next.js would shine.' + 'Mitigation: build the onboarding flow as a single Astro page with a React form component that owns the state machine.' + '**Cloudflare Pages already wired** for the marketing site.' + 'The dashboard at `app.driftstack.dev` is a second Pages project pointing at `apps/customer-dashboard/`' + '**Brand surface continuity.** Same Tailwind tokens, same fonts, same oxblood accent.' + 'The decision is reversible: if the dashboard hits Astro's complexity ceiling' + 'the migration to Next.js is a matter of moving page components' — pinned so the Lean-Option-A + 5-reason (same-toolchain + shallow-interactivity + onboarding-form-mitigation + CF-Pages-wired + brand-continuity) + decision-reversible commitment survives", () => {
    expect(body).toMatch(/## Recommendation/);
    expect(body).toMatch(/\*\*Lean Option A \(Astro \+ React islands\)\*\* for these reasons:/);
    expect(body).toMatch(
      /1\. \*\*Same toolchain as the marketing site\.\*\* Solo engineering team's biggest cost is context-switching\./,
    );
    expect(body).toMatch(
      /2\. \*\*The dashboard's actual interactivity surface is shallow\.\*\* Most pages are read-mostly/,
    );
    expect(body).toMatch(
      /3\. \*\*The onboarding flow's multi-step form\*\* is the one place where Next\.js would shine\./,
    );
    expect(body).toMatch(
      /Mitigation: build the onboarding flow as a single Astro page with a React form component that owns the state machine\./,
    );
    expect(body).toMatch(/4\. \*\*Cloudflare Pages already wired\*\* for the marketing site\./);
    expect(body).toMatch(
      /The dashboard at `app\.driftstack\.dev` is a second Pages project pointing at `apps\/customer-dashboard\/`/,
    );
    expect(body).toMatch(
      /5\. \*\*Brand surface continuity\.\*\* Same Tailwind tokens, same fonts, same oxblood accent\./,
    );
    expect(body).toMatch(
      /The decision is reversible: if the dashboard hits Astro's complexity ceiling/,
    );
    expect(body).toMatch(/the migration to Next\.js is a matter of moving page components/);
  });

  it("4-out-of-scope + 4-open-question + decision-authority framing pinned: '## Out of scope for this proposal' + 'Real-time event streaming' + 'Offline support — dashboard requires connectivity; no offline mode planned.' + 'Mobile-app-shell experience — `app.driftstack.dev` is responsive HTML' + 'Internationalisation — English only at launch; Dutch + German follow' + '## Open questions for founder review' + '**Are the brand-design-system reuse benefits load-bearing for the choice?**' + '**Onboarding flow shape — single page with a state-machine React island, or multi-page MPA with one URL per step?**' + '**Cloudflare Pages vs Vercel for the dashboard runtime.** Cloudflare is already on the sub-processor list (V-052 lock)' + '**Admin panel co-locates or splits?**' + '## Decision authority' + 'This is **architectural / structural** — surfaces for founder review per the Decision authority section in AGENTS.md.' + 'No commit until founder confirms the recommendation (or redirects to one of B / C / D).' — pinned so the 4-out-of-scope (realtime + offline + PWA + i18n) + 4-open-question (brand-reuse + onboarding-shape + CF-vs-Vercel-V-052 + admin-co-locate) + architectural-no-commit-until-founder commitment survives", () => {
    expect(body).toMatch(/## Out of scope for this proposal/);
    expect(body).toMatch(/- Real-time event streaming/);
    expect(body).toMatch(
      /- Offline support — dashboard requires connectivity; no offline mode planned\./,
    );
    expect(body).toMatch(
      /- Mobile-app-shell experience — `app\.driftstack\.dev` is responsive HTML/,
    );
    expect(body).toMatch(/- Internationalisation — English only at launch; Dutch \+ German follow/);
    expect(body).toMatch(/## Open questions for founder review/);
    expect(body).toMatch(
      /1\. \*\*Are the brand-design-system reuse benefits load-bearing for the choice\?\*\*/,
    );
    expect(body).toMatch(
      /2\. \*\*Onboarding flow shape — single page with a state-machine React island, or multi-page MPA with one URL per step\?\*\*/,
    );
    expect(body).toMatch(
      /3\. \*\*Cloudflare Pages vs Vercel for the dashboard runtime\.\*\* Cloudflare is already on the sub-processor list \(V-052 lock\)/,
    );
    expect(body).toMatch(/4\. \*\*Admin panel co-locates or splits\?\*\*/);
    expect(body).toMatch(/## Decision authority/);
    expect(body).toMatch(
      /This is \*\*architectural \/ structural\*\* — surfaces for founder review per the Decision authority section in AGENTS\.md\./,
    );
    expect(body).toMatch(
      /No commit until founder confirms the recommendation \(or redirects to one of B \/ C \/ D\)\./,
    );
  });

  it('pins the five related architecture links plus the static Pages and private-cache posture', () => {
    expect(body).toMatch(/## Related docs/);
    expect(body).toMatch(
      /- `docs\/architecture\/team-roles-taxonomy\.md` \(V-142\) — owner \/ admin \/ member \/ viewer roles \+ scope mapping/,
    );
    expect(body).toMatch(
      /- `docs\/architecture\/webhook-system-design\.md` — webhook subscription \+ event-type model/,
    );
    expect(body).toMatch(
      /- `docs\/architecture\/api-versioning\.md` \(V-220\) — deprecation cycle for any UI-exposed breaking change/,
    );
    expect(body).toMatch(
      /- `docs\/api\/webhook-events\.md` \(V-203\) — canonical event-type catalog/,
    );
    expect(body).toMatch(
      /- `apps\/marketing-site\/public\/_headers` \+ `docs\/deployment\/cdn-strategy\.md` \(V-221\) — marketing and the static dashboard build/,
    );
    expect(body).toMatch(
      /the static dashboard build at `app\.driftstack\.dev` use Cloudflare Pages/,
    );
    expect(body).toMatch(/no customer data in generated HTML or publicly cacheable responses/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
