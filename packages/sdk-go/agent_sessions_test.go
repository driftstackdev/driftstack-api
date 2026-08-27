package driftstack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
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

func writeAgentMessageSSE(t *testing.T, w http.ResponseWriter, status int, body any) {
	t.Helper()
	terminal, err := json.Marshal(map[string]any{"status": status, "body": body})
	if err != nil {
		t.Fatal(err)
	}
	w.Header().Set("content-type", "text/event-stream; charset=utf-8")
	_, _ = w.Write([]byte(": stream open\n\n: heartbeat now\n\nevent: response\ndata: "))
	_, _ = w.Write(terminal)
	_, _ = w.Write([]byte("\n\n"))
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
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept=%q want text/event-stream", got)
		}
		writeAgentMessageSSE(t, w, http.StatusOK, map[string]any{
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

func TestAgentSessions_Message_IdempotencyKeyBesideBYOK(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Idempotency-Key"); got != "logical-turn-go-1" {
			t.Errorf("Idempotency-Key=%q want logical-turn-go-1", got)
		}
		if got := r.Header.Get("x-byok-anthropic-api-key"); got != "sk-ant-test-byok" {
			t.Errorf("x-byok-anthropic-api-key=%q want sk-ant-test-byok", got)
		}
		writeAgentMessageSSE(t, w, http.StatusOK, map[string]any{
			"kind":                "clarify",
			"session":             agentSessionEnvelope,
			"clarifying_question": "?",
		})
	})
	_, err := client.AgentSessions.Message(
		context.Background(),
		"agt_1",
		"submit once",
		&MessageOptions{
			ByokAPIKey:     "sk-ant-test-byok",
			IdempotencyKey: "logical-turn-go-1",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Message_StreamProblemAndMalformedTerminal(t *testing.T) {
	t.Run("typed problem", func(t *testing.T) {
		_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
			writeAgentMessageSSE(t, w, http.StatusTooManyRequests, map[string]any{
				"type":                "https://errors.driftstack.dev/rate-limited",
				"title":               "Too Many Requests",
				"status":              http.StatusTooManyRequests,
				"retry_after_seconds": 7,
			})
		})
		_, err := client.AgentSessions.Message(context.Background(), "agt_1", "hi", nil)
		var rateLimit *RateLimitError
		if !errors.As(err, &rateLimit) {
			t.Fatalf("error=%T %v, want *RateLimitError", err, err)
		}
		if rateLimit.RetryAfterSeconds != 7 {
			t.Errorf("retry_after_seconds=%d want 7", rateLimit.RetryAfterSeconds)
		}
	})

	t.Run("missing terminal", func(t *testing.T) {
		_, client := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			_, _ = w.Write([]byte(": heartbeat only\n\n"))
		})
		_, err := client.AgentSessions.Message(context.Background(), "agt_1", "hi", nil)
		if err == nil || !strings.Contains(err.Error(), "without a terminal response") {
			t.Fatalf("error=%v, want missing-terminal TransportError", err)
		}
	})
}

