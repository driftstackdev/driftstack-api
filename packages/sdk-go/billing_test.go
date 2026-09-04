package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestBilling_GetState(t *testing.T) {
	t.Parallel()
	periodEnd := time.Now().Add(30 * 24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing" || r.Method != "GET" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(GetBillingStateResponse{
			Subscription: &Subscription{
				Tier:              TierAPIBuilder,
				Status:            SubStatusActive,
				CurrentPeriodEnd:  &periodEnd,
				CancelAtPeriodEnd: false,
			},
		})
	})
	got, err := client.Billing.GetState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Subscription == nil || got.Subscription.Tier != TierAPIBuilder {
		t.Errorf("unexpected subscription: %+v", got.Subscription)
	}
}

func TestBilling_CreateCheckoutSession(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/checkout-session" {
			t.Errorf("path=%q", r.URL.Path)
		}
		var body CreateCheckoutSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Tier != TierAPIBuilder {
			t.Errorf("tier=%q", body.Tier)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateCheckoutSessionResponse{
			CheckoutURL: "https://checkout.stripe.com/c/cs_test_123",
			SessionID:   "cs_test_123",
		})
	})
	got, err := client.Billing.CreateCheckoutSession(context.Background(), &CreateCheckoutSessionRequest{
		Tier:       TierAPIBuilder,
		SuccessURL: "https://app.driftstack.io/billing?ok=1",
		CancelURL:  "https://app.driftstack.io/billing?cancelled=1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.CheckoutURL == "" || got.SessionID == "" {
		t.Errorf("unexpected response: %+v", got)
	}
}

func TestBilling_CreatePortalSession(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/portal-session" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CreatePortalSessionResponse{
			PortalURL: "https://billing.stripe.com/p/session/test_123",
		})
	})
	got, err := client.Billing.CreatePortalSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.PortalURL == "" {
		t.Errorf("missing portal url")
	}
}
