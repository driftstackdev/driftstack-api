package driftstack

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// CanonicalModifierNames — Slice 6 cross-SDK lock 2026-05-20 — mirrored
// from packages/api-types/src/agent-input-event.ts:
// CANONICAL_MODIFIER_NAMES. The 4 names map 1:1 onto Quartz CGEventFlags
// on the macOS harness side. Customers building their own input-event
// producer should reference this slice instead of hard-coding string
// literals.
var CanonicalModifierNames = []string{"cmd", "ctrl", "shift", "option"}

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

// LK.5 — LiveKitInfo is the per-Mac LiveKit join info returned on
// session-create (when a Mac is available) and by the dedicated
// POST /v1/agent-sessions/:id/livekit-token endpoint. Use with
// the official livekit-server-sdk-go consumer side.
//
// Token TTL is 24h. Room name is always the agent_session id.
type LiveKitInfo struct {
	WSURL               string `json:"ws_url"`
	Room                string `json:"room"`
	Token               string `json:"token"`
	ParticipantIdentity string `json:"participant_identity"`
	ExpiresAt           string `json:"expires_at"`
}

// AgentSession is the read envelope returned by Create / Get / and as
// the .Session field of every Message response.
type AgentSession struct {
	ID                   string  `json:"id"`
	AccountID            string  `json:"account_id"`
	DriftstackSessionID  *string `json:"driftstack_session_id"`
	Status               string  `json:"status"`
	ClosedReason         *string `json:"closed_reason"`
	TokenBudgetTotal     int     `json:"token_budget_total"`
	TokenBudgetRemaining int     `json:"token_budget_remaining"`
	TranscriptLength     int     `json:"transcript_length"`
	// v2-#19 wall-clock ISO-8601 close timestamp; nil while active.
	// Distinct from UpdatedAt which moves on every transcript append.
	ClosedAt *string `json:"closed_at"`
	// v2-#35 team-RBAC attribution; nil when account-scoped auth
	// can't resolve a specific user id.
	CreatedByUserID *string `json:"created_by_user_id"`
	// Arc 2 sub-slice 8.5 (v2-#8) — operational mode.
	Mode string `json:"mode"`
	// 6.c — the Claude 4.x model the AI agent runs for this session
	// (set at create-time; defaults to "claude-opus-4-8").
	Model string `json:"model"`
	// Slice 3 (Wave 29-NNN ARC 3) — pair-mode state machine
	// discriminator. nil when mode != "pair". {kind: "ai-driving" |
	// "takeover-pending" | ...} when mode == "pair"; see the
	// agent_pair_mode_state state union for the full set.
	PairModeState map[string]any `json:"pair_mode_state"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
	// LK.4 — auto-populated on POST /v1/agent-sessions when a Mac
	// has LiveKit credentials registered. nil on older deployments
	// or pre-Mac-registration. Fall back to LK.3 endpoint for an
	// explicit mint.
	LiveKit *LiveKitInfo `json:"livekit,omitempty"`
	// W2679 — worker-reported per-session liveness, re-based onto the
	// fleet heartbeat. Distinct from Status, which stays "active" until
	// close even when the worker crashed. nil (field omitted) when the
	// deployment has no fleet control plane OR no beat has reported the
	// session — treat nil as "unknown, trust the binding", never "dead".
	Liveness *SessionLiveness `json:"liveness,omitempty"`
}

// SessionLiveness is the worker-reported liveness for an agent session
// (W2679). State is the latest worker state ("active" | "provisioning" |
// "idle" | "terminating") or "" when the server reports null (seen but no
// live state). Fresh is whether the owning node's beat is recent enough to
// trust.
type SessionLiveness struct {
	State *string `json:"state"`
	Fresh bool    `json:"fresh"`
}

// CreateAgentSessionRequest is the optional body for Create.
type CreateAgentSessionRequest struct {
	DriftstackSessionID string `json:"driftstack_session_id,omitempty"`
	TokenBudget         int    `json:"token_budget,omitempty"`
	// Arc 2 sub-slice 8.5 (v2-#8) — operational mode. Empty string
	// omits the field on the wire so the server applies its default
	// ('ai').
	Mode string `json:"mode,omitempty"`
	// 6.c — Claude 4.x model the AI agent runs. Empty string omits the
	// field so the server applies its default ('claude-opus-4-8').
	// Valid: "claude-opus-4-8" | "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5".
	Model string `json:"model,omitempty"`
	// Attach a saved profile (persistent browser identity) so the session
	// resumes its stored state + saves back on end. Must be an owned profile id
	// (unknown/not-owned → 404). Empty string omits it (stateless session).
	ProfileID string `json:"profile_id,omitempty"`
	// Route the session through one of your account proxies (manage them at
	// /v1/account/me/proxies). Must be an owned proxy id (unknown/not-owned →
	// 404). Empty string omits it (default egress).
	ProxyID string `json:"proxy_id,omitempty"`
	// Start URL the remote browser opens on session launch. When supplied,
	// overrides the operator-default start URL. Must be an absolute http(s)
	// URL; file:, javascript:, data: schemes are rejected (400). Empty string
	// omits it (operator default).
	InitialURL string `json:"initial_url,omitempty"`
	// Explicit geolocation override. By default the device's
	// navigator.geolocation derives from the proxy exit IP (coherent with the
	// session's apparent network location) — omit this for most sessions.
	// Supply it only when you know the proxy's true physical location better
	// than IP geolocation; coordinates diverging from the exit country make
	// the fingerprint internally inconsistent (a detection signal).
	Geolocation *SessionGeolocation `json:"geolocation,omitempty"`
}

// SessionGeolocation is the explicit per-session geolocation override.
// Latitude -90..90, Longitude -180..180; Accuracy is meters (nil → device
// default).
type SessionGeolocation struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	Accuracy  *float64 `json:"accuracy,omitempty"`
}

// AgentMessageResponse is the discriminated turn-result. Branch on
// Kind: "plan-executed" (Intents + Results + OK populated),
// "clarify" (ClarifyingQuestion populated), or "refuse"
// (RefuseReason populated).
type AgentMessageResponse struct {
	Kind               string            `json:"kind"`
	Session            AgentSession      `json:"session"`
	Intents            []json.RawMessage `json:"intents,omitempty"`
	Results            []json.RawMessage `json:"results,omitempty"`
	OK                 bool              `json:"ok,omitempty"`
	ClarifyingQuestion string            `json:"clarifying_question,omitempty"`
	RefuseReason       string            `json:"refuse_reason,omitempty"`
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

// AgentSessionsListPage is the GET /v1/agent-sessions envelope — newest
// first, cursor-paginated (the standard { data, has_more, next_cursor }
// shape shared by recipes / crypto-orders). Was a non-paginated { data }
// hard-capped at 100, leaving older sessions unreachable.
type AgentSessionsListPage struct {
	Data       []AgentSession `json:"data"`
	HasMore    bool           `json:"has_more"`
	NextCursor *string        `json:"next_cursor"`
}

// ListAgentSessionsQuery holds the pagination knobs for List / Iterate.
type ListAgentSessionsQuery struct {
	Limit  int
	Cursor string
}

// List returns a page of the account's agent sessions, newest first. Pass nil
// for defaults; pass a Cursor (the prior page's NextCursor) to page. Mirrors
// the TS + Python SDK list().
func (r *AgentSessionsResource) List(ctx context.Context, query *ListAgentSessionsQuery) (*AgentSessionsListPage, error) {
	var out AgentSessionsListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/agent-sessions",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate yields every agent session across cursor pages (newest first). The
// callback returns false to stop early; an error from it is propagated back.
// Replaces the old hard 100-cap — a busy account can now reach its full
// AI-session history.
func (r *AgentSessionsResource) Iterate(ctx context.Context, query *ListAgentSessionsQuery, fn func(*AgentSession) (bool, error)) error {
	cursor := ""
	limit := 0
	if query != nil {
		limit = query.Limit
		cursor = query.Cursor
	}
	for {
		page, err := r.List(ctx, &ListAgentSessionsQuery{Limit: limit, Cursor: cursor})
		if err != nil {
			return err
		}
		for i := range page.Data {
			cont, err := fn(&page.Data[i])
			if err != nil {
				return err
			}
			if !cont {
				return nil
			}
		}
		next, done, err := advanceCursor(cursor, page.NextCursor)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		cursor = next
	}
}

// ConsequentialActionApproval re-sends a consequential action a prior turn
// halted on (W443/W445), so the executor proceeds + dispatches it instead of
// halting again. Category + MatchedText echo the halt's fields.
type ConsequentialActionApproval struct {
	Category    string `json:"category"`
	MatchedText string `json:"matched_text"`
}

// MessageOptions carries optional per-call overrides for Message.
//
// ByokAPIKey is the customer-supplied Anthropic API key (BYOK Tier-3
// LOCKED 2026-05-16). Forwarded as the x-byok-anthropic-api-key
// request header so callers don't construct it by hand. NEVER logged.
//
// ApproveConsequentialActions re-sends consequential actions a prior turn
// halted on so the executor proceeds instead of halting again (omitted from
// the request body when empty). Without it, Go callers were permanently
// stuck on any confirmation-required turn.
type MessageOptions struct {
	ByokAPIKey                  string
	ApproveConsequentialActions []ConsequentialActionApproval
}

// Message runs one decompose→execute turn. Closed sessions return
// 409 Conflict (mapped to ConflictError by the SDK).
//
// Pass `nil` for opts when no BYOK key is needed (the deployment
// fallback path).
func (r *AgentSessionsResource) Message(ctx context.Context, agentSessionID, userMessage string, opts *MessageOptions) (*AgentMessageResponse, error) {
	var out AgentMessageResponse
	body := map[string]any{"user_message": userMessage}
	// W443/W445 — re-send approved consequential actions in the wire's
	// snake_case shape so the executor skips the confirmation halt. Omitted
	// when empty (matches the route's optional schema + the TS/Python SDKs).
	if opts != nil && len(opts.ApproveConsequentialActions) > 0 {
		body["approve_consequential_actions"] = opts.ApproveConsequentialActions
	}
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/message",
		body:   body,
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

// SetMode sets the agent session's operational mode (Slice 3, Wave
// 29-NNN ARC 3).
//
// Atomic dual-column write of `mode` + `pair_mode_state` on the
// server. Transitioning INTO "pair" initializes pair_mode_state to
// {"kind":"ai-driving"}; transitioning OUT clears it to nil.
// Idempotent — a no-op transition returns the existing row with
// pair_mode_state preserved.
//
// `mode` must be one of "manual", "ai", "pair".
//
// Returns 409 ConflictError if the session is not active
// (closed/paused sessions reject the transition).
func (r *AgentSessionsResource) SetMode(ctx context.Context, agentSessionID, mode string) (*AgentSession, error) {
	var out AgentSession
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/mode",
		body:   map[string]string{"mode": mode},
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendInputEventResponse is the envelope POST /:id/input-event
// returns (Slice 4 + Slice 5, Wave 29-NNN ARC 3). Discriminated
// union via `Kind`:
//   - "pair-mode-takeover-fired" → PairModeState populated; the
//     first input-event in a pair-mode ai-driving session fired the
//     takeover-request transition.
//   - "forwarded" → DurationMS populated; the event was dispatched
//     to the harness (post-harness path).
type SendInputEventResponse struct {
	Kind          string         `json:"kind"`
	PairModeState map[string]any `json:"pair_mode_state,omitempty"`
	DurationMS    int            `json:"duration_ms,omitempty"`
}

// SendInputEvent forwards a raw LK.6 InputEvent to the harness
// (Slice 4, Wave 29-NNN ARC 3). The event map must be one of the
// 7 discriminated-union variants (mouseMove / mouseDown / mouseUp
// / keyDown / keyUp / wheel / ping); see packages/api-types/src/
// agent-input-event.ts for the canonical Zod schema.
//
// Modifier vocabulary (Slice 6 cross-SDK lock 2026-05-20): keyDown
// / keyUp `modifiers` arrays MUST use the 4-name set "cmd" / "ctrl"
// / "shift" / "option" (1:1 Quartz CGEventFlags). DOM-standard
// names (Shift / Control / Alt / Meta) round-trip through the
// schema unchanged but the harness decoder drops them.
//
// Pre-harness (today): server returns 503 FeatureUnavailable —
// the Mac fleet harness Swift work is on the Agent 1 roadmap
// post §10/§11+EG-WK close (6-9 weeks dedicated per the Tier-3
// Option A verdict 2026-05-19). SDK surface ships so consumers
// compile against the stable contract.
//
// Returns 409 ConflictError if the session is not active OR is
// in mode="ai" (input-event requires manual or pair mode).
// Returns 503 FeatureUnavailableError pre-harness.
// SendInputEventOptions carries the optional client_id required
// when the first input-event in a pair-mode ai-driving session
// fires the takeover-request transition (Slice 5).
type SendInputEventOptions struct {
	ClientID string
}

func (r *AgentSessionsResource) SendInputEvent(ctx context.Context, agentSessionID string, event map[string]any, opts *SendInputEventOptions) (*SendInputEventResponse, error) {
	var out SendInputEventResponse
	body := map[string]any{"event": event}
	if opts != nil && opts.ClientID != "" {
		body["client_id"] = opts.ClientID
	}
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/input-event",
		body:   body,
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// PairModeStateEnvelope is the response shape for Takeover + Handback.
// The pair_mode_state field carries the post-transition state
// discriminator (takeover-pending / takeover-queued / handback-pending
// / handback-queued) so callers can branch on whether the request was
// queued behind an in-flight decompose without a separate GET round-trip.
type PairModeStateEnvelope struct {
	PairModeState map[string]any `json:"pair_mode_state"`
}

// Takeover requests a human takeover on a pair-mode agent session.
//
// State machine: ai-driving → takeover-pending (or takeover-queued if
// the runtime is mid-decompose).
//
// Returns 409 PairModeStateInvalidTransitionError if the session is
// not in a state that permits takeover. Returns 409 ConflictError if
// the session is not mode='pair'.
func (r *AgentSessionsResource) Takeover(ctx context.Context, agentSessionID, clientID string) (*PairModeStateEnvelope, error) {
	var out PairModeStateEnvelope
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/takeover",
		body:   map[string]string{"client_id": clientID},
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// Handback requests handback from human back to AI on a pair-mode
// agent session.
//
// State machine: human-driving → handback-pending (or handback-queued
// if the runtime is mid-decompose).
//
// Returns 409 PairModeStateInvalidTransitionError if the session is
// not in human-driving.
func (r *AgentSessionsResource) Handback(ctx context.Context, agentSessionID string) (*PairModeStateEnvelope, error) {
	var out PairModeStateEnvelope
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/handback",
		body:   map[string]any{},
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// LivekitToken mints a fresh LiveKit JWT for the agent session's
// video room. Use this when the auto-populated LiveKit field on
// session-create is absent (pre-LK deployment) OR when the 24h
// token TTL has expired. Returns the same 5-field LiveKitInfo
// shape that AgentSession.LiveKit carries; one type, two paths.
//
// Errors (mapped to typed Driftstack errors):
//   - 403 — session is closed; cannot mint
//   - 404 — session unknown (or cross-account; existence not leaked)
//   - 503 — no Mac registered LiveKit yet, OR the stored Mac secret
//     can't be decrypted (operator action: re-run
//     POST /v1/mac-nodes/register)
func (r *AgentSessionsResource) LivekitToken(ctx context.Context, agentSessionID string) (*LiveKitInfo, error) {
	var out LiveKitInfo
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/livekit-token",
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// ResumeAgentSessionRequest is the optional body for Resume. ChallengeID
// (from the session.challenge_detected webhook) targets a specific active
// challenge; leave it empty for a manual override resume.
type ResumeAgentSessionRequest struct {
	ChallengeID string `json:"challenge_id,omitempty"`
}

// ResumeAgentSessionResponse is the 202 acknowledgement returned by Resume.
type ResumeAgentSessionResponse struct {
	Status    string `json:"status"`
	SessionID string `json:"session_id"`
}

// Resume resumes an agent session the harness auto-paused on a detected
// bot-challenge (DataDome / Arkose / PerimeterX / …), once you've resolved
// the challenge (e.g. in the live view). Best-effort dispatch to the node
// running the session. Pass a body with ChallengeID to target a specific
// challenge; pass nil for a manual override resume.
//
// Errors (mapped to typed Driftstack errors):
//   - 404 — session unknown (or cross-account; existence not leaked)
//   - 409 — session not active (terminal sessions can't be resumed)
func (r *AgentSessionsResource) Resume(ctx context.Context, agentSessionID string, body *ResumeAgentSessionRequest) (*ResumeAgentSessionResponse, error) {
	if body == nil {
		body = &ResumeAgentSessionRequest{}
	}
	var out ResumeAgentSessionResponse
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/resume",
		body:   body,
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}
