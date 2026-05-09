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

// V-463 — WebhooksResource.SendTest test.
func TestWebhooks_SendTest(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks/whk_abc/test" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SendTestWebhookResponse{
			DeliveryID: "wdl_test1",
			EventID:    "evt_test1",
			EventType:  "test.ping",
		})
	})
	got, err := client.Webhooks.SendTest(context.Background(), "whk_abc")
	if err != nil {
		t.Fatal(err)
	}
	if got.EventType != "test.ping" || got.DeliveryID != "wdl_test1" {
		t.Errorf("send-test response: %+v", got)
	}
}

// V-464 — WebhooksResource.Update partial-update test.
func TestWebhooks_Update(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks/whk_abc" || r.Method != "PATCH" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["description"] != "updated" {
			t.Errorf("body description=%v", body["description"])
		}
		desc := "updated"
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WebhookEndpoint{
			ID:                  "whk_abc",
			URL:                 "https://example.com/hook",
			SecretPrefix:        "whsec_aA",
			Events:              []WebhookEventType{"session.completed"},
			Description:         &desc,
			Active:              true,
			ConsecutiveFailures: 0,
			DeliveryCounts:      WebhookEndpointDeliveryCounts{},
			CreatedAt:           now,
		})
	})
	desc := "updated"
	got, err := client.Webhooks.Update(context.Background(), "whk_abc", &UpdateWebhookRequest{
		Description: &desc,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Description == nil || *got.Description != "updated" {
		t.Errorf("description=%v", got.Description)
	}
}
