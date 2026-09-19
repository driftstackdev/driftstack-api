package driftstack

// A program can run an AI task end to end with the Go SDK: create a session
// (with its own Anthropic key when it has one), send a task, watch it
// progress, read the answer and why it stopped, approve an action the agent
// paused on, and tell the AI-specific refusals apart. Each test drives the real
// client against an httptest server.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sseFrame(t *testing.T, event string, data any) string {
	t.Helper()
	buf, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return "event: " + event + "\ndata: " + string(buf) + "\n\n"
}

func sseTerminal(t *testing.T, status int, body any) string {
	t.Helper()
	return sseFrame(t, "response", map[string]any{"status": status, "body": body})
}

func problemBody(status int, typ string, ext map[string]any) map[string]any {
	out := map[string]any{
		"type":   "https://errors.driftstack.dev/" + typ,
		"title":  typ,
		"status": status,
	}
	for k, v := range ext {
		out[k] = v
	}
	return out
}

var stepResult = map[string]any{
	"kind":    "success",
	"intent":  map[string]any{"kind": "navigate", "url": "https://example.com"},
	"summary": "Opened example.com",
}

const turnNotice = "I did the steps above, but this was taking too long for one message."

func planExecutedBody() map[string]any {
	return map[string]any{
		"kind":    "plan-executed",
		"session": agentSessionEnvelope,
		"intents": []any{stepResult["intent"]},
		"results": []any{stepResult},
		"ok":      true,
		"answer":  "Example Domain",
		"notice":  turnNotice,
	}
}

// writeInPieces writes a stream in small pieces, flushing each, so frames
// arrive split across reads — mid-frame included.
func writeInPieces(w http.ResponseWriter, stream string, size int) {
	w.Header().Set("content-type", "text/event-stream; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	for i := 0; i < len(stream); i += size {
		end := i + size
		if end > len(stream) {
			end = len(stream)
		}
		_, _ = io.WriteString(w, stream[i:end])
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func TestCreateSendsYourAnthropicKeyBesideTheIdempotencyKey(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-byok-anthropic-api-key"); got != "sk-ant-test" {
			t.Errorf("x-byok-anthropic-api-key=%q", got)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "create-1" {
			t.Errorf("Idempotency-Key=%q", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		want := map[string]any{
			"mode":                           "ai",
			"model":                          "claude-opus-5",
			"skip_proxy_probe":               true,
			"continue_from_agent_session_id": "agt_0",
		}
		if !reflect.DeepEqual(body, want) {
			t.Errorf("body=%v want %v", body, want)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	_, err := client.AgentSessions.Create(context.Background(), &CreateAgentSessionRequest{
		Mode:                       "ai",
		Model:                      "claude-opus-5",
		SkipProxyProbe:             true,
		ContinueFromAgentSessionID: "agt_0",
	}, &CreateOptions{IdempotencyKey: "create-1", ByokAPIKey: "sk-ant-test"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreateOmitsTheKeyHeaderWhenTheKeyIsEmpty(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if _, present := r.Header["X-Byok-Anthropic-Api-Key"]; present {
			t.Error("an empty ByokAPIKey must not send the header")
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agentSessionEnvelope)
	})
	if _, err := client.AgentSessions.Create(context.Background(), nil, &CreateOptions{ByokAPIKey: ""}); err != nil {
		t.Fatal(err)
	}
}

func TestAPlanExecutedTurnCarriesTheAnswerAndTheNotice(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeAgentMessageSSE(t, w, 200, planExecutedBody())
	})
	resp, err := client.AgentSessions.Message(context.Background(), "agt_1", "what is the heading?", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Answer != "Example Domain" {
		t.Errorf("Answer=%q", resp.Answer)
	}
	if resp.Notice != turnNotice {
		t.Errorf("Notice=%q", resp.Notice)
	}
}

func TestProgressEventsReachOnStepAndOnEventInStreamOrder(t *testing.T) {
	t.Parallel()
	stream := ": stream open\n\n" +
		sseFrame(t, "phase", map[string]any{"phase": "planning"}) +
		sseFrame(t, "plan", map[string]any{"total": 1, "labels": []string{"Open"}}) +
		sseFrame(t, "step_start", map[string]any{"index": 0, "total": 1, "label": "Open"}) +
		sseFrame(t, "step", map[string]any{"index": 0, "result": stepResult}) +
		"event: phase\ndata: {not json\n\n" +
		sseFrame(t, "a_future_event", map[string]any{"anything": true}) +
		sseFrame(t, "answer", map[string]any{"answer": "Example Domain"}) +
		sseFrame(t, "notice", map[string]any{"notice": turnNotice}) +
		sseTerminal(t, 200, planExecutedBody())
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeInPieces(w, stream, 17)
	})

	var seen []string
	resp, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", &MessageOptions{
		OnStep: func(step AgentStepEvent) {
			seen = append(seen, "step:"+step.Result.Kind+":"+step.Result.Summary)
		},
		OnEvent: func(name string, data json.RawMessage) {
			if !json.Valid(data) {
				t.Errorf("event %q carried invalid JSON", name)
			}
			seen = append(seen, name)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The malformed `phase` frame is skipped; the unknown name still arrives.
	want := []string{"phase", "plan", "step_start", "step:success:Opened example.com", "a_future_event", "answer", "notice"}
	if !reflect.DeepEqual(seen, want) {
		t.Errorf("seen=%v\nwant %v", seen, want)
	}
	if resp.Kind != "plan-executed" || resp.Answer != "Example Domain" {
		t.Errorf("resp kind=%q answer=%q", resp.Kind, resp.Answer)
	}
}

func TestWithoutCallbacksTheSameStreamStillReturnsTheFinalResult(t *testing.T) {
	t.Parallel()
	stream := sseFrame(t, "step", map[string]any{"index": 0, "result": stepResult}) +
		sseTerminal(t, 200, planExecutedBody())
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeInPieces(w, stream, 9)
	})
	resp, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Answer != "Example Domain" {
		t.Errorf("Answer=%q", resp.Answer)
	}
}

func TestTheLiveReaderKeepsTheSingleTerminalRule(t *testing.T) {
	t.Parallel()
	opts := &MessageOptions{OnEvent: func(string, json.RawMessage) {}}
	cases := map[string]string{
		"multiple terminal":  sseTerminal(t, 200, planExecutedBody()) + sseTerminal(t, 200, planExecutedBody()),
		"without a terminal": sseFrame(t, "phase", map[string]any{"phase": "planning"}),
	}
	for want, stream := range cases {
		stream := stream
		_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			writeInPieces(w, stream, 64)
		})
		_, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", opts)
		var transport *TransportError
		if !errors.As(err, &transport) || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err=%v", want, err)
		}
	}
}

