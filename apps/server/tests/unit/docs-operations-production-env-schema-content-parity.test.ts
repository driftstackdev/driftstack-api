// W553.B — drift guard for /docs/operations/production-env-schema.md.
// Provisioning-order ops cheat-sheet. Drift here either weakens
// the 9-group provisioning order (would invite mis-sequenced
// boot or out-of-order founder runbooks), drops the live-key
// SSH-write posture (would re-permit chat-readable terminal
// exposure for sk_live_*), or weakens the sub-processor
// crosswalk (would orphan DPA Annex 3 ↔ env-var mapping).
//
//   • 9 variable groups in provisioning order: Process/runtime +
//     Database (Neon EU) + Redis (Upstash EU) + Auth-flow URLs +
//     Email (Postmark) + R2 + Sentry + Stripe + Driver.
//   • DASHBOARD_ORIGIN is V-266 browser-OAuth launch surface.
//   • AUTH_EXPOSE_DEBUG_TOKEN never in production.
//   • Live sk_live_* via SSH-write only — never gh secret set, never
//     PR description.
//   • BillingService wires only when STRIPE_SECRET_KEY +
//     DRIFTSTACK_TIER_PRICE_IDS are set; webhook secret is independent.
//   • Admin gated by Cloudflare Access at origin, NOT by env-var.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/operations/production-env-schema.md');
const ENV_VARS = resolve(REPO_ROOT, 'docs/deployment/env-vars.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W553.B /docs/operations/production-env-schema.md content parity', () => {
  const body = read(LIB);

  it('deployment env reference pins SESSION_PROXY_REQUIRED as direct-surface closure, never a raw-presence check', () => {
    const env = read(ENV_VARS);
    expect(env).toMatch(/`SESSION_PROXY_REQUIRED`/);
    expect(env).toMatch(/disables both direct create verbs for every body/);
    expect(env).toMatch(/raw `proxy` key is always rejected and cannot bypass this boundary/);
    expect(env).toMatch(/owner-validated saved `proxy_id`/);
    expect(env).toMatch(/Do not enable this flag as a proxy-presence check/);
    expect(env).not.toMatch(/\*\*Re-engage\*\*/);
  });

  it('pins the current systemd runtime-file provisioning summary and canonical full-spec link', () => {
    expect(body).toMatch(/^# Production environment schema \(operations summary\)$/m);
    expect(body).toMatch(
      /Provisioning-order summary of every env var the production \/ staging Hetzner VM needs in `\/opt\/driftstack\/api\/\.env`\./,
    );
    expect(body).toMatch(
      /SSH-only root-owned mode-600 pending file; immutable `deploy-bridge\.sh` promotions preserve it\./,
    );
    expect(body).toMatch(
      /The longer per-variable spec \(defaults, allowed values, behaviour-on-absent\) lives in `docs\/deployment\/env-vars\.md`\./,
    );
    expect(body).toMatch(
      /This doc is the operations cheat sheet — what to set up first, what comes next, what's optional\./,
    );
  });

  it("9-group provisioning-order framing pinned: '### 1. Process / runtime — set these first' + '### 2. Database (Neon, EU region)' + '### 3. Redis (Upstash, EU region)' + '### 4. Auth-flow URLs' + '### 5. Email (Postmark)' + '### 6. R2 (Cloudflare object storage)' + '### 7. Sentry (observability)' + '### 8. Stripe (billing)' + '### 9. Driver (production WebKit fork integration)' — pinned so the 9-group-provisioning-order commitment survives", () => {
    expect(body).toMatch(/### 1\. Process \/ runtime — set these first/);
    expect(body).toMatch(/### 2\. Database \(Neon, EU region\)/);
    expect(body).toMatch(/### 3\. Redis \(Upstash, EU region\)/);
    expect(body).toMatch(/### 4\. Auth-flow URLs/);
    expect(body).toMatch(/### 5\. Email \(Postmark\)/);
    expect(body).toMatch(/### 6\. R2 \(Cloudflare object storage\)/);
    expect(body).toMatch(/### 7\. Sentry \(observability\)/);
    expect(body).toMatch(/### 8\. Stripe \(billing\)/);
    expect(body).toMatch(/### 9\. Driver \(production WebKit fork integration\)/);
  });

  it('Auth-flow URLs + DASHBOARD_ORIGIN + AUTH_EXPOSE_DEBUG_TOKEN framing pins the actual dashboard routes and rejects the legacy verify/reset paths', () => {
    expect(body).toMatch(/AUTH_VERIFY_EMAIL_URL=https:\/\/app\.driftstack\.io\/verify-email/);
    expect(body).toMatch(/AUTH_MAGIC_LINK_URL=https:\/\/app\.driftstack\.io\/auth\/magic-link/);
    expect(body).toMatch(/AUTH_PASSWORD_RESET_URL=https:\/\/app\.driftstack\.io\/reset-password/);
    expect(body).not.toMatch(/^AUTH_VERIFY_EMAIL_URL=.*\/auth\/verify-email$/m);
    expect(body).not.toMatch(/^AUTH_PASSWORD_RESET_URL=.*\/auth\/password-reset$/m);
    expect(body).toMatch(/DASHBOARD_ORIGIN=https:\/\/app\.driftstack\.io/);
    expect(body).toMatch(
      /DASHBOARD_ORIGIN=https:\/\/staging\.driftstack-customer-dashboard\.pages\.dev/,
    );
    expect(body).toMatch(/Leave the three `AUTH_\*_URL` overrides unset/);
    expect(body).toMatch(/former `app-staging\.driftstack\.dev` placeholder has/);
    expect(body).toMatch(
      /`DASHBOARD_ORIGIN` is the V-266 browser-OAuth flow's launch surface — the GUI client opens `\$\{dashboardOrigin\}\/cli\/authorize\?code=…`\.|`DASHBOARD_ORIGIN` is the V-266 browser-OAuth flow's launch surface/,
    );
    expect(body).toMatch(
      /`AUTH_EXPOSE_DEBUG_TOKEN` MUST stay unset \/ false in production\. Local dev only\./,
    );
    expect(body).not.toMatch(/^DASHBOARD_ORIGIN=https:\/\/app-staging\.driftstack\.dev$/m);
  });

  it('Stripe recurring catalog, independent webhook gate and actual BillingService wiring contract pinned', () => {
    expect(body).toMatch(/STRIPE_SECRET_KEY=sk_live_…/);
    expect(body).toMatch(/STRIPE_WEBHOOK_SECRET=whsec_…/);
    expect(body).toMatch(
      /DRIFTSTACK_TIER_PRICE_IDS=\{"solo_manual":\{"monthly":"price_…","annual":"price_…"\}/,
    );
    for (const tier of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ]) {
      expect(body).toContain(`"${tier}"`);
    }
    expect(body).not.toMatch(/STRIPE_TRIAL_PACK_PRICE_ID|19 IDs per ADR-004/);
    expect(body).toMatch(
      /\*\*Live-mode keys\*\*: per the `stripe_credential_handling` rule, live `sk_live_…` keys go through the SSH-only root-owned mode-600 pending-file procedure/,
    );
    expect(body).toMatch(
      /never through chat, command-line arguments, a commit or a PR description\./,
    );
    expect(body).toMatch(/Test-mode and live-mode values use the same handling\./);
    expect(body).toMatch(
      /When `STRIPE_SECRET_KEY` \+ `DRIFTSTACK_TIER_PRICE_IDS` are set, the BillingService wires/,
    );
    expect(body).toMatch(
      /typed disabled billing routes return `503 FeatureUnavailable` and bootstrap logs `BillingService NOT wired`/,
    );
    expect(body).toMatch(
      /`STRIPE_WEBHOOK_SECRET` independently activates inbound Stripe signature verification/,
    );
  });

  it("Sub-processor crosswalk + Sequence-summary framing pinned: '## Sub-processor → env-var crosswalk' + 'Hetzner Online GmbH                                  | (host-level, not env-var)' + 'Neon, Inc.                                           | `DATABASE_URL`' + 'Upstash, Inc.                                        | `REDIS_URL`' + 'Cloudflare, Inc. (R2 + Pages)                        | `R2_*`' + 'Postmark (ActiveCampaign LLC)                        | `POSTMARK_*`' + 'Sentry (Functional Software, Inc.)                   | `SENTRY_*`' + 'Stripe Payments Europe Ltd / Stripe, Inc.            | `STRIPE_*` + `DRIFTSTACK_TIER_PRICE_IDS`' + '## Sequence summary' + 'Hetzner VMs (V-278 founder runbook).' + 'WebKit-fork driver → `DRIVER=webkit` (post-Agent-1 bridge integration).' — pinned so the 9-sub-processor-crosswalk + DPA-Annex-3-correctness + V-278-Hetzner-first + Agent-1-bridge-driver-last commitment survives", () => {
    expect(body).toMatch(/## Sub-processor → env-var crosswalk/);
    expect(body).toMatch(/Hetzner Online GmbH\s+\|\s+\(host-level, not env-var\)/);
    expect(body).toMatch(/Neon, Inc\.\s+\|\s+`DATABASE_URL`/);
    expect(body).toMatch(/Upstash, Inc\.\s+\|\s+`REDIS_URL`/);
    expect(body).toMatch(/Cloudflare, Inc\. \(R2 \+ Pages\)\s+\|\s+`R2_\*`/);
    expect(body).toMatch(/Postmark \(ActiveCampaign LLC\)\s+\|\s+`POSTMARK_\*`/);
    expect(body).toMatch(/Sentry \(Functional Software, Inc\.\)\s+\|\s+`SENTRY_\*`/);
    expect(body).toMatch(
      /Stripe Payments Europe Ltd \/ Stripe, Inc\.\s+\|\s+`STRIPE_\*` \+ `DRIFTSTACK_TIER_PRICE_IDS`/,
    );
    expect(body).toMatch(/## Sequence summary/);
    expect(body).toMatch(/1\. Hetzner VMs \(V-278 founder runbook\)\./);
    expect(body).toMatch(
      /9\. WebKit-fork driver → `DRIVER=webkit` \(post-Agent-1 bridge integration\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
