package driftstack

import "testing"

// isRetrySafe is the gate that decides whether a request may be transparently
// re-attempted. It is the property that duplicates a customer's resource when
// it breaks: a transient 5xx on a create is ambiguous — the request may already
// have been applied and only the response lost — so retrying an unkeyed POST
// mints a second session, a second fleet slot, and a second charge from one
// call the customer made once.
//
// retry_test.go covers withRetry: which ERRORS are retried. Nothing covered
// which REQUESTS may be retried at all, so this gate was untested in the Go SDK
// while the TypeScript and Python SDKs both exercise it. A divergence here would
// affect only Go users and nothing would have said so.

func TestIsRetrySafeIdempotentMethods(t *testing.T) {
	t.Parallel()
	for _, method := range []string{"GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"} {
		if !isRetrySafe(method, nil) {
			t.Fatalf("%s is idempotent and must be retry-safe without a key", method)
		}
	}
}

func TestIsRetrySafeMethodCaseInsensitive(t *testing.T) {
	t.Parallel()
	// Callers may pass a lowercase verb; RFC 7231 method names are matched
	// case-sensitively on the wire but the SDK normalises before comparing, and
	// treating "get" as non-idempotent would suppress retries for a read.
	if !isRetrySafe("get", nil) {
		t.Fatal(`lowercase "get" must be recognised as idempotent`)
	}
}

func TestIsRetrySafeRejectsUnkeyedMutations(t *testing.T) {
	t.Parallel()
	// POST and PATCH are excluded deliberately. PATCH matters as much as POST:
	// patch bodies are commonly relative rather than absolute, so a replayed
	// PATCH can apply an increment twice.
	for _, method := range []string{"POST", "PATCH"} {
		if isRetrySafe(method, nil) {
			t.Fatalf("%s without an Idempotency-Key must NOT be retry-safe", method)
		}
		if isRetrySafe(method, map[string]string{"content-type": "application/json"}) {
			t.Fatalf("%s with unrelated headers must NOT be retry-safe", method)
		}
	}
}

func TestIsRetrySafeAcceptsKeyedMutations(t *testing.T) {
	t.Parallel()
	// The differential arm. Without it, every assertion above is satisfied by a
	// gate that refuses everything — which would disable retries entirely and
	// turn each transient blip into a customer-visible failure.
	for _, method := range []string{"POST", "PATCH"} {
		if !isRetrySafe(method, map[string]string{"Idempotency-Key": "idem-abc123"}) {
			t.Fatalf("%s carrying an Idempotency-Key must be retry-safe", method)
		}
	}
}

func TestIsRetrySafeHeaderNameCaseInsensitive(t *testing.T) {
	t.Parallel()
	// HTTP header names are case-insensitive, so retry safety must not depend on
	// how the caller capitalised the key.
	for _, spelling := range []string{"idempotency-key", "IDEMPOTENCY-KEY", "Idempotency-Key"} {
		if !isRetrySafe("POST", map[string]string{spelling: "idem-abc123"}) {
			t.Fatalf("header spelling %q must be recognised", spelling)
		}
	}
}