func TestTheLiveReaderKeepsTheByteCeiling(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		comment := ":" + strings.Repeat("x", 1024*1024) + "\n\n"
		for i := 0; i < 9; i++ {
			if _, err := io.WriteString(w, comment); err != nil {
				return
			}
		}
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", &MessageOptions{
		OnEvent: func(string, json.RawMessage) {},
	})
	if err == nil || !strings.Contains(err.Error(), "byte limit") {
		t.Fatalf("err=%v, want the byte-limit transport error", err)
	}
}

func TestTheLiveReaderKeepsTheAbsoluteTimeout(t *testing.T) {
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(": stream open\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", &MessageOptions{
		Timeout: 25 * time.Millisecond,
		OnEvent: func(string, json.RawMessage) {},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err=%v, want context deadline exceeded", err)
	}
}

func TestParsedResultsTypesEveryResultKindAndApprovalForBuildsTheApproval(t *testing.T) {
	t.Parallel()
	raw := `{"kind":"plan-executed","session":{},"ok":false,
	  "intents":[{"kind":"interact","action":"type","selector":"#card","sensitive":true}],
	  "results":[
	    {"kind":"success","intent":{"kind":"capture","capture":"screenshot"},"summary":"Captured","captureId":"cap_1"},
	    {"kind":"failure","intent":{"kind":"navigate","url":"https://x"},"reason":"did not load","diagnosis":{"category":"a_category_newer_than_this_sdk","retryable":false}},
	    {"kind":"confirmation_required","intent":{"kind":"interact","action":"tap","selector":"#pay"},"category":"payment","matchedText":"Pay now"}
	  ]}`
	var resp AgentMessageResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	results, err := resp.ParsedResults()
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("len=%d", len(results))
	}
	if results[0].CaptureID != "cap_1" || results[0].Intent.Capture != "screenshot" {
		t.Errorf("success=%+v", results[0])
	}
	if results[1].Diagnosis == nil || results[1].Diagnosis.Category != "a_category_newer_than_this_sdk" || results[1].Diagnosis.Retryable {
		t.Errorf("failure=%+v", results[1])
	}
	approval := ApprovalFor(results[2])
	if approval != (ConsequentialActionApproval{Category: "payment", MatchedText: "Pay now"}) {
		t.Errorf("approval=%+v", approval)
	}
	intents, err := resp.ParsedIntents()
	if err != nil {
		t.Fatal(err)
	}
	if len(intents) != 1 || !intents[0].Sensitive || intents[0].Action != "type" {
		t.Errorf("intents=%+v", intents)
	}
	// The approval goes on the wire as matched_text.
	buf, _ := json.Marshal(approval)
	if string(buf) != `{"category":"payment","matched_text":"Pay now"}` {
		t.Errorf("wire=%s", buf)
	}
}

func messageError(t *testing.T, status int, body map[string]any, opts *MessageOptions) error {
	t.Helper()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeAgentMessageSSE(t, w, status, body)
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "go", opts)
	if err == nil {
		t.Fatal("expected an error")
	}
	return err
}

