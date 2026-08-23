// "No Stripe subscription" and "on the free tier" are DIFFERENT facts, and the
// dashboard used to treat them as one.
//
// An entitlement granted outside Stripe — enterprise, comped, a crypto
// purchase — leaves `accounts.tier` set and the `subscriptions` table empty.
// Every surface that inferred a tier from the absent subscription then
// contradicted the surface that read the account.
//
// The reported symptom was one stat card on the overview rendering BOTH at
// once: `[data-stat-plan]` from `tierLabel(me.tier)` said "Enterprise" while
// `[data-stat-plan-sub]` was hardcoded to the string 'free plan'. The billing
// page had the same shape — "No active subscription", "upgrade to a paid
// tier", and a CTA pointing at /select-tier/, shown to an account already on
// the highest tier, where its own tier is not purchasable.
//
// These are content pins because the pages are Astro templates with inline
// scripts; there is no module to import and render. What they defend is
// narrow and worth the pin: no surface may name a tier that it inferred from
// the ABSENCE of a subscription.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const overview = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro'),
  'utf8',
);
const billing = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro'),
  'utf8',
);

describe('no Stripe subscription is not the same fact as the free tier', () => {
  it('the overview never hardcodes a plan sub-line, it reads the account tier', () => {
    // The exact regression: an UNCONDITIONAL `if (planSub) planSub.textContent
    // = 'free plan'` in the no-subscription branch, beside a value element
    // already showing "Enterprise" from /v1/account/me. Banned in that shape
    // specifically — 'free plan' is still the right words for an account that
    // really is free, so banning the string outright would forbid the fix.
    expect(overview).not.toMatch(/if \(planSub\) planSub\.textContent = 'free plan'/);
    // The branch now consults the real tier before naming anything...
    expect(overview).toMatch(/accountMePromise/);
    expect(overview).toMatch(/managed by Driftstack/);
    // ...and 'free plan' survives ONLY as the answer for an actually-free
    // account, never as the fallback for "no subscription".
    expect(overview).toMatch(/t === 'free'/);
  });

  it('the overview shares ONE /v1/account/me result rather than racing a second fetch', () => {
    // Two independent fetches would make the sub-line's correctness depend on
    // which response won, which is not a fix.
    const meFetches = overview.match(/getJson\('\/v1\/account\/me'\)/g) ?? [];
    expect(meFetches).toHaveLength(1);
  });

  it('billing distinguishes an out-of-Stripe plan from having no plan', () => {
    expect(billing).toMatch(/mePromise/);
    expect(billing).toMatch(/Managed directly by Driftstack, not billed through Stripe/);
    // The upgrade pitch must stay behind the free-tier branch — it is the wrong
    // thing to say to an enterprise account.
    expect(billing).toMatch(/accountTier !== null && accountTier !== 'free'/);
  });

  it('billing retargets the plan CTA instead of only relabelling it', () => {
    // Relabelling to "Contact support" while the href still pointed at
    // /select-tier/ would just be a different wrong answer.
    expect(billing).toMatch(/planCta\.textContent = 'Contact support'/);
    expect(billing).toMatch(/mailto:support@driftstack\.dev\?subject=Driftstack%20plan%20change/);
    // And the free-tier branch still restores the picker, so the two branches
    // cannot leak each other's href across a re-render.
    expect(billing).toMatch(/planCta\.setAttribute\('href', '\/select-tier\/'\)/);
  });
});
