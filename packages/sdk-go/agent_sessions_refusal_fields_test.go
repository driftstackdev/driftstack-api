package driftstack

// An AI refusal carries what a program needs to react to it, as typed accessors.
//
// The API says which refusal this is in fields beside the sentence: why a closed
// session ended, that a stop could not be confirmed, that the customer's own key
// was the problem and how, how long to wait when too many AI turns are running.
// A program should branch on those fields, never on the wording. Each test sends
// the answer the API gives through the real client, streamed the way Message
// receives it, and reads the accessor off the error type a program catches.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// refusedWith sends one message against a server that answers with the given
// streamed problem, and returns the error and how many requests it took.
// Retries are ON (the default): "one request" is a fact about Message.
func refusedWith(t *testing.T, status int, body map[string]any, opts *MessageOptions) (int32, error) {
	t.Helper()
	var calls atomic.Int32
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeAgentMessageSSE(t, w, status, body)
	})
	_, err := client.AgentSessions.Message(context.Background(), "agt_1", "hello", opts)
	if err == nil {
		t.Fatal("the refusal did not come back as an error")
	}
	return calls.Load(), err
}

func TestAQuestionThatCouldNotBeAnsweredSaysWhyAndCarriesNoAnswer(t *testing.T) {
	t.Parallel()
	why := "The page could not be read back, so there is no answer to give."
	body := planExecutedBody()
	delete(body, "answer")
	delete(body, "notice")
	body["answer_unavailable"] = why
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeAgentMessageSSE(t, w, 200, body)
	})
	resp, err := client.AgentSessions.Message(context.Background(), "agt_1", "What is the total?", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.AnswerUnavailable != why {
		t.Errorf("AnswerUnavailable=%q", resp.AnswerUnavailable)
	}
	if resp.Answer != "" {
		t.Errorf("Answer=%q, want none", resp.Answer)
	}
}

func TestAClosedSessionSaysClosedAndWhySoNoSecondCallIsNeeded(t *testing.T) {
	t.Parallel()
	calls, err := refusedWith(t, 409, problemBody(409, "conflict", map[string]any{
		"session_status": "closed",
		"closed_reason":  "budget-exhausted",
	}), &MessageOptions{IdempotencyKey: "turn-1"})
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err=%v, want *ConflictError", err)
	}
	if conflict.SessionStatus() != "closed" || conflict.ClosedReason() != "budget-exhausted" {
		t.Errorf("SessionStatus=%q ClosedReason=%q", conflict.SessionStatus(), conflict.ClosedReason())
	}
	if conflict.TurnInProgress() || IsRetryable(err) {
		t.Errorf("TurnInProgress=%v IsRetryable=%v", conflict.TurnInProgress(), IsRetryable(err))
	}
	if calls != 1 {
		t.Errorf("requests=%d, want 1", calls)
	}
}

func TestAPausedSessionHasNoClosedReasonAndABusyOneHasNeither(t *testing.T) {
	t.Parallel()
	_, err := refusedWith(t, 409, problemBody(409, "conflict", map[string]any{"session_status": "paused"}), nil)
	var paused *ConflictError
	if !errors.As(err, &paused) || paused.SessionStatus() != "paused" || paused.ClosedReason() != "" {
		t.Errorf("paused: err=%v", err)
	}
	_, err = refusedWith(t, 409, problemBody(409, "conflict", map[string]any{"turn_in_progress": true}), nil)
	var busy *ConflictError
	if !errors.As(err, &busy) || !busy.TurnInProgress() || busy.SessionStatus() != "" || busy.ClosedReason() != "" {
		t.Errorf("busy: err=%v", err)
	}
}

func TestAClosedReasonThatIsNotAStringIsIgnored(t *testing.T) {
	t.Parallel()
	_, err := refusedWith(t, 409, problemBody(409, "conflict", map[string]any{
		"session_status": "closed",
		"closed_reason":  map[string]any{"nested": true},
	}), nil)
	var conflict *ConflictError
	if !errors.As(err, &conflict) || conflict.ClosedReason() != "" {
		t.Errorf("err=%v", err)
	}
}

func TestTooManyAITurnsRunningIsARateLimitErrorWorthRetryingSentOnce(t *testing.T) {
	t.Parallel()
	calls, err := refusedWith(t, 429, problemBody(429, "rate-limited", map[string]any{
		"detail":              "Your account already has 3 AI turns running on Driftstack’s included AI (limit 3). Wait for one to finish, then try again.",
		"retry_after_seconds": 5,
	}), &MessageOptions{IdempotencyKey: "turn-1"})
	var limited *RateLimitError
	if !errors.As(err, &limited) {
		t.Fatalf("err=%v, want *RateLimitError", err)
	}
	var sessionSlots *ConcurrencyLimitError
	if errors.As(err, &sessionSlots) {
		t.Error("the AI-turn limit must not read as the session-slot limit")
	}
	// Read from the BODY: a stream has no Retry-After header left to carry it.
	if limited.RetryAfterSeconds != 5 {
		t.Errorf("RetryAfterSeconds=%d", limited.RetryAfterSeconds)
	}
	if !IsRetryable(err) {
		t.Error("IsRetryable=false")
	}
	// "Retryable" is advice to the caller's loop. The SDK never resends a turn,
	// even with an Idempotency-Key on the request and retries enabled.
	if calls != 1 {
		t.Errorf("requests=%d, want 1", calls)
	}
}

