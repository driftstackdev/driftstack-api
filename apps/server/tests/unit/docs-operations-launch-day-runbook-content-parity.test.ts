// W552.B — drift guard for /docs/operations/launch-day-runbook.md.
// Launch-day choreography. Drift here either weakens the T-24h /
// T-1h / T-0 cutover sequence (would risk an undocumented launch),
// drops the 10-step smoke-test (would re-allow launching without
// signup+pay+session+revoke verification), or weakens the 3-tier
// rollback procedure (image-level + workflow-level + full).
//
//   • Pre-condition: V-279 pre-launch checklist first-paying-
//     customer-acceptable section all READY.
//   • Operator = founder; out-of-band escalation = SSH access.
//   • Cutover sequence: T-24h Pre-flight + T-1h Final-prep +
//     T-0 Cutover + Day-1 monitoring + Day 2-7 stabilisation.
//   • Stripe current catalog: 6 paid tiers × 2 periods = 12 prices.
//   • Smoke test happy-path: signup → verify → paid subscription →
//     Stripe Checkout → GUI sign-in → session → screenshot →
//     destroy → revoke key.
//   • 3-rollback tier: image-level (1-2min) + workflow-level
//     (5-10min) + full (worst case).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/operations/launch-day-runbook.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W552.B /docs/operations/launch-day-runbook.md content parity', () => {
  const body = read(LIB);

  it("Header + Pre-condition + Roles framing pinned: '# Driftstack launch-day runbook' + 'End-to-end choreography for \"launch day\" — the day you flip from pre-launch / staging-only to publicly accepting paying customers.' + '**Pre-condition:** all V-279 pre-launch checklist items in the \"Minimum-launchable surface (first-paying-customer-acceptable)\" section are READY.' + '**Operator** = the founder running the runbook.' + '**Out-of-band escalation** = anyone with SSH access to the Hetzner production VM (today: founder only).' — pinned so the launch-day-choreography + V-279-pre-condition + founder-operator + SSH-escalation commitment survives", () => {
    expect(body).toMatch(/^# Driftstack launch-day runbook$/m);
    expect(body).toMatch(
      /End-to-end choreography for "launch day" — the day you flip from pre-launch \/ staging-only to publicly accepting paying customers\./,
    );
    expect(body).toMatch(
      /\*\*Pre-condition:\*\* all V-279 pre-launch checklist items in the "Minimum-launchable surface \(first-paying-customer-acceptable\)" section are READY\./,
    );
    expect(body).toMatch(/\*\*Operator\*\* = the founder running the runbook\./);
    expect(body).toMatch(
      /\*\*Out-of-band escalation\*\* = anyone with SSH access to the Hetzner production VM \(today: founder only\)\./,
    );
  });

  it('T-24h pre-flight section framing pinned: live staging/production APIs + marketing/dashboard/docs + Stripe inventory/live-key + GUI + full smoke', () => {
    expect(body).toMatch(/## T-24h: Pre-flight checks/);
    expect(body).toMatch(/### Backend \/ API/);
    expect(body).toMatch(
      /- \[ \] `https:\/\/staging\.driftstack\.dev\/health` returns 200 with JSON\./,
    );
    expect(body).toMatch(
      /- \[ \] `https:\/\/api\.driftstack\.dev\/health` returns 200 with JSON\./,
    );
    expect(body).toMatch(/### Marketing site \/ dashboard \/ docs/);
    expect(body).toMatch(
      /- \[ \] `https:\/\/app\.driftstack\.dev\/signup` form posts; verification-email send works/,
    );
    expect(body).toMatch(/### Stripe/);
    expect(body).toMatch(
      /- \[ \] Stripe live-mode dashboard shows the canonical 12 recurring prices configured/,
    );
    expect(body).toMatch(
      /Solo\/Team\/Agency Manual and Starter\/Builder\/Scale API, each monthly \+ annual/,
    );
    expect(body).toMatch(/If a tier-period combo is missing, it can't be checkout-targeted\./);
    expect(body).toMatch(
      /- \[ \] `STRIPE_SECRET_KEY` in production \.env is `sk_live_…` \(NOT `sk_test_…`\)\./,
    );
    expect(body).toMatch(/### GUI client/);
    expect(body).toMatch(/### Smoke test \(full happy path\)/);
  });

  it("T-0 + Day-1 + Rollback sections framing pinned: '## T-1h: Final preparation' + '## T-0: Cutover sequence' + '### 1. Flip Stripe to live mode' + '### 2. DNS go-live (if not already)' + '### 3. Marketing site goes public' + '### 4. Watch the first hour' + '## Day-1 monitoring thresholds' + '## Rollback procedures' + '### Image-level rollback (1-2 minutes; safest)' + '### Workflow-level rollback (5-10 minutes; tracked)' + '### Full rollback (worst case)' + '## Day 2-7: stabilisation' — pinned so the T-1h + T-0-Cutover-4-step + Day-1-monitoring + 3-tier-Rollback (image-1-2min + workflow-5-10min + full-worst-case) + Day-2-7-stabilisation commitment survives", () => {
    expect(body).toMatch(/## T-1h: Final preparation/);
    expect(body).toMatch(/## T-0: Cutover sequence/);
    expect(body).toMatch(/### 1\. Flip Stripe to live mode/);
    expect(body).toMatch(/### 2\. DNS go-live \(if not already\)/);
    expect(body).toMatch(/### 3\. Marketing site goes public/);
    expect(body).toMatch(/### 4\. Watch the first hour/);
    expect(body).toMatch(/## Day-1 monitoring thresholds/);
    expect(body).toMatch(/## Rollback procedures/);
    expect(body).toMatch(/### Image-level rollback \(1-2 minutes; safest\)/);
    expect(body).toMatch(/### Workflow-level rollback \(5-10 minutes; tracked\)/);
    expect(body).toMatch(/### Full rollback \(worst case\)/);
    expect(body).toMatch(/## Day 2-7: stabilisation/);
  });

  it('Smoke test 10-step recurring-subscription happy path remains pinned', () => {
    expect(body).toMatch(
      /1\. Visit `app\.driftstack\.dev\/signup` → create account with a real email you control\./,
    );
    expect(body).toMatch(/2\. Verify email via the link Postmark delivers\./);
    expect(body).toMatch(
      /3\. Land on welcome \/ select-tier → choose Solo Manual monthly → Stripe Checkout opens\./,
    );
    expect(body).toMatch(
      /4\. Complete checkout with a real card \(we'll refund or destroy the account after the test\)\./,
    );
    expect(body).toMatch(
      /5\. Verify `\/billing` reflects the active Solo Manual subscription and correct renewal cadence\./,
    );
    expect(body).toMatch(
      /6\. Open the GUI client → "Sign in with browser" → confirm → key minted\./,
    );
    expect(body).toMatch(
      /7\. Spin up a session in the GUI → navigate to `https:\/\/example\.com` → capture screenshot\./,
    );
    expect(body).toMatch(/8\. Destroy session → list shows zero active\./);
    expect(body).toMatch(
      /9\. `\/account\/me` → reflects subscription \+ concurrent counters correctly\./,
    );
    expect(body).toMatch(
      /10\. `\/api-keys` → "Desktop client" key visible; revoke it → 401 from the GUI on the next call/,
    );
    expect(body).toMatch(/If any step fails, \*\*abort launch\*\*/);
    expect(body).not.toMatch(/STRIPE_TRIAL_PACK_PRICE_ID/);
  });

  it("V-516 launch-day amendments framing pinned: '## V-516 launch-day amendments (post-Wave-11 state)' + '### T-24h additions' + '### T-0 additions' + '## Related docs' — pinned so the V-516-Wave-11-amendments + T-24h-additions + T-0-additions + Related-docs commitment survives", () => {
    expect(body).toMatch(/## V-516 launch-day amendments \(post-Wave-11 state\)/);
    expect(body).toMatch(/### T-24h additions/);
    expect(body).toMatch(/### T-0 additions/);
    expect(body).toMatch(/## Related docs/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
