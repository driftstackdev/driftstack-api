// Customer billing self-serve flow — mirror the customer-dashboard
// /billing page in code form so server-side integrations can offer
// the same UX without iframing the dashboard.
//
// Reads current billing state, then either:
//   - redirects to a Checkout session URL (no subscription yet)
//   - opens the Stripe Customer Portal (has a subscription)
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/billing-flow.ts

/* eslint-disable no-console */
import { Driftstack } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

const client = new Driftstack({ apiKey });

async function main(): Promise<void> {
  const state = await client.billing.getState();

  if (state.subscription === null) {
    // No subscription yet — start a Checkout for the API Builder tier.
    const co = await client.billing.createCheckoutSession({
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'https://app.driftstack.io/billing?ok=1',
      cancel_url: 'https://app.driftstack.io/billing?cancelled=1',
    });
    console.log(`No subscription — redirect customer to:\n  ${co.checkout_url}`);
    return;
  }

  // Has a subscription — open the customer portal so they can manage it.
  const portal = await client.billing.createPortalSession();
  console.log(
    `Subscribed to ${state.subscription.tier} (status=${state.subscription.status})\nPortal: ${portal.portal_url}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
