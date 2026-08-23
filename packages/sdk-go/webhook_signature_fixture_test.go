package driftstack

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// V-1354 — verify a header the SERVER actually produced, not one this package built.
//
// `webhook_signature_test.go` signs its fixtures with the same constants it verifies them
// under, so it proves the verifier is self-consistent and nothing more. The property
// customers depend on is different: a header emitted by `signWebhookPayload` in the control
// plane must verify HERE. Those are two implementations in two languages, and only one of
// them ships in the customer's process.
//
// Driven by `apps/server/tests/integration/webhook-signature-verifies-in-every-sdk.test.ts`,
// which signs with the server's own function, writes the result to JSON and points
// DS_SIG_FIXTURE at it. Skipped otherwise so `go test ./...` stays runnable alone — and the
// server-side harness asserts this case RAN rather than skipped, because `go test` prints
// ok and exits 0 for a package whose tests all skipped.
func TestVerifyServerEmittedSignatureFixture(t *testing.T) {
	path := os.Getenv("DS_SIG_FIXTURE")
	if path == "" {
		t.Skip("needs DS_SIG_FIXTURE pointing at a server-signed header fixture")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	var fx struct {
		T      int64  `json:"t"`
		Body   string `json:"body"`
		Secret string `json:"secret"`
		Prev   string `json:"prev"`
		Header string `json:"header"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parsing fixture: %v", err)
	}

	// Five seconds after signing — inside any sane tolerance, and pinned rather than
	// time.Now() so the fixture cannot rot into a replay-window failure.
	at := VerifyWebhookOptions{Now: time.Unix(fx.T+5, 0)}

	if !VerifyWebhookSignature([]byte(fx.Body), fx.Header, fx.Secret, at) {
		t.Fatalf("a server-signed header did not verify under the current secret: %.48s", fx.Header)
	}
	// V-359 rotation: mid-grace the server emits `t=…,v1=<curr>,v1=<prev>`. A verifier that
	// reads only the FIRST v1 accepts the current secret and silently rejects every delivery
	// a customer is still verifying with the previous one — the window rotation exists to
	// make safe.
	if fx.Prev != "" && !VerifyWebhookSignature([]byte(fx.Body), fx.Header, fx.Prev, at) {
		t.Fatalf("the previous secret did not verify against a dual-signed header: %.48s", fx.Header)
	}
	// Negative: without this the two checks above are satisfied by a verifier that returns
	// true unconditionally.
	if VerifyWebhookSignature([]byte(fx.Body+"x"), fx.Header, fx.Secret, at) {
		t.Fatal("a tampered body verified — the signature is not being checked")
	}
}
