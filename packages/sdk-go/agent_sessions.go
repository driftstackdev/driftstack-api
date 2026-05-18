package driftstack

import (
	"context"
	"encoding/json"
	"net/url"
)

// AgentSessionsResource handles /v1/agent-sessions/* (AI-D; planning
// 132 §"Phase 7"). Mirrors the TypeScript + Python agent-sessions
// resources.
//
// Server registers these endpoints as 503 FeatureUnavailable stubs
// until the LLM key path is enabled on the deployment. SDK surface
// is stable so consumers compile ahead of time.
type AgentSessionsResource struct {
	client *Client
}

// AgentSession is the read envelope returned by Create / Get / and as
// the .Session field of every Message response.
type AgentSession struct {
	ID                    string  `json:"id"`
	AccountID             string  `json:"account_id"`
	DriftstackSessionID   *string `json:"driftstack_session_id"`
	Status                string  `json:"status"`
	ClosedReason          *string `json:"closed_reason"`
	TokenBudgetTotal      int     `json:"token_budget_total"`
	TokenBudgetRemaining  int     `json:"token_budget_remaining"`
	TranscriptLength      int     `json:"transcript_length"`
	// v2-#19 wall-clock ISO-8601 close timestamp; nil while active.
	// Distinct from UpdatedAt which moves on every transcript append.
	ClosedAt              *string `json:"closed_at"`
	CreatedAt             string  `json:"created_at"`
	UpdatedAt             string  `json:"updated_at"`
}

// CreateAgentSessionRequest is the optional body for Create.
type CreateAgentSessionRequest struct {
	DriftstackSessionID string `json:"driftstack_session_id,omitempty"`
	TokenBudget         int    `json:"token_budget,omitempty"`
}

// AgentMessageResponse is the discriminated turn-result. Branch on
// Kind: "plan-executed" (Intents + Results + OK populated),
// "clarify" (ClarifyingQuestion populated), or "refuse"
// (RefuseReason populated).
type AgentMessageResponse struct {
	Kind                string            `json:"kind"`
	Session             AgentSession      `json:"session"`
	Intents             []json.RawMessage `json:"intents,omitempty"`
	Results             []json.RawMessage `json:"results,omitempty"`
	OK                  bool              `json:"ok,omitempty"`
	ClarifyingQuestion  string            `json:"clarifying_question,omitempty"`
	RefuseReason        string            `json:"refuse_reason,omitempty"`
}

// CreateOptions carries optional per-call overrides for Create.
//
// IdempotencyKey is the v2-#19 Stripe-pattern idempotency token.
// Forwarded as the Idempotency-Key request header so retries collapse
// onto the same server-side row. Server enforces (account_id,
// idempotency_key) uniqueness via a partial unique index; SDK just
// plumbs the header.
type CreateOptions struct {
	IdempotencyKey string
}

// Create mints a new agent chat session.
//
// Pass `nil` for opts to skip the Idempotency-Key header.
func (r *AgentSessionsResource) Create(ctx context.Context, body *CreateAgentSessionRequest, opts *CreateOptions) (*AgentSession, error) {
	var out AgentSession
	if body == nil {
		body = &CreateAgentSessionRequest{}
	}
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions",
		body:   body,
		out:    &out,
	}
	if opts != nil && opts.IdempotencyKey != "" {
		req.headers = map[string]string{"Idempotency-Key": opts.IdempotencyKey}
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get reads agent session state.
func (r *AgentSessionsResource) Get(ctx context.Context, agentSessionID string) (*AgentSession, error) {
	var out AgentSession
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// MessageOptions carries optional per-call overrides for Message.
//
// ByokAPIKey is the customer-supplied Anthropic API key (BYOK Tier-3
// LOCKED 2026-05-16). Forwarded as the x-byok-anthropic-api-key
// request header so callers don't construct it by hand. NEVER logged.
type MessageOptions struct {
	ByokAPIKey string
}

// Message runs one decompose→execute turn. Closed sessions return
// 409 Conflict (mapped to ConflictError by the SDK).
//
// Pass `nil` for opts when no BYOK key is needed (the deployment
// fallback path).
func (r *AgentSessionsResource) Message(ctx context.Context, agentSessionID, userMessage string, opts *MessageOptions) (*AgentMessageResponse, error) {
	var out AgentMessageResponse
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/message",
		body:   map[string]string{"user_message": userMessage},
		out:    &out,
	}
	if opts != nil && opts.ByokAPIKey != "" {
		req.headers = map[string]string{"x-byok-anthropic-api-key": opts.ByokAPIKey}
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// Close marks the agent session closed (idempotent).
func (r *AgentSessionsResource) Close(ctx context.Context, agentSessionID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID),
	})
}
