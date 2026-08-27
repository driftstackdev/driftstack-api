package driftstack

import (
	"context"
	"encoding/json"
	"io"
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

// WebhooksResource.IterateDeliveries — walks every page + threads the
// status filter (cross-SDK parity with TS iterateDeliveries + Python
// iterate_deliveries).
func TestWebhooks_IterateDeliveries(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	var seenStatus []string
	var seenCursor []string
	cur2 := "cur_2"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks/whk_abc/deliveries" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		seenStatus = append(seenStatus, r.URL.Query().Get("status"))
		seenCursor = append(seenCursor, r.URL.Query().Get("cursor"))
		w.Header().Set("content-type", "application/json")
		// First page has a next_cursor; second terminates it.
		if r.URL.Query().Get("cursor") == "" {
			_ = json.NewEncoder(w).Encode(WebhookDeliveryListPage{
				Data: []WebhookDelivery{
					{ID: "wdl_1", WebhookID: "whk_abc", EventID: "e1", EventType: "session.completed", Status: DeliveryDLQ, NextAttemptAt: now, CreatedAt: now},
					{ID: "wdl_2", WebhookID: "whk_abc", EventID: "e2", EventType: "session.completed", Status: DeliveryDLQ, NextAttemptAt: now, CreatedAt: now},
				},
				HasMore:    true,
				NextCursor: &cur2,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(WebhookDeliveryListPage{
			Data: []WebhookDelivery{
				{ID: "wdl_3", WebhookID: "whk_abc", EventID: "e3", EventType: "session.completed", Status: DeliveryDLQ, NextAttemptAt: now, CreatedAt: now},
			},
			HasMore:    false,
			NextCursor: nil,
		})
	})

	var ids []string
	err := client.Webhooks.IterateDeliveries(
		context.Background(),
		"whk_abc",
		&ListDeliveriesQuery{Limit: 2, Status: DeliveryDLQ},
		func(d *WebhookDelivery) (bool, error) {
			ids = append(ids, d.ID)
			return true, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 || ids[0] != "wdl_1" || ids[2] != "wdl_3" {
		t.Errorf("ids=%v", ids)
	}
	// Status threaded through every page.
	for _, s := range seenStatus {
		if s != string(DeliveryDLQ) {
			t.Errorf("status filter not threaded: %v", seenStatus)
		}
	}
	// Cursor empty on the first page, set on the second.
	if len(seenCursor) != 2 || seenCursor[0] != "" || seenCursor[1] != "cur_2" {
		t.Errorf("cursor handoff: %v", seenCursor)
	}
}

// IterateDeliveries stops early when the callback returns false.
func TestWebhooks_IterateDeliveries_StopsEarly(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	calls := 0
	cur2 := "cur_2"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WebhookDeliveryListPage{
			Data: []WebhookDelivery{
				{ID: "wdl_1", WebhookID: "whk_abc", EventID: "e1", EventType: "session.completed", Status: DeliveryDelivered, NextAttemptAt: now, CreatedAt: now},
			},
			HasMore:    true,
			NextCursor: &cur2,
		})
	})

	seen := 0
	err := client.Webhooks.IterateDeliveries(context.Background(), "whk_abc", nil, func(_ *WebhookDelivery) (bool, error) {
		seen++
		return false, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != 1 {
		t.Errorf("expected to stop after 1, saw %d", seen)
	}
	if calls != 1 {
		t.Errorf("expected only 1 page fetch, got %d", calls)
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

// RotateSecret shipped with NO test in ANY of the three SDKs (V-1978). It is the
// one operation here that mints a credential, and its response is the ONLY time
// the plaintext secret is returned — a client that dropped a field would lose a
// secret the server will not show again.
func TestWebhooks_RotateSecret(t *testing.T) {
	t.Parallel()
	var method, rawURI string
	var bodyBytes []byte
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// RequestURI, not URL.Path: URL.Path is already percent-DECODED, so an
		// arm asserting on it passes whether or not the id was encoded.
		method, rawURI = r.Method, r.RequestURI
		bodyBytes, _ = io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                 "whk_abc",
			"secret":             "whsec_freshsecretvalue",
			"secret_prefix":      "whsec_fr",
			"prev_secret_prefix": "whsec_aA",
			"grace_expires_at":   "2026-05-10T18:00:00Z",
		})
	})

	out, err := client.Webhooks.RotateSecret(context.Background(), "whk/with space")
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" {
		t.Errorf("method=%s, want POST", method)
	}
	if rawURI != "/v1/webhooks/whk%2Fwith%20space/rotate-secret" {
		t.Errorf("raw request URI = %q, want the id percent-encoded", rawURI)
	}
	// An empty object, not an absent body: some proxies treat a bodyless POST
	// differently from one carrying {}.
	if string(bodyBytes) != "{}" {
		t.Errorf("body=%q, want %q", string(bodyBytes), "{}")
	}
	// Both prefixes and the grace deadline are what a caller needs to keep
	// verifying deliveries signed with the OLD secret during the dual-sign
	// window; dropping any silently breaks verification at rollover.
	if out.Secret != "whsec_freshsecretvalue" || out.SecretPrefix != "whsec_fr" {
		t.Errorf("secret=%q prefix=%q", out.Secret, out.SecretPrefix)
	}
	if out.PrevSecretPrefix != "whsec_aA" {
		t.Errorf("prev_secret_prefix=%q", out.PrevSecretPrefix)
	}
	if out.GraceExpiresAt.IsZero() {
		t.Error("grace_expires_at did not decode")
	}
}