func TestAgentSessions_Message_StreamAbsoluteTimeout(t *testing.T) {
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(": stream open\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	})
	_, err := client.AgentSessions.Message(
		context.Background(),
		"agt_1",
		"hi",
		&MessageOptions{Timeout: 25 * time.Millisecond},
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v, want context deadline exceeded", err)
	}
}

func TestAgentSessions_Message_ApprovesConsequentialActions(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["user_message"] != "retry the purchase" {
			t.Errorf("user_message=%v", body["user_message"])
		}
		approvals, ok := body["approve_consequential_actions"].([]any)
		if !ok || len(approvals) != 1 {
			t.Fatalf("approve_consequential_actions=%v", body["approve_consequential_actions"])
		}
		first, _ := approvals[0].(map[string]any)
		if first["category"] != "purchase" || first["matched_text"] != "Buy now" {
			t.Errorf("approval=%v", first)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":    "plan-executed",
			"session": agentSessionEnvelope,
			"intents": []any{},
			"results": []any{},
			"ok":      true,
		})
	})
	if _, err := client.AgentSessions.Message(context.Background(), "agt_1", "retry the purchase", &MessageOptions{
		ApproveConsequentialActions: []ConsequentialActionApproval{
			{Category: "purchase", MatchedText: "Buy now"},
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_List(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/agent-sessions" {
			t.Errorf("method=%q path=%q", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data":        []any{agentSessionEnvelope},
			"has_more":    false,
			"next_cursor": nil,
		})
	})
	page, err := client.AgentSessions.List(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 {
		t.Errorf("len(data)=%d", len(page.Data))
	}
	if page.HasMore {
		t.Errorf("has_more=%v want false", page.HasMore)
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
			"kind":                "clarify",
			"session":             agentSessionEnvelope,
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
			"kind":                "clarify",
			"session":             agentSessionEnvelope,
			"clarifying_question": "?",
		})
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "hi", nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestAgentSessions_Message_EmptyByokKeyOmitsHeader(t *testing.T) {
	// Cross-SDK parity with TS + Python: passing a non-nil opts with
	// ByokAPIKey: "" must skip the header entirely. The TS + Python
	// fix in slices 105/106 closed the same gap on the server side —
	// the route used to read empty-string headers as "" instead of
	// undefined, silently skipping the bundled-LLM fallback. The
	// `opts.ByokAPIKey != ""` guard in agent_sessions.go line 155
	// already does this; this test pins the behaviour so a future
	// refactor that drops the guard (e.g. switching to
	// fmt.Sprintf("%v", opts.ByokAPIKey)) trips immediately.
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-byok-anthropic-api-key"); got != "" {
			t.Errorf("expected no byok header on empty ByokAPIKey; got %q", got)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"kind":                "clarify",
			"session":             agentSessionEnvelope,
			"clarifying_question": "?",
		})
	})
	_, err := client.AgentSessions.Message(
		context.Background(), "agt_1", "hi",
		&MessageOptions{ByokAPIKey: ""},
	)
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

// Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover/handback Go SDK.
func TestAgentSessions_Takeover(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions/agt_1/takeover" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"pair_mode_state":{"kind":"takeover-pending"}}`))
	})
	out, err := client.AgentSessions.Takeover(context.Background(), "agt_1", "cli_a")
	if err != nil {
		t.Fatal(err)
	}
	if out.PairModeState["kind"] != "takeover-pending" {
		t.Errorf("unexpected pair_mode_state.kind: %v", out.PairModeState["kind"])
	}
}

func TestAgentSessions_Handback(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions/agt_1/handback" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"pair_mode_state":{"kind":"handback-pending"}}`))
	})
	out, err := client.AgentSessions.Handback(context.Background(), "agt_1")
	if err != nil {
		t.Fatal(err)
	}
	if out.PairModeState["kind"] != "handback-pending" {
		t.Errorf("unexpected pair_mode_state.kind: %v", out.PairModeState["kind"])
	}
}

