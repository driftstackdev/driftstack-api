// W572.B — drift guard for /docs/proposals/post-launch/v-184b-onboarding-visual-scope.md.
// V-184b Tier-3 scope outline 2026-05-05. Drift here either weakens
// the autopilot-NEVER-decides-T3 boundary, drops a per-page section
// from the 5-page (signup→verify-email→welcome→select-tier→
// first-session) flow, or unsets the [FOUNDER COPY] redline markers.
//
//   • V-184b. Tier 3 scope outline. NOT customer-facing copy.
//   • Per autopilot guardrails: T3 NEVER autonomously decide.
//   • 5 onboarding pages with structural-changes + [FOUNDER COPY].
//   • V-219* PHASE 3 patterns already approved (minimal header +
//     oxblood-700 + DashboardLayout footer).
//   • select-tier highest T3 sensitivity ($-amounts; pricing locked
//     numbers in driftstack-repo file 127).
//   • OUT of scope: login flow + telemetry + /billing redesign.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/proposals/post-launch/v-184b-onboarding-visual-scope.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W572.B /docs/proposals/post-launch/v-184b-onboarding-visual-scope.md content parity', () => {
  const body = read(LIB);

  it('Header + Tier-3 scope outline + autopilot-direction-2026-05-05 + 5-page V-184a baseline + Why-scope-proposal framing pinned', () => {
    expect(body).toMatch(/^# V-184b — Onboarding visual UX scope proposal$/m);
    expect(body).toMatch(/\*\*Status:\*\* Tier 3 scope outline — surfaces for founder redline\./);
    expect(body).toMatch(/Contains NO autonomously-drafted customer-facing copy;/);
    expect(body).toMatch(/lists the \*\*structural shape\*\* of what V-184b would change,/);
    expect(body).toMatch(
      /marks each Tier 3 copy decision with `\[FOUNDER COPY\]` so the redline pass is bounded\./,
    );
    expect(body).toMatch(/\*\*Source:\*\* Autopilot direction 2026-05-05/);
    expect(body).toMatch(
      /"V-184b Tier 3 onboarding visual UX \(founder-redline Tier 3 — DRAFT working-tree only, NOT commit; founder reviews on wake\)"\./,
    );
    expect(body).toMatch(
      /\*\*V-184a baseline:\*\* `apps\/customer-dashboard\/src\/pages\/\{signup,verify-email,welcome,select-tier,first-session\}\.astro`/,
    );
    expect(body).toMatch(/— all five Tier 1 scaffolding pages exist with minimal placeholder UX\./);
    expect(body).toMatch(/## Why a scope proposal instead of a working-tree draft/);
    expect(body).toMatch(
      /Per autopilot guardrails: "T3 \(security architecture, customer data handling, pricing\/\$-numbers, marketing language\): NEVER autonomously decide\./,
    );
    expect(body).toMatch(/If encountered, draft \+ surface for founder, move to next T1\."/);
    expect(body).toMatch(/V-184b is largely customer-facing copy \+ visual decisions\./);
    expect(body).toMatch(
      /Drafting actual `\.astro` content would mean making autonomous Tier 3 calls on tone, hierarchy, conversion messaging, and brand voice\./,
    );
    expect(body).toMatch(/## Already-approved patterns to apply uniformly/);
    expect(body).toMatch(
      /- \*\*Minimal horizontal header\*\* \(D-badge \+ `font-mono` "driftstack" wordmark\) — `withSidebar=\{false\}` in `DashboardLayout\.astro` already does this\./,
    );
    expect(body).toMatch(/All five onboarding pages currently use it; verified ✓\./);
    expect(body).toMatch(
      /- \*\*Oxblood-700 brand accent\*\* for primary CTAs \+ active states \(already in `base\.css`\)\./,
    );
    expect(body).toMatch(
      /- \*\*Footer with Privacy \/ Terms \/ DPA \/ AUP \/ Sub-processors\*\* — `DashboardLayout\.astro` already renders this\./,
    );
    expect(body).toMatch(/Onboarding pages inherit ✓\./);
  });

  it('Per-page scope outline 1-3 (signup + verify-email + welcome) framing pinned', () => {
    expect(body).toMatch(/### 1\. `signup\.astro`/);
    expect(body).toMatch(/\*\*Structural changes the autopilot can safely propose:\*\*/);
    expect(body).toMatch(
      /- Add a `progress-step` component \(visual: 5-step indicator with current step highlighted in oxblood-700\) at top of the form panel\./,
    );
    expect(body).toMatch(
      /Same pattern across all 5 onboarding pages\. Founder picks: highlighted vs filled-bar style\./,
    );
    expect(body).toMatch(
      /- Add an inline link to `\/legal\/terms` \+ `\/legal\/privacy` near the submit button/,
    );
    expect(body).toMatch(
      /Server side: legal-acceptance gate \(V-049\) handles the API-key issuance gate;/,
    );
    expect(body).toMatch(/signup itself doesn't require explicit consent UI per current design\./);
    expect(body).toMatch(/\*\*Tier 3 copy redlines needed:\*\*/);
    expect(body).toMatch(/- `\[FOUNDER COPY\]` Headline: currently "Sign up"\./);
    expect(body).toMatch(
      /Redline against marketing voice — currently no brand voice document exists for the dashboard surface/,
    );
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Subhead: currently "Create your Driftstack account\. After signup we'll email you a verification code; one signup per email\."/,
    );
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Password helper: currently "12\+ characters\. Use a passphrase\." — could elaborate on passphrase recommendation OR add a real-time strength indicator/,
    );
    expect(body).toMatch(/### 2\. `verify-email\.astro`/);
    expect(body).toMatch(/- Same progress-step indicator \(step 2\/5\)\./);
    expect(body).toMatch(/- "Resend verification email" link \(~30s lockout to prevent abuse\)\./);
    expect(body).toMatch(
      /Currently the page accepts a token paste-in; should also offer a resend trigger that hits `POST \/v1\/auth\/signup` with the same email\./,
    );
    expect(body).toMatch(/Founder approval needed for resend rate-limit cadence \+ UX copy\./);
    expect(body).toMatch(/- "Wrong email\?" link → `\/signup` to start over\./);
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Error states: invalid token \/ expired token \/ already-verified\./,
    );
    expect(body).toMatch(/### 3\. `welcome\.astro`/);
    expect(body).toMatch(/- Same progress-step indicator \(step 3\/5\)\./);
    expect(body).toMatch(
      /- "What's next" callouts pointing at the next steps \(select tier → first session\)\./,
    );
    expect(body).toMatch(/Could be 2-card or 3-card layout\./);
    expect(body).toMatch(
      /- Optional: link to docs \/ quickstart for self-directed customers who want to skip ahead\./,
    );
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Welcome message — most marketing-voice-sensitive page in the flow\./,
    );
  });

  it('Per-page scope 4-5 (select-tier + first-session) + Cross-page + OUT-of-scope + Recommended-next-step framing pinned', () => {
    expect(body).toMatch(/### 4\. `select-tier\.astro`/);
    expect(body).toMatch(
      /\*\*Tier 3 sensitivity is HIGHEST on this page\*\* — this is where the customer commits to a tier with \$-amount visible\./,
    );
    expect(body).toMatch(
      /Per autopilot guardrails: "pricing\/\$-numbers: NEVER autonomously decide\."/,
    );
    expect(body).toMatch(
      /\*\*Structural changes the autopilot can safely propose \(NO pricing-touching\):\*\*/,
    );
    expect(body).toMatch(/- Same progress-step indicator \(step 4\/5\)\./);
    expect(body).toMatch(/- Tier comparison shape — table vs card-row vs vertical-list\./);
    expect(body).toMatch(/Founder picks; autopilot does NOT pick\./);
    expect(body).toMatch(
      /- "Start with trial pack" CTA must be visually distinct from "Skip to paid tier" path/,
    );
    expect(body).toMatch(/\(per ADR-003 — trial pack is the recommended onboarding path\)\./);
    expect(body).toMatch(/\*\*Tier 3 copy \+ numeric redlines:\*\*/);
    expect(body).toMatch(
      /- `\[FOUNDER COPY \+ PRICING\]` Tier names \+ descriptions \+ \$-amounts\./,
    );
    expect(body).toMatch(
      /Per founder's locked tier-3-explicit-values memory, the canonical numbers live in `driftstack-repo` file 127/,
    );
    expect(body).toMatch(
      /— autopilot must not invent any numbers here\. Source: `packages\/api-types\/src\/capabilities\.ts`/,
    );
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Trial-pack pitch \(\$2\.99 \/ 14 days \/ \$0\.18-per-hour decrement per ADR-003 — those numbers are locked, but the pitch language is open\)\./,
    );
    expect(body).toMatch(/### 5\. `first-session\.astro`/);
    expect(body).toMatch(/- Same progress-step indicator \(step 5\/5 = "you're done!"\)\./);
    expect(body).toMatch(
      /- Two-pane layout: code snippet on the left, visual session-running placeholder on the right\./,
    );
    expect(body).toMatch(
      /- "Reveal API key \(one-time\)" button — once revealed \+ copied, the key is gone from the UI\./,
    );
    expect(body).toMatch(/Currently the page has the API key minted from the previous step;/);
    expect(body).toMatch(
      /surfacing pattern needs founder approval \(one-shot reveal vs persistent display vs auto-copy\)\./,
    );
    expect(body).toMatch(/- Code snippet language switcher \(TypeScript \/ Python \/ cURL\)\./);
    expect(body).toMatch(
      /- `\[FOUNDER COPY\]` Code snippet copy — needs to be production-correct \(uses `@driftstack\/sdk` the right way\)/,
    );
    expect(body).toMatch(
      /AND demo-friendly \(returns visible output the customer can verify in <30s\)\./,
    );
    expect(body).toMatch(/## Cross-page consistency proposals/);
    expect(body).toMatch(
      /- \*\*Progress-step component\*\* — propose a single `<OnboardingSteps step=\{N\} of=\{5\} \/>` Astro component/,
    );
    expect(body).toMatch(
      /lives in `apps\/customer-dashboard\/src\/components\/onboarding-steps\.astro`\./,
    );
    expect(body).toMatch(/Founder picks visual: dots \/ numbered chips \/ horizontal bar \/ etc\./);
    expect(body).toMatch(
      /- \*\*Help \/ contact link\*\* in the minimal header \(so customers stuck mid-flow can reach support\)/,
    );
    expect(body).toMatch(
      /— needs founder decision on what link points at \(existing `\/contact` doesn't exist; `support@driftstack\.dev` mailto:\?\)\./,
    );
    expect(body).toMatch(
      /- \*\*Visual hierarchy alignment\*\* — confirm signup\.astro's `text-3xl font-semibold tracking-tight` heading style is the canonical onboarding-page headline/,
    );
    expect(body).toMatch(/\(vs e\.g\. `text-4xl`\)\. Apply uniformly\./);
    expect(body).toMatch(/## What's deliberately OUT of scope for V-184b/);
    expect(body).toMatch(/- Login flow \(`\/login` page exists as href but no implementation\)\./);
    expect(body).toMatch(
      /V-184a notes flagged this as "V-184b or separate V-NNN"; recommend separate V-entry to avoid scope creep\./,
    );
    expect(body).toMatch(
      /- Onboarding flow telemetry \(drop-off-per-step metrics\)\. Tier 1 work; not visual\./,
    );
    expect(body).toMatch(
      /- Dashboard `\/billing` page redesign \(tied to billing flow, separate from onboarding\)\./,
    );
    expect(body).toMatch(/## Recommended next step on founder wake/);
    expect(body).toMatch(
      /1\. Founder reviews this proposal, marks structural items APPROVE \/ REJECT\./,
    );
    expect(body).toMatch(
      /2\. Founder provides COPY for the `\[FOUNDER COPY\]` markers OR delegates back to autopilot with constraints/,
    );
    expect(body).toMatch(
      /\(e\.g\. "use marketing-site voice; no \$-numbers; max 25 words per heading"\)\./,
    );
    expect(body).toMatch(
      /3\. Either the founder or a future autopilot session translates the redlines into actual `\.astro` edits,/,
    );
    expect(body).toMatch(
      /lands as V-184b-1 \/ V-184b-2 etc\. per page \(smaller PRs preferred for onboarding flow\)\./,
    );
    expect(body).toMatch(
      /This proposal itself is committed \(it's structural, not customer-facing copy\)\./,
    );
    expect(body).toMatch(/The actual page edits remain unwritten until founder redline\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
