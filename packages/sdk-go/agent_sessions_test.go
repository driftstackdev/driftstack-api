package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

var agentSessionEnvelope = map[string]any{
	"id":                     "agt_inmem_00000001",
	"account_id":             "acc_1",
	"driftstack_session_id":  nil,
	"status":                 "active",
	"closed_reason":          nil,
	"token_budget_total":     100_000,
	"token_budget_remaining": 100_000,
	"transcript_length":      0,
	"created_at":             "2026-05-16T00:00:00Z",
	"updated_at":             "2026-05-16T00:00:00Z",
}

func TestAgentSessions_Create(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	got, err := client.AgentSessions.Create(context.Background(), &CreateAgentSessionRequest{TokenBudget: 25_000})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "agt_inmem_00000001" {
		t.Errorf("id=%q", got.ID)
	}
}

func TestAgentSessions_Create_NilBody(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	if _, err := client.AgentSessions.Create(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Get_URLEscapes(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/v1/agent-sessions/agt%20xyz" {
			t.Errorf("escaped path=%q", r.URL.EscapedPath())
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	if _, err := client.AgentSessions.Get(context.Background(), "agt xyz"); err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Message_Plan(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions/agt_1/message" {
			t.Errorf("path=%q", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["user_message"] != "open https://example.com" {
			t.Errorf("user_message=%q", body["user_message"])
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":    "plan-executed",
			"session": agentSessionEnvelope,
			"intents": []any{map[string]any{"kind": "navigate", "url": "https://example.com"}},
			"results": []any{},
			"ok":      true,
		})
	})
	got, err := client.AgentSessions.Message(context.Background(), "agt_1", "open https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "plan-executed" {
		t.Errorf("kind=%q", got.Kind)
	}
	if !got.OK {
		t.Errorf("expected ok=true")
	}
}

func TestAgentSessions_Message_Refuse(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":          "refuse",
			"session":       agentSessionEnvelope,
			"refuse_reason": "AUP violation",
		})
	})
	got, err := client.AgentSessions.Message(context.Background(), "agt_1", "x")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "refuse" || got.RefuseReason != "AUP violation" {
		t.Errorf("unexpected refuse response: %+v", got)
	}
}

func TestAgentSessions_Close(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions/agt_1" || r.Method != "DELETE" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.AgentSessions.Close(context.Background(), "agt_1"); err != nil {
		t.Fatal(err)
	}
}