// LK.3 — POST /v1/agent-sessions/:id/livekit-token. Returns the
// same LiveKitInfo shape that AgentSession.LiveKit carries.
func TestAgentSessions_LivekitToken(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions/agt_1/livekit-token" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"ws_url": "wss://mac-009.driftstack.dev:8443",
			"room": "agt_1",
			"token": "eyJhbGciOiJIUzI1NiJ9.fake",
			"participant_identity": "subscriber_acc_1",
			"expires_at": "2026-05-19T00:00:00Z"
		}`))
	})
	out, err := client.AgentSessions.LivekitToken(context.Background(), "agt_1")
	if err != nil {
		t.Fatal(err)
	}
	if out.WSURL != "wss://mac-009.driftstack.dev:8443" {
		t.Errorf("unexpected ws_url: %q", out.WSURL)
	}
	if out.Token != "eyJhbGciOiJIUzI1NiJ9.fake" {
		t.Errorf("unexpected token: %q", out.Token)
	}
	if out.ExpiresAt != "2026-05-19T00:00:00Z" {
		t.Errorf("unexpected expires_at: %q", out.ExpiresAt)
	}
}

// LK.3 — URL-encodes the session id so ids with spaces don't
// break route matching server-side. Matches the
// TestAgentSessions_Get_URLEscapes pattern (url.PathEscape on
// the id segment, then assert r.URL.EscapedPath()).
func TestAgentSessions_LivekitToken_URLEscapes(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/v1/agent-sessions/agt%20xyz/livekit-token" {
			t.Errorf("escaped path=%q", r.URL.EscapedPath())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"ws_url": "wss://mac-010.driftstack.dev:8443",
			"room": "agt xyz",
			"token": "eyJhbGciOiJIUzI1NiJ9.fake",
			"participant_identity": "subscriber_acc_2",
			"expires_at": "2026-05-19T00:00:00Z"
		}`))
	})
	_, err := client.AgentSessions.LivekitToken(context.Background(), "agt xyz")
	if err != nil {
		t.Fatal(err)
	}
}

// Pagination. List and Iterate had no arms at all: the tests above cover Create,
// Get, Message, Close, Takeover, Handback and LivekitToken, so nothing asserted
// that a caller's Limit or Cursor ever reached the wire. The TS and Python SDKs
// carried the identical gap (V-1974, V-1976).
func TestAgentSessions_List_ForwardsPaginationOnlyWhenSet(t *testing.T) {
	t.Parallel()
	var rawQuery string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(AgentSessionsListPage{Data: []AgentSession{}, HasMore: false})
	})

	// The zero query: Go treats Limit 0 and Cursor "" as unset, so NOTHING may
	// reach the URL. A stray "limit=0" would be a different request.
	if _, err := client.AgentSessions.List(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "" {
		t.Errorf("nil query should send no params, got %q", rawQuery)
	}

	if _, err := client.AgentSessions.List(context.Background(), &ListAgentSessionsQuery{Limit: 25}); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "limit=25" {
		t.Errorf("limit alone: got %q, want %q", rawQuery, "limit=25")
	}

	if _, err := client.AgentSessions.List(context.Background(), &ListAgentSessionsQuery{Cursor: "cur_2"}); err != nil {
		t.Fatal(err)
	}
	if rawQuery != "cursor=cur_2" {
		t.Errorf("cursor alone: got %q, want %q", rawQuery, "cursor=cur_2")
	}
}

// The load-bearing one: page 2 must carry the cursor page 1 returned. Drop that
// handoff and the walk either repeats page 1 forever or stops early — neither is
// visible to a count of yielded items alone.
func TestAgentSessions_Iterate_ThreadsNextCursor(t *testing.T) {
	t.Parallel()
	var seenCursor []string
	cur2 := "cur_2"
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-sessions" || r.Method != "GET" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		seenCursor = append(seenCursor, r.URL.Query().Get("cursor"))
		w.Header().Set("content-type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			_ = json.NewEncoder(w).Encode(AgentSessionsListPage{
				Data:       []AgentSession{{ID: "agt_1", AccountID: "acc_1"}},
				HasMore:    true,
				NextCursor: &cur2,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(AgentSessionsListPage{
			Data:       []AgentSession{{ID: "agt_2", AccountID: "acc_1"}},
			HasMore:    false,
			NextCursor: nil,
		})
	})

	var ids []string
	err := client.AgentSessions.Iterate(
		context.Background(),
		&ListAgentSessionsQuery{Limit: 1},
		func(s *AgentSession) (bool, error) {
			ids = append(ids, s.ID)
			return true, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != "agt_1" || ids[1] != "agt_2" {
		t.Errorf("ids=%v", ids)
	}
	if len(seenCursor) != 2 || seenCursor[0] != "" || seenCursor[1] != "cur_2" {
		t.Errorf("cursor handoff: got %v, want [\"\" \"cur_2\"]", seenCursor)
	}
}
