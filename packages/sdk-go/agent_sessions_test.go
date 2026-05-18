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
	"closed_at":              nil,
	"created_by_user_id":     nil,
	"mode":                   "ai",
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
	got, err := client.AgentSessions.Create(context.Background(), &CreateAgentSessionRequest{TokenBudget: 25_000}, nil)
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
	if _, err := client.AgentSessions.Create(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Create_IdempotencyKey(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// v2-#19 — SDK MUST forward IdempotencyKey via the
		// Idempotency-Key header so the server-side partial unique
		// index on (account_id, idempotency_key) collapses retries.
		if got := r.Header.Get("Idempotency-Key"); got != "idem-go-test" {
			t.Errorf("Idempotency-Key header=%q want %q", got, "idem-go-test")
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	if _, err := client.AgentSessions.Create(
		context.Background(),
		nil,
		&CreateOptions{IdempotencyKey: "idem-go-test"},
	); err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Create_NoIdempotencyKey_OmitsHeader(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Without opts, no Idempotency-Key header is sent — header is
		// opt-in, parity with the TS SDK.
		if got := r.Header.Get("Idempotency-Key"); got != "" {
			t.Errorf("expected no Idempotency-Key header; got %q", got)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	if _, err := client.AgentSessions.Create(context.Background(), nil, nil); err != nil {
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
	got, err := client.AgentSessions.Message(context.Background(), "agt_1", "open https://example.com", nil)
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
	got, err := client.AgentSessions.Message(context.Background(), "agt_1", "x", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "refuse" || got.RefuseReason != "AUP violation" {
		t.Errorf("unexpected refuse response: %+v", got)
	}
}

func TestAgentSessions_Message_ByokOption(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// BYOK convenience: the option must set the
		// x-byok-anthropic-api-key header. Matches the server-side
		// header reading at apps/server/src/routes/agent-sessions.ts
		// (commit 1b97a5e0).
		if got := r.Header.Get("x-byok-anthropic-api-key"); got != "sk-ant-test-byok" {
			t.Errorf("byok header=%q", got)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":               "clarify",
			"session":            agentSessionEnvelope,
			"clarifying_question": "?",
		})
	})
	_, err := client.AgentSessions.Message(
		context.Background(), "agt_1", "hi",
		&MessageOptions{ByokAPIKey: "sk-ant-test-byok"},
	)
	if err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Message_NoByokOmitsHeader(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Omitting the option (nil) sends NO byok header (distinguishes
		// "no key" from "empty key" at the server boundary).
		if r.Header.Get("x-byok-anthropic-api-key") != "" {
			t.Errorf("expected no byok header; got %q", r.Header.Get("x-byok-anthropic-api-key"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":               "clarify",
			"session":            agentSessionEnvelope,
			"clarifying_question": "?",
		})
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "hi", nil)
	if err != nil {
		t.Fatal(err)
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
