package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// V-307 — WebhooksResource.ReplayDelivery test.
func TestWebhooks_ReplayDelivery(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhook-deliveries/wdl_xx/replay" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WebhookDelivery{
			ID:            "wdl_xx",
			WebhookID:     "whk_yy",
			EventID:       "evt_test",
			EventType:     "session.completed",
			Status:        DeliveryPending,
			Attempts:      0,
			NextAttemptAt: now,
			CreatedAt:     now,
		})
	})

	got, err := client.Webhooks.ReplayDelivery(context.Background(), "wdl_xx")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "wdl_xx" {
		t.Errorf("id=%q", got.ID)
	}
	if got.Status != DeliveryPending {
		t.Errorf("status=%q", got.Status)
	}
}
