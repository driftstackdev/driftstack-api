package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Resource-level proof for the two direct browser operations whose results
// are safety-bearing. types_test.go owns the codec branches; these cases own
// the wire path/method, the request body and the fact that a contradictory or
// out-of-budget 200 body reaches the caller as an error rather than as a
// fabricated verdict.

func TestSessions_Login_SubmittedBranch(t *testing.T) {
	t.Parallel()
	var captured map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/ses_xx/login" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"submitted":true,"credentials_truncated":false,"logged_in":true,` +
			`"post_login_url":"https://example.test/account","duration_ms":12450}`))
	})

	got, err := client.Sessions.Login(context.Background(), "ses_xx", &SessionLoginRequest{
		Username: "user@example.test",
		Password: "not-logged",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Submitted || got.CredentialsTruncated || !got.LoggedIn || got.DurationMS != 12450 {
		t.Fatalf("unexpected outcome: %+v", got)
	}
	if got.PostLoginURL != "https://example.test/account" {
		t.Fatalf("post_login_url=%q", got.PostLoginURL)
	}
	// Optional selectors stay off the wire when the caller omits them.
	for _, key := range []string{"username_selector", "password_selector", "submit_selector", "success_selector", "timeout_seconds"} {
		if _, present := captured[key]; present {
			t.Errorf("%s was sent on the wire when omitted from the request", key)
		}
	}
}

func TestSessions_Login_SafeRefusalBranch(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"submitted":false,"credentials_truncated":true,` +
			`"logged_in":false,"duration_ms":600000}`))
	})

	got, err := client.Sessions.Login(context.Background(), "ses_xx", &SessionLoginRequest{
		Username: "user@example.test",
		Password: "not-logged",
	})
	if err != nil {
		t.Fatal(err)
	}
	// A truncated credential is a zero-submit refusal: no session, no URL.
	if got.Submitted || !got.CredentialsTruncated || got.LoggedIn || got.PostLoginURL != "" {
		t.Fatalf("unexpected refusal outcome: %+v", got)
	}
	if got.DurationMS != 600000 {
		t.Fatalf("duration_ms=%d", got.DurationMS)
	}
}

func TestSessions_Login_RejectsContradictoryBody(t *testing.T) {
	t.Parallel()
	// A refusal that also claims a submitted URL: accepting it would tell the
	// caller a credential reached the site when the harness refused to type it.
	_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"submitted":false,"credentials_truncated":true,"logged_in":false,` +
			`"post_login_url":"https://example.test/leak","duration_ms":1}`))
	})

	got, err := client.Sessions.Login(context.Background(), "ses_xx", &SessionLoginRequest{
		Username: "user@example.test",
		Password: "not-logged",
	})
	if err == nil {
		t.Fatalf("contradictory login body was accepted: %+v", got)
	}
}

func TestSessions_Search_CompletedBranch(t *testing.T) {
	t.Parallel()
	var captured map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/ses_xx/search" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"submitted":true,"query_truncated":false,` +
			`"results_visible":true,"duration_ms":8420}`))
	})

	got, err := client.Sessions.Search(context.Background(), "ses_xx", &SearchRequest{
		Query: "wireless headphones",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Submitted || got.QueryTruncated || got.DurationMS != 8420 {
		t.Fatalf("unexpected outcome: %+v", got)
	}
	if got.ResultsVisible == nil || !*got.ResultsVisible {
		t.Fatalf("results_visible=%v", got.ResultsVisible)
	}
	if captured["query"] != "wireless headphones" {
		t.Errorf("query=%v", captured["query"])
	}
}

func TestSessions_Search_SafeRefusalBranch(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"submitted":false,"query_truncated":true,"duration_ms":600000}`))
	})

	got, err := client.Sessions.Search(context.Background(), "ses_xx", &SearchRequest{
		Query: "wireless headphones",
	})
	if err != nil {
		t.Fatal(err)
	}
	// A truncated query is never submitted and carries no results assessment.
	if got.Submitted || !got.QueryTruncated || got.ResultsVisible != nil {
		t.Fatalf("unexpected refusal outcome: %+v", got)
	}
}

func TestSessions_Search_RejectsOverBudgetDuration(t *testing.T) {
	t.Parallel()
	// 600,000ms is the whole-intent producer fence; a larger duration means the
	// result did not come from the fenced producer.
	_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"submitted":true,"query_truncated":false,"duration_ms":600001}`))
	})

	got, err := client.Sessions.Search(context.Background(), "ses_xx", &SearchRequest{
		Query: "wireless headphones",
	})
	if err == nil {
		t.Fatalf("over-budget search body was accepted: %+v", got)
	}
}

func TestSessions_LoginAndSearch_EscapeSessionID(t *testing.T) {
	t.Parallel()
	var paths []string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.EscapedPath())
		if strings.HasSuffix(r.URL.Path, "/login") {
			_, _ = w.Write([]byte(`{"submitted":false,"credentials_truncated":true,` +
				`"logged_in":false,"duration_ms":1}`))
			return
		}
		_, _ = w.Write([]byte(`{"submitted":false,"query_truncated":true,"duration_ms":1}`))
	})

	weird := "ses_with/slash"
	if _, err := client.Sessions.Login(context.Background(), weird, &SessionLoginRequest{
		Username: "user@example.test",
		Password: "not-logged",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Sessions.Search(context.Background(), weird, &SearchRequest{
		Query: "wireless headphones",
	}); err != nil {
		t.Fatal(err)
	}

	want := []string{"/v1/sessions/ses_with%2Fslash/login", "/v1/sessions/ses_with%2Fslash/search"}
	if len(paths) != len(want) {
		t.Fatalf("paths=%v", paths)
	}
	for i, p := range paths {
		// An unescaped id would traverse into another session's namespace.
		if p != want[i] {
			t.Errorf("path[%d]=%q want %q", i, p, want[i])
		}
	}
}
