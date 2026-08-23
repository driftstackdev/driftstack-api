// The published Go SDK, driven against a real running server.
//
// This package has 25 test files. Two of them stand up an `httptest` server —
// which is still a stub the test author wrote, not the API this client wraps.
// So every assertion here has been about what the SDK SENDS, never about
// whether the real server agrees with it.
//
// The Go client decodes into concrete structs with explicit json tags, so a
// server that renames a field does not error here: it leaves the Go zero value
// in place and the customer reads an empty string or a nil slice from a call
// that returned 200. That is quieter than the Python SDK's parse failure and
// worse to debug, and it is exactly what a stub server can never surface.
//
// Skipped unless DS_LIVE_BASE_URL and DS_LIVE_API_KEY are set, so `go test`
// stays runnable on its own. The harness in
// apps/server/tests/integration/sdk-go-against-the-real-server.test.ts starts a
// real app, sets both, and asserts these RAN rather than skipped — a
// permanently-skipped contract test is a false green wearing a passing badge.

package driftstack

import (
	"context"
	"errors"
	"os"
	"testing"
)

func liveTarget(t *testing.T) (string, string) {
	t.Helper()
	baseURL := os.Getenv("DS_LIVE_BASE_URL")
	apiKey := os.Getenv("DS_LIVE_API_KEY")
	if baseURL == "" || apiKey == "" {
		t.Skip("needs DS_LIVE_BASE_URL + DS_LIVE_API_KEY pointing at a running server")
	}
	return baseURL, apiKey
}

// The SDK's own Authorization header is read by the real server. Asserted on an
// authed route on purpose: /v1/archetypes is deliberately public, so it answers
// a bogus key too and would prove nothing.
func TestLiveAuthenticatesAgainstAnAuthedRoute(t *testing.T) {
	baseURL, apiKey := liveTarget(t)
	client := New(apiKey, WithBaseURL(baseURL))
	defer client.Close()

	me, err := client.Account.Me(context.Background())
	if err != nil {
		t.Fatalf("Account.Me against the real server: %v", err)
	}
	if me.ID == "" {
		t.Fatal("the profile carries no id — a renamed field decodes to the zero value rather than erroring")
	}
}

// Decoding the real catalogue. The emptiness checks are the point: a renamed
// field is silent in Go, so asserting only "no error" would pass on a body that
// filled nothing in.
func TestLiveArchetypeCatalogDecodes(t *testing.T) {
	baseURL, apiKey := liveTarget(t)
	client := New(apiKey, WithBaseURL(baseURL))
	defer client.Close()

	catalog, err := client.Archetypes.List(context.Background())
	if err != nil {
		t.Fatalf("Archetypes.List: %v", err)
	}
	if len(catalog.Data) == 0 {
		t.Fatal("catalog.Data is empty — either the roster is empty or `data` was renamed")
	}
	if catalog.DefaultArchetypeID == "" {
		t.Fatal("DefaultArchetypeID is empty — the field did not decode")
	}
	for i, a := range catalog.Data {
		if a.ID == "" {
			t.Fatalf("archetype %d decoded with an empty id", i)
		}
	}
}

// The paginated envelope. `Data` may legitimately be empty on a fresh account,
// so this asserts the envelope decoded rather than that rows exist.
func TestLivePaginatedEnvelopeDecodes(t *testing.T) {
	baseURL, apiKey := liveTarget(t)
	client := New(apiKey, WithBaseURL(baseURL))
	defer client.Close()

	page, err := client.Sessions.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("Sessions.List: %v", err)
	}
	if page.Data == nil {
		t.Fatal("Data is nil — the server keys its rows somewhere other than `data`")
	}
}

// A rejected key must surface as the SDK's typed error. Callers are told to
// match on it; if a 401 arrived as a generic transport failure instead, every
// documented recovery path would miss it.
// The listing customers reach for first. Its envelope is built in its own route
// rather than shared with sessions, so the sessions arm proves nothing about it.
// A renamed field decodes to the zero value in Go without an error, so the
// emptiness check is the assertion — "err == nil" would pass on an empty body.
func TestLiveProfilesPageDecodes(t *testing.T) {
	baseURL, apiKey := liveTarget(t)
	client := New(apiKey, WithBaseURL(baseURL))
	defer client.Close()

	page, err := client.Profiles.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("Profiles.List against the real server: %v", err)
	}
	if page.Data == nil {
		t.Fatal("profile rows decoded to nil — the `data` tag no longer matches the server")
	}
}

// The one response whose envelope is NOT the paginated one: rows under
// `buckets`, with from_date/to_date instead of a cursor. It is the single
// endpoint where applying the pagination shape would be wrong, and Go says
// nothing when a tag stops matching — the fields simply stay zero.
func TestLiveUsageSeriesDecodes(t *testing.T) {
	baseURL, apiKey := liveTarget(t)
	client := New(apiKey, WithBaseURL(baseURL))
	defer client.Close()

	series, err := client.Usage.Series(context.Background(), 7)
	if err != nil {
		t.Fatalf("Usage.Series against the real server: %v", err)
	}
	if series.Buckets == nil {
		t.Fatal("buckets decoded to nil — the `buckets` tag no longer matches the server")
	}
	if series.FromDate == "" || series.ToDate == "" {
		t.Fatal("the series window decoded empty — from_date/to_date no longer match")
	}
}

func TestLiveRejectedKeyIsATypedAuthError(t *testing.T) {
	baseURL, _ := liveTarget(t)
	client := New("ds_live_definitely_not_a_real_key", WithBaseURL(baseURL))
	defer client.Close()

	_, err := client.Account.Me(context.Background())
	if err == nil {
		t.Fatal("a bogus key was accepted")
	}
	var authErr *AuthError
	var invalidErr *InvalidKeyError
	if !errors.As(err, &authErr) && !errors.As(err, &invalidErr) {
		t.Fatalf("a rejected key surfaced as %T (%v), not a typed auth error", err, err)
	}
}