func TestAStopThatCouldNotBeConfirmedIsTellableFromAINotBeingEnabled(t *testing.T) {
	t.Parallel()
	stopWith := func(ext map[string]any) (*FeatureUnavailableError, int32) {
		var calls atomic.Int32
		_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("content-type", "application/problem+json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(problemBody(503, "feature-unavailable", ext))
		})
		_, err := client.AgentSessions.Stop(context.Background(), "agt_1")
		var unavailable *FeatureUnavailableError
		if !errors.As(err, &unavailable) {
			t.Fatalf("err=%v, want *FeatureUnavailableError", err)
		}
		return unavailable, calls.Load()
	}
	unconfirmed, calls := stopWith(map[string]any{"stop_unconfirmed": true})
	if !unconfirmed.StopUnconfirmed() {
		t.Error("StopUnconfirmed=false on the unconfirmed stop")
	}
	// Stop is a POST without a key: the SDK does not retry it by itself.
	if calls != 1 {
		t.Errorf("requests=%d, want 1", calls)
	}
	notEnabled, _ := stopWith(nil)
	if notEnabled.StopUnconfirmed() || IsRetryable(notEnabled) {
		t.Errorf("StopUnconfirmed=%v IsRetryable=%v", notEnabled.StopUnconfirmed(), IsRetryable(notEnabled))
	}
}

func TestARejectedOwnKeySaysWhichKeyAndWhyAndIsNotWorthRetrying(t *testing.T) {
	t.Parallel()
	key := "sk-ant-api03-this-must-never-come-back"
	calls, err := refusedWith(t, 502, problemBody(502, "byok-anthropic-required", map[string]any{
		"detail":              "Anthropic rejected the API key sent with this request. No step was run.",
		"key_rejected":        true,
		"key_source":          "header",
		"key_rejected_reason": "invalid_or_unauthorized",
	}), &MessageOptions{ByokAPIKey: key})
	var rejected *ByokAnthropicRequiredError
	if !errors.As(err, &rejected) {
		t.Fatalf("err=%v, want *ByokAnthropicRequiredError", err)
	}
	if !rejected.KeyRejected() || rejected.KeySource() != "header" || rejected.KeyRejectedReason() != "invalid_or_unauthorized" {
		t.Errorf("KeyRejected=%v KeySource=%q KeyRejectedReason=%q", rejected.KeyRejected(), rejected.KeySource(), rejected.KeyRejectedReason())
	}
	if rejected.Status != 502 || IsRetryable(err) {
		t.Errorf("Status=%d IsRetryable=%v", rejected.Status, IsRetryable(err))
	}
	if calls != 1 {
		t.Errorf("requests=%d, want 1", calls)
	}
	raw, _ := json.Marshal(rejected.Problem)
	if strings.Contains(err.Error(), key) || strings.Contains(string(raw), key) {
		t.Error("the key came back in the error")
	}
}

func TestBillingANewerReasonAndNoKeyAtAllAreEachToldApart(t *testing.T) {
	t.Parallel()
	_, err := refusedWith(t, 502, problemBody(502, "byok-anthropic-required", map[string]any{
		"key_rejected": true, "key_source": "stored", "key_rejected_reason": "billing",
	}), nil)
	var billing *ByokAnthropicRequiredError
	if !errors.As(err, &billing) || billing.KeySource() != "stored" || billing.KeyRejectedReason() != "billing" {
		t.Errorf("billing: err=%v", err)
	}

	newerReason := "a_reason_added_after_this_sdk_was_released"
	_, err = refusedWith(t, 502, problemBody(502, "byok-anthropic-required", map[string]any{
		"key_rejected": true, "key_source": "workspace", "key_rejected_reason": newerReason,
	}), nil)
	var newer *ByokAnthropicRequiredError
	if !errors.As(err, &newer) || newer.KeySource() != "workspace" || newer.KeyRejectedReason() != newerReason {
		t.Errorf("newer: err=%v", err)
	}

	_, err = refusedWith(t, 502, problemBody(502, "byok-anthropic-required", nil), nil)
	var noKey *ByokAnthropicRequiredError
	if !errors.As(err, &noKey) || noKey.KeyRejected() || noKey.KeySource() != "" || noKey.KeyRejectedReason() != "" {
		t.Errorf("no key: err=%v", err)
	}
}
