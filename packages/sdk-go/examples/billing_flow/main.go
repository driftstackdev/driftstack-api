// Example: customer billing self-serve flow.
//
// Reads the current billing state, then either redirects the customer
// to a checkout-session URL (if they have no subscription) or to the
// Stripe customer portal (if they do). Designed to mirror the
// customer-dashboard /billing page in code form so server-side
// integrations can offer the same UX without iframing the dashboard.
//
// This example expects a customer-account API key with the
// `account_owner` scope (or the legacy `admin` compat alias). The
// API key is read from DRIFTSTACK_API_KEY.

package main

import (
	"context"
	"fmt"
	"log"
	"os"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY not set")
	}
	client := driftstack.New(apiKey)

	ctx := context.Background()
	state, err := client.Billing.GetState(ctx)
	if err != nil {
		log.Fatalf("getState: %v", err)
	}

	if state.Subscription == nil {
		// No subscription yet — start a checkout for the API Builder tier.
		resp, err := client.Billing.CreateCheckoutSession(ctx, &driftstack.CreateCheckoutSessionRequest{
			Tier:       driftstack.TierAPIBuilder,
			SuccessURL: "https://app.driftstack.io/billing?ok=1",
			CancelURL:  "https://app.driftstack.io/billing?cancelled=1",
		})
		if err != nil {
			log.Fatalf("createCheckoutSession: %v", err)
		}
		fmt.Printf("No subscription — redirect customer to:\n  %s\n", resp.CheckoutURL)
		return
	}

	// Has a subscription — open the customer portal so they can manage it.
	portal, err := client.Billing.CreatePortalSession(ctx)
	if err != nil {
		log.Fatalf("createPortalSession: %v", err)
	}
	fmt.Printf("Subscribed to %s (status=%s) — portal:\n  %s\n",
		state.Subscription.Tier, state.Subscription.Status, portal.PortalURL)
}
