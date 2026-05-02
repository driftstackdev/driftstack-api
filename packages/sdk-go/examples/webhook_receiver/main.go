// Package main is a stdlib-only webhook receiver: verify the
// signature, dispatch by event type. No third-party HTTP framework
// dependency.
//
// Run:
//
//	DRIFTSTACK_WEBHOOK_SECRET=whsec_… go run ./examples/webhook_receiver
//
// Then point a Driftstack webhook at http://localhost:4242/webhook.
package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

var secret = os.Getenv("DRIFTSTACK_WEBHOOK_SECRET")

func handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/webhook" {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	if !driftstack.VerifyWebhookSignature(body, r.Header.Get("X-Driftstack-Signature"), secret) {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}

	var evt driftstack.Event
	if err := json.Unmarshal(body, &evt); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	switch evt.Type {
	case driftstack.EventSessionCompleted:
		var data driftstack.SessionCompletedData
		if err := json.Unmarshal(evt.Data, &data); err == nil {
			log.Printf("session.completed: session_id=%s duration_ms=%d", data.SessionID, data.DurationMS)
		}
	case driftstack.EventAPIKeyRevoked:
		var data driftstack.APIKeyRevokedData
		if err := json.Unmarshal(evt.Data, &data); err == nil {
			log.Printf("api_key.revoked: %s (%s)", data.APIKeyID, data.Name)
		}
	default:
		log.Printf("event %s (no typed handler)", evt.Type)
	}

	// 2xx confirms receipt. Driftstack expects this within 30s.
	w.WriteHeader(http.StatusNoContent)
}

func main() {
	if secret == "" {
		log.Fatal("DRIFTSTACK_WEBHOOK_SECRET required")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/webhook", handler)
	log.Println("webhook receiver listening on http://localhost:4242/webhook")
	if err := http.ListenAndServe(":4242", mux); err != nil {
		log.Fatal(err)
	}
}
