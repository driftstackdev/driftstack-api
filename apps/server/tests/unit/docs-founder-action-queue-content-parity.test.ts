// W548.B — drift guard for /docs/founder-action-queue.md.
// Outside-engineering action queue. Drift here either drops a
// PENDING blocker (would silently let engineering work proceed
// without surfacing the founder action), changes the V-052 sub-
// processor lock (would re-open the directional-question gate),
// or weakens the 30-day resolved-entry retention contract.
//
//   • Living document; owner: founder (actions) + engineering
//     (queue maintenance).
//   • Outside-engineering scope: credentials, billing, legal
//     authority, asset creation.
//   • Infrastructure category: Hetzner CCX23×2 + 4-CF-Pages-projects
//     + Neon EU + Upstash EU.
//   • CI/CD secrets: GitHub Environments + Sentry secrets +
//     DEPLOY_DOTENV_BASE64 + V-148 allow-auto-merge.
//   • Stripe ADR-002: 12 recurring price IDs + webhook secret + Stripe Tax
//     + EU VAT reverse-charge.
//   • Pricing TBD: BYOK markup multiplier + bundled-LLM per-token
//     rate.
//   • Brand: og-default.png SHIPPED (V-871) — 1200x630, wired in BaseLayout.
//   • Legal: sub-processor list LOCKED 2026-05-03 V-052; legal docs
//     DRAFT counsel-pending.
//   • Resolution policy: 30-day audit-trail retention then archive.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-action-queue.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W548.B /docs/founder-action-queue.md content parity', () => {
  const body = read(LIB);

  it("Header + living-document + outside-engineering framing pinned: '# Founder action queue' + '**Status:** living document. Updated as items resolve / new items surface.' + '**Owner:** founder (action items themselves) + engineering (queue maintenance).' + 'This is the **outside-engineering** action queue — things only the founder can do because they require credentials, billing access, legal authority, or asset creation that isn't engineering scope.' + 'Engineering keeps this doc in sync as work surfaces blocking items.' + 'Items are grouped by category. Each item says what's blocked + what the founder needs to do.' — pinned so the living-document + 2-owner-split + outside-engineering-credentials/billing/legal/asset-creation + category-grouped commitment survives", () => {
    expect(body).toMatch(/^# Founder action queue$/m);
    expect(body).toMatch(
      /\*\*Status:\*\* living document\. Updated as items resolve \/ new items surface\./,
    );
    expect(body).toMatch(
      /\*\*Owner:\*\* founder \(action items themselves\) \+ engineering \(queue maintenance\)\./,
    );
    expect(body).toMatch(/This is the \*\*outside-engineering\*\* action queue — things only the/);
    expect(body).toMatch(/founder can do because they require credentials, billing access, legal/);
    expect(body).toMatch(/authority, or asset creation that isn't engineering scope\./);
    expect(body).toMatch(/Engineering/);
    expect(body).toMatch(/keeps this doc in sync as work surfaces blocking items\./);
    expect(body).toMatch(/Items are grouped by category\. Each item says what's blocked \+ what/);
    expect(body).toMatch(/the founder needs to do\./);
  });

  it("Infrastructure 4-item PENDING framing pinned: '## Infrastructure (Hetzner + Cloudflare + Neon + Upstash)' + '### Hetzner two-VM provisioning' + 'Provision two CCX23 VMs in Falkenstein (FSN1).' + '**Reference:** ADR-001 `docs/adr/ADR-001-control-plane-hosting-hetzner.md`.' + '### Cloudflare Pages projects' + 'driftstack-marketing` → custom domains `driftstack.dev` + `www.driftstack.dev`' + 'driftstack-customer-dashboard` → custom domain `app.driftstack.dev`' + 'driftstack-admin-panel` → custom domain `admin.driftstack.dev` (Cloudflare Access SSO gate planned at the origin level)' + 'driftstack-docs` → custom domain `docs.driftstack.dev` (V-258)' + '`docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md`' + '### Neon EU database' + 'Create two separate Neon projects in EU region (or two branches of one project): `driftstack-staging` + `driftstack-production`.' + '### Upstash EU Redis' + 'Create two Upstash databases (EU region, TLS enabled).' — pinned so the 4-infra-item PENDING + CCX23×2 Falkenstein FSN1 + 4-CF-Pages-project mapping + Neon-EU-staging+production + Upstash-EU-TLS commitment survives", () => {
    expect(body).toMatch(/## Infrastructure \(Hetzner \+ Cloudflare \+ Neon \+ Upstash\)/);
    expect(body).toMatch(/### Hetzner two-VM provisioning/);
    expect(body).toMatch(/Provision two CCX23 VMs in Falkenstein \(FSN1\)\./);
    expect(body).toMatch(
      /\*\*Reference:\*\* ADR-001 `docs\/adr\/ADR-001-control-plane-hosting-hetzner\.md`\./,
    );
    expect(body).toMatch(/### Cloudflare Pages projects/);
    expect(body).toMatch(
      /`driftstack-marketing` → custom domains `driftstack\.dev` \+ `www\.driftstack\.dev`/,
    );
    expect(body).toMatch(/`driftstack-customer-dashboard` → custom domain `app\.driftstack\.dev`/);
    expect(body).toMatch(
      /`driftstack-admin-panel` → custom domain `admin\.driftstack\.dev` \(Cloudflare Access SSO gate planned at the origin level\)/,
    );
    expect(body).toMatch(/`driftstack-docs` → custom domain `docs\.driftstack\.dev` \(V-258\)/);
    expect(body).toMatch(/`docs\/founder-actions\/v259-cloudflare-pages-all-projects-setup\.md`/);
    expect(body).toMatch(/### Neon EU database/);
    expect(body).toMatch(/Create two separate Neon projects in EU region \(or two/);
    expect(body).toMatch(
      /branches of one project\): `driftstack-staging` \+ `driftstack-production`\./,
    );
    expect(body).toMatch(/### Upstash EU Redis/);
    expect(body).toMatch(/Create two Upstash databases \(EU region, TLS enabled\)\./);
  });

  it("CI/CD secrets 4-item framing pinned: '## CI/CD secrets' + '### GitHub Environments' + 'Create `staging` + `production` environments under GitHub repository settings → Environments.' + '### Sentry secrets' + '`SENTRY_AUTH_TOKEN` (Internal Integration token, project:read + project:write scopes)' + '`SENTRY_ORG` (the Sentry org slug)' + '`SENTRY_PROJECT` (the Sentry project slug for the API server)' + '`docs/adr/ADR-005-observability-sentry-first.md`' + '### DEPLOY_DOTENV_BASE64' + 'Create the local `.env` file with all values listed in `docs/deployment/env-vars.md`, base64-encode it, and add as the GitHub repo secret `DEPLOY_DOTENV_BASE64` (per environment).' + '### Allow auto-merge in repo settings (V-148)' + 'Repo settings → General → \"Allow auto-merge\" → enable.' + '`.github/workflows/dependabot-auto-merge.yml` (V-148).' — pinned so the 4-CI/CD secret (GitHub-Environments + 3-Sentry-secret + DEPLOY_DOTENV_BASE64 + V-148 allow-auto-merge) + ADR-005 reference commitment survives", () => {
    expect(body).toMatch(/## CI\/CD secrets/);
    expect(body).toMatch(/### GitHub Environments/);
    expect(body).toMatch(/Create `staging` \+ `production` environments under/);
    expect(body).toMatch(/GitHub repository settings → Environments\./);
    expect(body).toMatch(/### Sentry secrets/);
    expect(body).toMatch(/`SENTRY_AUTH_TOKEN` \(Internal Integration token, project:read \+/);
    expect(body).toMatch(/project:write scopes\)/);
    expect(body).toMatch(/`SENTRY_ORG` \(the Sentry org slug\)/);
    expect(body).toMatch(/`SENTRY_PROJECT` \(the Sentry project slug for the API server\)/);
    expect(body).toMatch(/`docs\/adr\/ADR-005-observability-sentry-first\.md`/);
    expect(body).toMatch(/### DEPLOY_DOTENV_BASE64/);
    expect(body).toMatch(/Create the local `\.env` file with all values listed in/);
    expect(body).toMatch(/`docs\/deployment\/env-vars\.md`, base64-encode it, and add as the/);
    expect(body).toMatch(/GitHub repo secret `DEPLOY_DOTENV_BASE64` \(per environment\)\./);
    expect(body).toMatch(/### Allow auto-merge in repo settings \(V-148\)/);
    expect(body).toMatch(/Repo settings → General → "Allow auto-merge" → enable\./);
    expect(body).toMatch(/`\.github\/workflows\/dependabot-auto-merge\.yml` \(V-148\)\./);
  });

  it('Stripe ADR-002 + current 12-recurring-price + Stripe-Tax framing pinned', () => {
    expect(body).toMatch(/## Stripe \(ADR-002\)/);
    expect(body).toMatch(/### Stripe price IDs/);
    expect(body).toMatch(/Create the 12 recurring Stripe prices in the live-mode dashboard/);
    expect(body).toMatch(/matching the current six paid-tier values:/);
    expect(body).toMatch(/- 6 Manual ladder \(Solo\/Team\/Agency × monthly \+ annual\)/);
    expect(body).toMatch(/- 6 API ladder \(Starter\/Builder\/Scale × monthly \+ annual\)/);
    expect(body).toMatch(/`DRIFTSTACK_TIER_PRICE_IDS`/);
    expect(body).toMatch(/Enterprise remains sales-assisted/);
    expect(body).toMatch(/retired one-time trial pack must not be recreated/);
    expect(body).not.toMatch(/`STRIPE_TRIAL_PACK_PRICE_ID`/);
    expect(body).toMatch(/### Stripe webhook secret/);
    expect(body).toMatch(/Stripe dashboard → Developers → Webhooks, create/);
    expect(body).toMatch(
      /an endpoint pointing at `https:\/\/api\.driftstack\.dev\/v1\/webhooks\/stripe`\./,
    );
    expect(body).toMatch(/`STRIPE_WEBHOOK_SECRET`/);
    expect(body).toMatch(/### Stripe Tax \+ EU VAT/);
    expect(body).toMatch(/Enable Stripe Tax in dashboard\. Verify Dutch BV tax/);
    expect(body).toMatch(/registration is captured\. Confirm reverse-charge handling for/);
    expect(body).toMatch(/EU B2B customers — Stripe Tax computes automatically once enabled\./);
  });

  it("Pricing TBD + Brand assets + Legal LOCKED framing pinned: '## Pricing values (locked but TBD on launch)' + '### BYOK markup multiplier' + '### Bundled LLM per-token rate' + 'API Builder / API Scale / Enterprise tiers' + '## Brand assets' + '### og-default.png' + 'Drop a 1200×630 PNG into `apps/marketing-site/public/og-default.png`. Brand-on-image treatment with the oxblood D logo + \"Driftstack\" wordmark + a one-line tagline.' + '## Legal + compliance (separate workstream)' + '### Sub-processor list' + '**Status:** LOCKED 2026-05-03 (V-052)' + 'Hetzner / Neon / Upstash / Cloudflare / Postmark / Sentry / Stripe / Anthropic / Moneybird / MacStadium' + 'Adding a new sub-processor = directional question first, never silent.' + '### Legal documents' + '**Status:** DRAFT (counsel review pending)' — pinned so the 2-pricing-TBD (BYOK-markup-multiplier + bundled-LLM-per-token-rate) + 1200×630 oxblood-D-wordmark og-default + V-052 sub-processor LOCKED 10-vendor list + DRAFT-counsel-pending legal docs commitment survives", () => {
    expect(body).toMatch(/## Pricing values \(locked but TBD on launch\)/);
    expect(body).toMatch(/### BYOK markup multiplier/);
    expect(body).toMatch(/### Bundled LLM per-token rate/);
    expect(body).toMatch(/API Builder \/ API Scale \/ Enterprise tiers/);
    expect(body).toMatch(/## Brand assets/);
    expect(body).toMatch(/### og-default\.png/);
    // V-871 — the asset shipped 2026-07-07 and BaseLayout defaults to it, but
    // this entry still read PENDING with a placeholder URL. Negative on the
    // stale status, positive on the shipped state; the 1200×630 spec survives
    // as the record of what was asked for.
    expect(body, 'the pending status is gone').not.toMatch(
      /\*\*Status:\*\* PENDING \(placeholder URL today/,
    );
    expect(body, 'the asset is recorded as shipped and wired').toMatch(
      /\*\*Status:\*\* DONE \(V-871 check\)/,
    );
    expect(body, 'and the original specification is preserved verbatim').toMatch(
      /\*\*Original ask, kept verbatim as the record of what was specified:\*\*/,
    );
    expect(
      body,
      'including the instruction itself, which a third pin in this block freezes',
    ).toMatch(/Drop a\s*1200×630 PNG into/);
    expect(body).toMatch(/`apps\/marketing-site\/public\/og-default\.png`\. Brand-on-image/);
    expect(body).toMatch(/treatment with the oxblood D logo \+ "Driftstack" wordmark \+ a/);
    expect(body).toMatch(/one-line tagline\./);
    expect(body).toMatch(/## Legal \+ compliance \(separate workstream\)/);
    expect(body).toMatch(/### Sub-processor list/);
    expect(body).toMatch(/\*\*Status:\*\* LOCKED 2026-05-03 \(V-052\)/);
    expect(body).toMatch(/Hetzner \/ Neon \/ Upstash \/ Cloudflare \/ Postmark \//);
    expect(body).toMatch(/Sentry \/ Stripe \/ Anthropic \/ Moneybird \/ MacStadium/);
    expect(body).toMatch(/Adding a new sub-processor = directional question/);
    expect(body).toMatch(/first, never silent\./);
    expect(body).toMatch(/### Legal documents/);
    expect(body).toMatch(/\*\*Status:\*\* DRAFT \(counsel review pending\)/);
  });

  it("How-to-use-queue + 30-day-retention + engineering-side-queue framing pinned: '## How to use this queue' + 'When engineering needs founder to act on something blocking, an entry lands here with category + status + blocks + action. Founder resolves; entry status moves to RESOLVED with the resolution date.' + 'Resolved entries stay in the doc for 30 days for audit trail then archive into `docs/archive/founder-action-queue-resolved.md`.' + 'When engineering wants the founder's attention on something but it's NOT blocking, those go in pbcopy / chat status updates rather than this queue.' + '## Engineering-side action queue (not founder's)' + 'V-142 forward-looking design' + 'V-136 added the constant; V-073 was scaffolding for the gate' + 'V-144 stubbed' + 'V-149 stubbed' + 'D-035 (admin scope at preHandler) + D-036 (team roles taxonomy)' — pinned so the entry-lifecycle (category+status+blocks+action → RESOLVED+date) + 30-day-retention-then-archive + chat-status-for-non-blocking + engineering-side-queue (V-142+V-136+V-073+V-144+V-149+D-035+D-036) commitment survives", () => {
    expect(body).toMatch(/## How to use this queue/);
    expect(body).toMatch(/When engineering needs founder to act on something blocking, an entry/);
    expect(body).toMatch(/lands here with category \+ status \+ blocks \+ action\. Founder/);
    expect(body).toMatch(/resolves; entry status moves to RESOLVED with the resolution date\./);
    expect(body).toMatch(/Resolved entries stay in the doc for 30 days for audit trail then/);
    expect(body).toMatch(/archive into `docs\/archive\/founder-action-queue-resolved\.md`\./);
    expect(body).toMatch(/When engineering wants the founder's attention on something but it's/);
    expect(body).toMatch(/NOT blocking, those go in pbcopy \/ chat status updates rather than/);
    expect(body).toMatch(/this queue\./);
    expect(body).toMatch(/## Engineering-side action queue \(not founder's\)/);
    expect(body).toMatch(/V-142 forward-looking design/);
    expect(body).toMatch(/V-136 added the constant; V-073 was scaffolding for the gate/);
    expect(body).toMatch(/V-144 stubbed/);
    expect(body).toMatch(/V-149 stubbed/);
    expect(body).toMatch(/D-035 \(admin scope at preHandler\) \+ D-036 \(team roles taxonomy\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