func TestATurnInProgressArrivesAsAConflictErrorInsideTheStream(t *testing.T) {
	t.Parallel()
	err := messageError(t, 409, problemBody(409, "conflict", map[string]any{"turn_in_progress": true}), nil)
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err=%T %v", err, err)
	}
	if !conflict.TurnInProgress() || conflict.SessionStatus() != "" {
		t.Errorf("TurnInProgress=%v SessionStatus=%q", conflict.TurnInProgress(), conflict.SessionStatus())
	}
}

func TestATurnThatEndedTheSessionCarriesItsStatusSpendAndSteps(t *testing.T) {
	t.Parallel()
	body := problemBody(409, "conflict", map[string]any{
		"session_status":  "closed",
		"tokens_consumed": 1234,
		"usage":           map[string]any{"decomposer_kind": "claude", "cost_usd_cents": 3},
		"partial_results": []any{stepResult},
	})
	// Through the live reader too, so both paths map the problem the same way.
	err := messageError(t, 409, body, &MessageOptions{OnEvent: func(string, json.RawMessage) {}})
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err=%T %v", err, err)
	}
	if conflict.SessionStatus() != "closed" || conflict.TurnInProgress() {
		t.Errorf("SessionStatus=%q TurnInProgress=%v", conflict.SessionStatus(), conflict.TurnInProgress())
	}
	if tokens, ok := conflict.TokensConsumed(); !ok || tokens != 1234 {
		t.Errorf("TokensConsumed=%d,%v", tokens, ok)
	}
	if u := conflict.Usage(); u == nil || u.CostUSDCents == nil || *u.CostUSDCents != 3 {
		t.Errorf("Usage=%+v", u)
	}
	if steps := conflict.PartialResults(); len(steps) != 1 || steps[0].Summary != "Opened example.com" {
		t.Errorf("PartialResults=%+v", steps)
	}
}

func TestAnOpusModelOnTheIncludedAIIsAForbiddenErrorThatRequiresYourOwnKey(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/problem+json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(problemBody(403, "forbidden", map[string]any{
			"requires_own_key": true,
			"model":            "claude-opus-5",
		}))
	})
	_, err := client.AgentSessions.Create(context.Background(), &CreateAgentSessionRequest{Model: "claude-opus-5"}, nil)
	var forbidden *ForbiddenError
	if !errors.As(err, &forbidden) {
		t.Fatalf("err=%T %v", err, err)
	}
	if !forbidden.RequiresOwnKey() || forbidden.Model() != "claude-opus-5" {
		t.Errorf("RequiresOwnKey=%v Model=%q", forbidden.RequiresOwnKey(), forbidden.Model())
	}
}

func TestControlAnOrdinary403IsNotMistakenForTheOwnKeyRefusal(t *testing.T) {
	t.Parallel()
	err := errorFromResponse(403, []byte(`{"type":"https://errors.driftstack.dev/forbidden","title":"Forbidden","status":403}`), "")
	var forbidden *ForbiddenError
	if !errors.As(err, &forbidden) {
		t.Fatalf("err=%T", err)
	}
	if forbidden.RequiresOwnKey() || forbidden.Model() != "" {
		t.Errorf("RequiresOwnKey=%v Model=%q", forbidden.RequiresOwnKey(), forbidden.Model())
	}
}

func TestIdempotencyAndAIControlConflictsAreToldApartAndMalformedFieldsReadAsAbsent(t *testing.T) {
	t.Parallel()
	inProgress := errorFromResponse(409, []byte(`{"type":"https://errors.driftstack.dev/conflict","title":"Conflict","status":409,"idempotency_status":"in_progress"}`), "")
	var c1 *ConflictError
	if !errors.As(inProgress, &c1) || c1.IdempotencyStatus() != "in_progress" || c1.AIControlUnavailable() {
		t.Errorf("in-progress conflict=%+v", c1)
	}

	control := errorFromResponse(409, []byte(`{"type":"https://errors.driftstack.dev/conflict","title":"Conflict","status":409,
	  "ai_control_unavailable":true,"phase":"executing","tokens_consumed":"12","usage":"not an object","partial_results":{}}`), "")
	var c2 *ConflictError
	if !errors.As(control, &c2) {
		t.Fatalf("err=%T", control)
	}
	if !c2.AIControlUnavailable() || c2.Phase() != "executing" {
		t.Errorf("AIControlUnavailable=%v Phase=%q", c2.AIControlUnavailable(), c2.Phase())
	}
	if _, ok := c2.TokensConsumed(); ok {
		t.Error("a string tokens_consumed must read as absent")
	}
	if c2.Usage() != nil || c2.PartialResults() != nil {
		t.Errorf("Usage=%+v PartialResults=%+v", c2.Usage(), c2.PartialResults())
	}
}
