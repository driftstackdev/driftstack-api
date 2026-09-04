"""Customer billing self-serve flow — mirror the customer-dashboard
/billing page in code form so server-side integrations can offer
the same UX without iframing the dashboard.

Reads current billing state, then either:
  - redirects to a Checkout session URL (no subscription yet)
  - opens the Stripe Customer Portal (has a subscription)

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/billing_flow.py
"""

from __future__ import annotations

import os
import sys

from driftstack import Driftstack


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    client = Driftstack(api_key=api_key, base_url=base_url)

    state = client.billing.get_state()

    if state.get("subscription") is None:
        # No subscription yet — start a Checkout for the API Builder tier.
        co = client.billing.create_checkout_session(
            {
                "tier": "api_builder",
                "billing_period": "monthly",
                "success_url": "https://app.driftstack.io/billing?ok=1",
                "cancel_url": "https://app.driftstack.io/billing?cancelled=1",
            }
        )
        print(f"No subscription — redirect customer to:\n  {co['checkout_url']}")
        return 0

    # Has a subscription — open the customer portal so they can manage it.
    portal = client.billing.create_portal_session()
    sub = state["subscription"]
    print(f"Subscribed to {sub['tier']} (status={sub['status']})\nPortal: {portal['portal_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
