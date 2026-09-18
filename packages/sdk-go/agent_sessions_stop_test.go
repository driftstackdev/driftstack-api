package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// B2 — POST /v1/agent-sessions/:id/stop. Stop is how a caller ends a running
// turn early; these assert the request the SDK actually puts on the wire and
// that both of the server's answers decode.
func TestAgentSessions_Stop_PostsToTheStopPathWithAnEmptyBody(t *testing.T) {
	t.Parallel()
	var method, path, body string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.EscapedPath()
		body = decodeBody(t, r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(StopAgentTurnResponse{Status: "stop_requested", SessionID: "agt 1"})
	})
	out, err := client.AgentSessions.Stop(context.Background(), "agt 1")
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/v1/agent-sessions/agt%201/stop" {
		t.Errorf("request = %s %s, want POST /v1/agent-sessions/agt%%201/stop", method, path)
	}
	// The server's body schema is strict: an empty object, never a stray field.
	if body != "{}" {
		t.Errorf("body = %q, want {}", body)
	}
	if out.Status != "stop_requested" || out.SessionID != "agt 1" {
		t.Errorf("unexpected response: %+v", out)
	}
}

// Idempotent: stopping a session with nothing running is a 200 that says so,
// not an error a caller has to special-case.
func TestAgentSessions_Stop_NoTurnRunningIsASuccess(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(StopAgentTurnResponse{Status: "no_turn_running", SessionID: "agt_1"})
	})
	out, err := client.AgentSessions.Stop(context.Background(), "agt_1")
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "no_turn_running" {
		t.Errorf("status = %q, want no_turn_running", out.Status)
	}
}

// The turn a Stop ended comes back on its own Message call as kind "stopped";
// the sentence and the phase must reach a Go caller, or it cannot tell a
// stopped turn from a failed one.
func TestAgentSessions_Message_DecodesAStoppedTurn(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"kind": "stopped",
			"session": {"id": "agt_1", "status": "active"},
			"intents": [{"kind": "navigate", "url": "https://example.test"}],
			"results": [{"kind": "success", "intent": {"kind": "navigate", "url": "https://example.test"}, "summary": "ok"}],
			"ok": false,
			"notice": "Stopped after step 1 of 3, as you asked.",
			"stopped_during": "executing"
		}`))
	})
	out, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Kind != "stopped" || out.OK {
		t.Errorf("kind/ok = %q/%v, want stopped/false", out.Kind, out.OK)
	}
	if out.Notice != "Stopped after step 1 of 3, as you asked." {
		t.Errorf("notice = %q", out.Notice)
	}
	if out.StoppedDuring != "executing" {
		t.Errorf("stopped_during = %q", out.StoppedDuring)
	}
	if len(out.Results) != 1 {
		t.Errorf("results = %d, want 1", len(out.Results))
	}
}
