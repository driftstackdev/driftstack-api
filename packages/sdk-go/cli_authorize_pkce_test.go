package driftstack

// The desktop browser sign-in is bound to a code verifier that never leaves the
// device (RFC 7636 PKCE, S256): initiate carries its SHA-256 as code_challenge,
// exchange carries the verifier. These pin the wire shape the Go SDK sends, and
// that a caller who sets neither still sends exactly the old request.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
)

func TestAuth_CliAuthorize_SendsTheChallengeAtInitiateAndTheVerifierAtExchange(t *testing.T) {
	t.Parallel()
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	var initiateBody, exchangeBody map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/auth/cli-authorize/initiate":
			initiateBody = body
			_ = json.NewEncoder(w).Encode(CliAuthorizeInitiateResponse{Code: "c", UserCode: "ABCD-EFGH"})
		case "/v1/auth/cli-authorize/exchange":
			exchangeBody = body
			_ = json.NewEncoder(w).Encode(CliAuthorizeExchangeResponse{Status: "pending"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})

	if _, err := client.Auth.CliAuthorizeInitiate(context.Background(), &CliAuthorizeInitiateRequest{
		State:               "csrfnonce-1234567890abcdef",
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Auth.CliAuthorizeExchange(context.Background(), &CliAuthorizeExchangeRequest{
		Code:         "c",
		State:        "csrfnonce-1234567890abcdef",
		CodeVerifier: verifier,
	}); err != nil {
		t.Fatal(err)
	}

	if initiateBody["code_challenge"] != challenge || initiateBody["code_challenge_method"] != "S256" {
		t.Errorf("initiate body = %v", initiateBody)
	}
	if _, leaked := initiateBody["code_verifier"]; leaked {
		t.Errorf("initiate must not carry the verifier: %v", initiateBody)
	}
	if exchangeBody["code_verifier"] != verifier {
		t.Errorf("exchange body = %v", exchangeBody)
	}
}

func TestAuth_CliAuthorize_WithoutAChallengeSendsTheSameRequestAsBefore(t *testing.T) {
	t.Parallel()
	initiate, err := json.Marshal(CliAuthorizeInitiateRequest{State: "csrfnonce-1234567890abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	if string(initiate) != `{"state":"csrfnonce-1234567890abcdef"}` {
		t.Errorf("initiate = %s", initiate)
	}
	exchange, err := json.Marshal(CliAuthorizeExchangeRequest{Code: "c", State: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if string(exchange) != `{"code":"c","state":"s"}` {
		t.Errorf("exchange = %s", exchange)
	}
}
