package driftstack

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Mfa, Legal and EmailPreferences — driven against a real server.
//
// These three had no behavioural coverage here, and the same three are the
// least-covered resources in the TypeScript and Python SDKs too. That is a
// pattern rather than a coincidence: they were added later and never got
// behavioural tests in any language.
//
// They are not unguarded. Server-side content-parity pins hold each method's
// verb, path and doc comment, and those pins are exhaustive — divergences
// introduced against the Python equivalents all red, including one that swapped
// two paths so the file's path set stayed identical.
//
// What no source-text pin can show is that calling the method puts that request
// on the wire. These go through the same httptest harness the rest of this
// package uses, so what is asserted is the HTTP the SDK actually emits.

func decodeBody(t *testing.T, r *http.Request) string {
	t.Helper()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(raw))
}

// Status reads, Enroll mints. One path segment apart, and confusing them would
// hand a customer a fresh secret every time they opened the page.
func TestMfa_StatusAndEnrollHitDistinctPaths(t *testing.T) {
	t.Parallel()
	seen := map[string]string{}
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		seen[r.URL.Path] = r.Method
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/account/mfa":
			_ = json.NewEncoder(w).Encode(MfaStatus{Enrolled: false})
		default:
			_ = json.NewEncoder(w).Encode(MfaEnrollResponse{OtpauthURI: "otpauth://x", Digits: 6})
		}
	})

	if _, err := client.Mfa.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Mfa.Enroll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if seen["/v1/account/mfa"] != "GET" {
		t.Errorf("status: got %q on /v1/account/mfa, want GET", seen["/v1/account/mfa"])
	}
	if seen["/v1/account/mfa/enroll"] != "POST" {
		t.Errorf("enroll: got %q on /v1/account/mfa/enroll, want POST", seen["/v1/account/mfa/enroll"])
	}
}

// Rewriting or dropping this body makes every enrollment fail with a correct
// code, and the failure looks like the customer mistyping.
func TestMfa_VerifySendsTheCallersCodeVerbatim(t *testing.T) {
	t.Parallel()
	var got string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/account/mfa/verify" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		got = decodeBody(t, r)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MfaVerifyResponse{RecoveryCodes: []string{"a", "b"}})
	})

	out, err := client.Mfa.Verify(context.Background(), &MfaVerifyRequest{Code: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `"code":"123456"`) {
		t.Errorf("verify body = %s, want the caller's code", got)
	}
	if len(out.RecoveryCodes) != 2 {
		t.Errorf("recovery codes = %v", out.RecoveryCodes)
	}
}

// The body is a literal confirmation phrase, not a TOTP code — a deliberate
// speed bump in front of removing the customer's second factor.
func TestMfa_DisableUsesDeleteAndCarriesTheConfirmationPhrase(t *testing.T) {
	t.Parallel()
	var method, body string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, body = r.Method, decodeBody(t, r)
		w.WriteHeader(http.StatusNoContent)
	})

	if err := client.Mfa.Disable(
		context.Background(),
		&MfaDisableRequest{Confirm: "disable-mfa"},
	); err != nil {
		t.Fatal(err)
	}
	if method != "DELETE" {
		t.Errorf("disable method = %q, want DELETE", method)
	}
	if !strings.Contains(body, `"confirm":"disable-mfa"`) {
		t.Errorf("disable body = %s, want the confirmation phrase", body)
	}
}

func TestMfa_RegenerateRecoveryCodesPostsToItsOwnPath(t *testing.T) {
	t.Parallel()
	var path, method string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		path, method = r.URL.Path, r.Method
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MfaVerifyResponse{RecoveryCodes: []string{}})
	})

	if _, err := client.Mfa.RegenerateRecoveryCodes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if path != "/v1/account/mfa/recovery-codes/regenerate" || method != "POST" {
		t.Errorf("regenerate: got %s %s", method, path)
	}
}

// The catalogue versus what this account still owes. A copy-paste between them
// would tell a customer they have nothing left to accept.
func TestLegal_DocumentsAndRequiredAreDistinctReads(t *testing.T) {
	t.Parallel()
	var paths []string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	})

	if _, err := client.Legal.Documents(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Legal.Required(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[0] != "/v1/legal/documents" || paths[1] != "/v1/legal/required" {
		t.Errorf("legal paths = %v, want documents then required", paths)
	}
	if paths[0] == paths[1] {
		t.Errorf("documents and required must not resolve to the same path")
	}
}

// ContentHash binds the acceptance to an exact document version; a body that
// drops it records consent to nothing in particular.
func TestLegal_AcceptPostsTheAcceptanceTupleVerbatim(t *testing.T) {
	t.Parallel()
	var body string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/legal/accept" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		body = decodeBody(t, r)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"accepted_at":"2026-08-01T00:00:00Z"}`))
	})

	if _, err := client.Legal.Accept(context.Background(), &AcceptLegalDocumentRequest{
		DocumentKey: "tos",
		Version:     "2026-01",
		ContentHash: "abc123",
	}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"tos", "2026-01", "abc123"} {
		if !strings.Contains(body, want) {
			t.Errorf("accept body = %s, missing %q", body, want)
		}
	}
}

// PUT rather than POST: the server treats this as an idempotent upsert of one
// event type, so a POST would be a different contract.
func TestEmailPreferences_SetUsesPut(t *testing.T) {
	t.Parallel()
	var method string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		w.WriteHeader(http.StatusNoContent)
	})

	if err := client.EmailPreferences.Set(context.Background(), &SetEmailPreferenceRequest{
		EventType: "billing-receipt",
		OptedIn:   true,
	}); err != nil {
		t.Fatal(err)
	}
	if method != "PUT" {
		t.Errorf("set method = %q, want PUT", method)
	}
}

// OptOut and OptIn delegate to the same Set one boolean apart. Swapping them
// opts a customer back IN to mail they asked to stop — a consent defect, and
// one a reader skimming two near-identical one-line methods will not see.
func TestEmailPreferences_OptOutAndOptInSendOppositePolarity(t *testing.T) {
	t.Parallel()
	var bodies []string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		bodies = append(bodies, decodeBody(t, r))
		w.WriteHeader(http.StatusNoContent)
	})

	if err := client.EmailPreferences.OptOut(context.Background(), "billing-receipt"); err != nil {
		t.Fatal(err)
	}
	if err := client.EmailPreferences.OptIn(context.Background(), "billing-receipt"); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 {
		t.Fatalf("expected two requests, got %d", len(bodies))
	}
	if !strings.Contains(bodies[0], `"opted_in":false`) {
		t.Errorf("OptOut body = %s, want opted_in false", bodies[0])
	}
	if !strings.Contains(bodies[1], `"opted_in":true`) {
		t.Errorf("OptIn body = %s, want opted_in true", bodies[1])
	}
	// Asserted against each other as well: identical polarity on both sides
	// would fail above only by accident of which literal happened to be wrong.
	if bodies[0] == bodies[1] {
		t.Errorf("OptOut and OptIn sent the same body: %s", bodies[0])
	}
}

// So opting out of one email does not silence a different one.
func TestEmailPreferences_OptOutForwardsTheEventTypeItWasGiven(t *testing.T) {
	t.Parallel()
	var body string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		body = decodeBody(t, r)
		w.WriteHeader(http.StatusNoContent)
	})

	if err := client.EmailPreferences.OptOut(context.Background(), "tier-changed"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"event_type":"tier-changed"`) {
		t.Errorf("OptOut body = %s, want the event type it was given", body)
	}
}
