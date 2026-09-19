package driftstack

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"time"
)

// CanonicalModifierNames is the modifier vocabulary for keyDown / keyUp input
// events, mirrored from the API's CANONICAL_MODIFIER_NAMES. Customers building
// their own input-event producer should reference this slice instead of
// hard-coding string literals.
var CanonicalModifierNames = []string{"cmd", "ctrl", "shift", "option"}

// AgentSessionsResource provides typed access to /v1/agent-sessions
// and its control subresources. An agent session is a browser the AI drives
// for you: Create one, send it a task with Message, read the outcome, and
// Close it.
//
// Availability depends on the deployment's agent-runtime configuration.
// Unsupported deployments return a typed FeatureUnavailable error.
type AgentSessionsResource struct {
	client *Client
}

// LiveKitInfo is the live-video join info returned on session-create
// (when live video is available) and by the dedicated
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
	ProvisioningDetail   *string `json:"provisioning_detail,omitempty"`
	TokenBudgetTotal     int     `json:"token_budget_total"`
	TokenBudgetRemaining int     `json:"token_budget_remaining"`
	TranscriptLength     int     `json:"transcript_length"`
	// ClosedAt is the ISO-8601 time the session left "active"; nil while
	// active. Distinct from UpdatedAt, which moves on every message.
	ClosedAt *string `json:"closed_at"`
	// CreatedByUserID is the team member who created the session; nil when
	// the API key is not tied to one.
	CreatedByUserID *string `json:"created_by_user_id"`
	// Mode is how the session is driven: "ai" (the default), "manual" or
	// "pair". Change it with SetMode.
	Mode string `json:"mode"`
	// Model is the Claude model the AI runs for this session (set at create;
	// defaults to "claude-sonnet-5").
	Model string `json:"model"`
	// StopOnExitIPChange is whether the session stops when its exit IP
	// changes (set at create; default false).
	StopOnExitIPChange bool `json:"stop_on_exit_ip_change"`
	// PairModeState is nil when mode != "pair"; otherwise {kind:
	// "ai-driving" | "takeover-pending" | ...}, which says whether a person is
	// mid-takeover.
	PairModeState map[string]any `json:"pair_mode_state"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
	// LiveKit is the live-video join info, returned on create when live video
	// is available for the session; nil otherwise. Mint one at any time with
	// LivekitToken.
	LiveKit *LiveKitInfo `json:"livekit,omitempty"`
	// Liveness says whether the browser behind this session is still
	// reporting in. Distinct from Status, which stays "active" until close
	// even if the browser has stopped. nil when nothing has been reported —
	// treat nil as "unknown", never "dead".
	Liveness *SessionLiveness `json:"liveness,omitempty"`
	// CapabilityReport is the latest report of what this live session can
	// do; nil when no report has arrived.
	CapabilityReport *AgentSessionCapabilityReport `json:"capability_report,omitempty"`
	// The structured reason a session degraded or failed. nil when nothing has
	// gone wrong. Carries Severity, CustomerActionable and Retryable, which is
	// what a caller needs to decide whether to surface the failure to a human or
	// simply try again — none of which was reachable from Go before.
	ErrorEvent *AgentSessionErrorEvent `json:"error_event,omitempty"`
}

// AgentSessionCapabilityReport is the latest report of what a session can do.
// Pointer fields are the ones the API models as nullable: nil means "not
// reported", which is distinct from a zero value.
type AgentSessionCapabilityReport struct {
	Timestamp            string `json:"timestamp"`
	ManualInputAvailable *bool  `json:"manual_input_available"`
	// "provisioning" | "live" | "blank" | "failed", or nil when unreported.
	StreamingState *string `json:"streaming_state"`
	// "live" | "dead_proxy", or nil when unreported.
	EgressState *string `json:"egress_state"`
	// "socks5" | "openvpn" | "wireguard".
	ProxyKind         string `json:"proxy_kind"`
	ProxyUDPSupported bool   `json:"proxy_udp_supported"`
	// "h2-only" | "h2-and-h3".
	TransportModeRequested string `json:"transport_mode_requested"`
	TransportModeActive    string `json:"transport_mode_active"`
	SafeguardsPassed       bool   `json:"safeguards_passed"`
	// The live exit identity this session's traffic leaves through, and the
	// IPs its WebRTC candidates surface. Pointer/slice fields are nil when NOT
	// OBSERVED (not reported yet), distinct from a zero value.
	ExitIP             *string  `json:"exit_ip"`
	ExitCountry        *string  `json:"exit_country"`
	ExitTimezone       *string  `json:"exit_timezone"`
	WebRTCCandidateIPs []string `json:"webrtc_candidate_ips"`
	ObservedAt         *string  `json:"observed_at"`
}

// AgentSessionErrorEvent is the structured failure report for a session.
//
// Severity is "info" | "warn" | "error" | "fatal". CustomerActionable says
// whether a human can do anything about it; Retryable says whether the same
// call is worth repeating. Detail is nil when the server has nothing to add
// beyond Summary.
type AgentSessionErrorEvent struct {
	Timestamp          string  `json:"timestamp"`
	Code               string  `json:"code"`
	Severity           string  `json:"severity"`
	Summary            string  `json:"summary"`
	Detail             *string `json:"detail"`
	CustomerActionable bool    `json:"customer_actionable"`
	Retryable          bool    `json:"retryable"`
}

// SessionLiveness is the reported liveness of the browser behind an agent
// session. State is its latest state ("active" | "provisioning" | "idle" |
// "terminating") or nil when the server reports null (seen but no live state).
// Fresh is whether that report is recent enough to trust.
type SessionLiveness struct {
	State *string `json:"state"`
	Fresh bool    `json:"fresh"`
}

// CreateAgentSessionRequest is the optional body for Create.
type CreateAgentSessionRequest struct {
	DriftstackSessionID string `json:"driftstack_session_id,omitempty"`
	// TokenBudget is the tokens the AI may spend over the whole session.
	// Zero omits it (default 100,000; at most 10,000,000). When it runs out
	// the session closes with ClosedReason "budget-exhausted".
	TokenBudget int `json:"token_budget,omitempty"`
	// Mode is how the session is driven. Empty string
	// omits the field on the wire so the server applies its default
	// ('ai': the AI plans and runs each message). "manual" records messages
	// for a person driving the browser; "pair" lets a person take over.
	Mode string `json:"mode,omitempty"`
	// Model is the Claude model the AI runs. Empty string omits the field so
	// the server applies its default ("claude-sonnet-5").
	// Valid: "claude-opus-5" | "claude-sonnet-5" | "claude-opus-4-8" | "claude-opus-4-7" |
	// "claude-sonnet-4-6" | "claude-haiku-4-5". Opus models run only on your
	// own Anthropic key: when the session would run on Driftstack's included
	// AI, Create returns a 403 *ForbiddenError whose RequiresOwnKey() is true.
	Model string `json:"model,omitempty"`
	// Attach a saved profile (persistent browser identity) so the session
	// resumes its stored state + saves back on end. Must be an owned profile id
	// (unknown/not-owned → 404); a profile can have one live session at a time
	// (409 *ProfileInUseError otherwise). Empty string omits it (stateless
	// session).
	ProfileID string `json:"profile_id,omitempty"`
	// Route the session through one of your account proxies (manage them at
	// /v1/account/me/proxies). Must be an owned proxy id (unknown/not-owned →
	// 404). The proxy is tested before launch (422
	// *ProxyValidationFailedError when it fails). Empty string omits it
	// (default egress).
	ProxyID string `json:"proxy_id,omitempty"`
	// SkipProxyProbe skips the pre-launch proxy test for this launch only —
	// for a proxy you know works but the test reports as unreachable.
	SkipProxyProbe bool `json:"skip_proxy_probe,omitempty"`
	// ContinueFromAgentSessionID carries a CLOSED session's conversation into
	// the new one, so the agent still has it. Unknown or not owned → 404; not
	// closed yet → 409. Empty string omits it.
	ContinueFromAgentSessionID string `json:"continue_from_agent_session_id,omitempty"`
	// A start page for the browser. Must be an absolute http(s) URL; file:,
	// javascript:, data: schemes are rejected (400). For an AI task, also put
	// the URL in your message. Empty string omits it.
	InitialURL string `json:"initial_url,omitempty"`
	// Explicit geolocation override. By default the device's
	// navigator.geolocation derives from the proxy exit IP (coherent with the
	// session's apparent network location) — omit this for most sessions.
	// Supply it only when you know the proxy's true physical location better
	// than IP geolocation; coordinates diverging from the exit country make
	// the fingerprint internally inconsistent (a detection signal).
	Geolocation *SessionGeolocation `json:"geolocation,omitempty"`
	// End the session if its exit IP changes mid-run. When true, the first
	// exit IP seen for the session is remembered and the session stops the
	// moment a later report shows a different one (ClosedReason
	// "exit_ip_changed"). Omit (false) → default.
	StopOnExitIPChange bool `json:"stop_on_exit_ip_change,omitempty"`
}

// SessionGeolocation is the explicit per-session geolocation override.
// Latitude -90..90, Longitude -180..180; Accuracy is meters (nil → device
// default).
type SessionGeolocation struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	Accuracy  *float64 `json:"accuracy,omitempty"`
}

// AgentUsage is the per-turn usage/cost block attached by the server on
// every Claude-backed message response (DecomposerKind == "claude");
// deterministic turns set DecomposerKind == "deterministic" with the
// token/cost fields absent (nil). Surface it as a
// "$0.0023 · 145 tok · <model>" badge; render "—" when the pointer
// fields are nil. Mirrors the TS SDK's AgentUsage field-for-field.
type AgentUsage struct {
	DecomposerKind        string  `json:"decomposer_kind"`
	AnthropicInputTokens  *int    `json:"anthropic_input_tokens,omitempty"`
	AnthropicOutputTokens *int    `json:"anthropic_output_tokens,omitempty"`
	CostUSDCents          *int    `json:"cost_usd_cents,omitempty"`
	Model                 *string `json:"model,omitempty"`
}

// AgentMessageResponse is the discriminated turn-result. Branch on
// Kind: "plan-executed" (Intents + Results + OK populated),
// "clarify" (ClarifyingQuestion populated), "refuse"
// (RefuseReason populated), or "stopped" (the turn was stopped with
// Stop: Intents + Results are the steps that ran, Notice says how far it
// got, StoppedDuring what it was doing). A "manual"-mode session answers
// "logged-manual" with only Session set. Treat any other Kind as a result
// this SDK version does not know.
//
// On "plan-executed", Answer is what you asked for (when you asked for
// information) and Notice, when set, says why the task is not finished yet.
// OK is true when the last planned steps ran cleanly; it does not by itself
// mean the task is finished. Read typed steps with ParsedResults.
type AgentMessageResponse struct {
	Kind    string       `json:"kind"`
	Session AgentSession `json:"session"`
	// Intents are the steps the agent planned. Read each step's outcome from
	// Results, which carries the step it ran; the two need not line up by
	// index. Decode them with ParsedIntents.
	Intents []json.RawMessage `json:"intents,omitempty"`
	// Results are every step that ran, in order. Decode them with
	// ParsedResults.
	Results            []json.RawMessage `json:"results,omitempty"`
	OK                 bool              `json:"ok,omitempty"`
	ClarifyingQuestion string            `json:"clarifying_question,omitempty"`
	// RefuseReason says why the agent will not do this. A refuse can also
	// mean the AI was briefly unavailable; the session stays active and you
	// can send the message again.
	RefuseReason string `json:"refuse_reason,omitempty"`
	// Answer is the agent's answer to the question the turn asked, read back
	// from the page; empty when the turn only acted (navigate, tap,
	// screenshot) or no answer could be read.
	Answer string `json:"answer,omitempty"`
	// Notice is set on a "plan-executed" turn that ended before the task was
	// finished — it reached a limit on steps, time or budget, or stopped
	// rather than repeat itself — or when the agent asked you something
	// part-way through; when it asks for "continue", send that as the next
	// message. On a "stopped" turn it is one sentence saying how far it got.
	Notice string `json:"notice,omitempty"`
	// StoppedDuring is what a "stopped" turn was doing when it noticed the
	// stop: "planning", "executing", "reading_page" or "answering".
	StoppedDuring string `json:"stopped_during,omitempty"`
	// Usage is the per-turn usage/cost block (nil on older servers or
	// turns that omit it).
	Usage *AgentUsage `json:"usage,omitempty"`
}

// AgentIntent is one step the agent planned. Kind is "navigate", "interact",
// "wait", "capture", "scroll" or "behavioral_pause"; only the fields for that
// kind are set. The set of kinds is open: treat one you do not recognise as a
// step you cannot describe, not as an error.
type AgentIntent struct {
	Kind string `json:"kind"`
	// navigate
	URL string `json:"url,omitempty"`
	// interact: Action is "tap" | "type" | "scroll" | "swipe" | "press".
	// Sensitive is true on a "type" step whose value (a card number, a
	// one-time code, a PIN) is withheld from the response.
	Action    string `json:"action,omitempty"`
	Selector  string `json:"selector,omitempty"`
	Value     string `json:"value,omitempty"`
	Sensitive bool   `json:"sensitive,omitempty"`
	// wait: Condition is "idle" | "selector_visible" (Selector for the latter).
	Condition string `json:"condition,omitempty"`
	TimeoutMs *int   `json:"timeoutMs,omitempty"`
	// capture: "screenshot" | "dom_snapshot" | "pdf".
	Capture string `json:"capture,omitempty"`
	// scroll: Direction is "up" | "down".
	Direction string `json:"direction,omitempty"`
	AmountPx  *int   `json:"amount_px,omitempty"`
	// behavioral_pause
	DurationMs       *int `json:"duration_ms,omitempty"`
	ReadingWordCount *int `json:"reading_word_count,omitempty"`
}

// AgentFailureDiagnosis is the machine-readable companion to a failed step's
// Reason. Category is an open set ("element_not_found", "page_load_failed",
// "condition_not_met", "capture_failed", "scroll_failed", "session_error",
// "invalid_request", "result_too_large", "element_covered",
// "target_unverified", "unknown", and more over time): treat a value you do
// not recognise as "unknown". Retryable true means replaying the same step
// automatically is safe; false means never auto-replay — the request may need
// correcting, or the step's outcome is unknown and the page must be checked.
type AgentFailureDiagnosis struct {
	Category  string `json:"category"`
	Retryable bool   `json:"retryable"`
}

// AgentIntentResult is the outcome of one step. Kind is "success" (Summary,
// and CaptureID for a capture), "failure" (Reason, and Diagnosis on current
// servers) or "confirmation_required": the agent stopped BEFORE a purchase, a
// payment or an account deletion and is waiting for your approval (Category,
// MatchedText). Approve it by sending the next message with
// ApproveConsequentialActions: []ConsequentialActionApproval{ApprovalFor(r)}.
// Kind and Category are open sets.
type AgentIntentResult struct {
	Kind        string                 `json:"kind"`
	Intent      AgentIntent            `json:"intent"`
	Summary     string                 `json:"summary,omitempty"`
	CaptureID   string                 `json:"captureId,omitempty"`
	Reason      string                 `json:"reason,omitempty"`
	Diagnosis   *AgentFailureDiagnosis `json:"diagnosis,omitempty"`
	Category    string                 `json:"category,omitempty"`
	MatchedText string                 `json:"matchedText,omitempty"`
}

// ParsedResults decodes Results into typed step outcomes.
func (r *AgentMessageResponse) ParsedResults() ([]AgentIntentResult, error) {
	out := make([]AgentIntentResult, 0, len(r.Results))
	for _, raw := range r.Results {
		var res AgentIntentResult
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, err
		}
		out = append(out, res)
	}
	return out, nil
}

// ParsedIntents decodes Intents into typed steps.
func (r *AgentMessageResponse) ParsedIntents() ([]AgentIntent, error) {
	out := make([]AgentIntent, 0, len(r.Intents))
	for _, raw := range r.Intents {
		var intent AgentIntent
		if err := json.Unmarshal(raw, &intent); err != nil {
			return nil, err
		}
		out = append(out, intent)
	}
	return out, nil
}

// ApprovalFor turns a "confirmation_required" step result into the approval
// that releases it (the result spells the text MatchedText; the request field
// is matched_text).
func ApprovalFor(res AgentIntentResult) ConsequentialActionApproval {
	return ConsequentialActionApproval{Category: res.Category, MatchedText: res.MatchedText}
}

// AgentStepEvent is one step as it lands on a turn's stream: Index is the
// step's 0-based position in the final Results.
type AgentStepEvent struct {
	Index  int               `json:"index"`
	Result AgentIntentResult `json:"result"`
}

// CreateOptions carries optional per-call overrides for Create.
//
// IdempotencyKey is the Stripe-pattern idempotency token.
// Forwarded as the Idempotency-Key request header so retries collapse
// onto the same server-side row. Server enforces (account_id,
// idempotency_key) uniqueness via a partial unique index; SDK just
// plumbs the header.
//
// ByokAPIKey is your own Anthropic API key, sent as the
// x-byok-anthropic-api-key header. Create uses it only to decide whether an
// Opus model is allowed (Opus runs only on your own key); send it on every
// Message too. NEVER logged.
type CreateOptions struct {
	IdempotencyKey string
	ByokAPIKey     string
}

// Create starts a new agent session. While the returned session's Status is
// "provisioning" its browser is still starting: poll Get until it reads
// "active" before sending a message ("closed" means it could not start — read
// ClosedReason).
//
// Pass `nil` for opts to skip the Idempotency-Key and key headers.
//
// Errors: 429 *ConcurrencyLimitError (your plan's concurrent-session limit),
// 409 *ProfileInUseError / *StorageQuotaExceededError, 422
// *ProxyValidationFailedError, 403 *ForbiddenError (no AI on the plan, or an
// Opus model without your own key — RequiresOwnKey), 404 *NotFoundError.
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
	if opts != nil {
		headers := map[string]string{}
		if opts.IdempotencyKey != "" {
			headers["Idempotency-Key"] = opts.IdempotencyKey
		}
		if opts.ByokAPIKey != "" {
			headers["x-byok-anthropic-api-key"] = opts.ByokAPIKey
		}
		if len(headers) > 0 {
			req.headers = headers
		}
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

// ConsequentialActionApproval approves an action a previous turn stopped on
// (a "confirmation_required" step result), so the paused steps continue.
// Category + MatchedText echo the result's fields; ApprovalFor builds one.
type ConsequentialActionApproval struct {
	Category    string `json:"category"`
	MatchedText string `json:"matched_text"`
}

// MessageOptions carries optional per-call overrides for Message.
//
// ByokAPIKey is your own Anthropic API key. Forwarded as the
// x-byok-anthropic-api-key request header so callers don't construct it by
// hand. It takes precedence over a stored key and over Driftstack's included
// AI. NEVER logged.
//
// ApproveConsequentialActions approves the actions the previous turn stopped
// on (omitted from the request body when empty). Send it as the very next
// message on the session: the paused steps then continue from where they
// stopped, without planning again. Any other message in between discards the
// paused steps, and the agent plans afresh.
type MessageOptions struct {
	ByokAPIKey string
	// IdempotencyKey identifies one logical turn. Reuse it after a lost or
	// ambiguous stream so the server replays the durable terminal result instead
	// of executing browser actions twice. Once the server has accepted a key,
	// the response it gives for that key is final, errors included: reuse the
	// same key only when you got no response at all, or a *ConflictError whose
	// IdempotencyStatus() is "in_progress" (the first attempt is still
	// running; it replays the result once it finishes). After any other error,
	// fix the cause or wait, then send with a NEW key. Change it too when the
	// session, message or approvals change.
	IdempotencyKey              string
	ApproveConsequentialActions []ConsequentialActionApproval
	// Timeout is the absolute heartbeat-stream backstop. Zero uses
	// AgentMessageStreamTimeout (50 minutes). An earlier caller context wins.
	Timeout time.Duration
	// OnStep, when set, is called with each step as it lands, before Message
	// returns. Best-effort: a malformed step frame is skipped.
	OnStep func(step AgentStepEvent)
	// OnEvent, when set, is called for every OTHER progress event on the
	// turn's stream, by name, with its JSON payload — today "phase", "plan",
	// "step_start", "answer" and "notice". The set of names is open: ignore the
	// ones you do not recognise. The final result is always Message's return
	// value, never one of these.
	OnEvent func(name string, data json.RawMessage)
}

// Message sends one message — a task or a question — and waits for the
// outcome. The call streams, so it can take several minutes; it returns when
// the turn ends. Branch on the response's Kind.
//
// Pass `nil` for opts when no key, idempotency key or approval is needed.
//
// Errors you should expect: 409 *ConflictError (TurnInProgress(): another
// message is still running — wait, or Stop it; SessionStatus(): the session
// has ended — start a new one), 429 *RateLimitError (the message rate, or too
// many AI turns running at once on your account), 429 *ConcurrencyLimitError
// (too many turns on the included AI at once), 403 *ForbiddenError (no AI on
// the plan, or RequiresOwnKey()), and 402 *BundledLlmBudgetExhaustedError /
// *BundledLlmConsentRequiredError or 502 *ByokAnthropicRequiredError when no
// AI key or budget is available.
func (r *AgentSessionsResource) Message(ctx context.Context, agentSessionID, userMessage string, opts *MessageOptions) (*AgentMessageResponse, error) {
	var out AgentMessageResponse
	body := map[string]any{"user_message": userMessage}
	// Re-send approved consequential actions in the wire's snake_case shape
	// so the paused steps continue. Omitted when empty (matches the route's
	// optional schema + the TS/Python SDKs).
	if opts != nil && len(opts.ApproveConsequentialActions) > 0 {
		body["approve_consequential_actions"] = opts.ApproveConsequentialActions
	}
	req := requestOptions{
		method:        "POST",
		path:          "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/message",
		body:          body,
		out:           &out,
		eventStream:   true,
		streamTimeout: AgentMessageStreamTimeout,
	}
	if opts != nil && opts.Timeout > 0 {
		req.streamTimeout = opts.Timeout
	}
	if opts != nil {
		headers := map[string]string{}
		if opts.ByokAPIKey != "" {
			headers["x-byok-anthropic-api-key"] = opts.ByokAPIKey
		}
		if opts.IdempotencyKey != "" {
			headers["Idempotency-Key"] = opts.IdempotencyKey
		}
		if len(headers) > 0 {
			req.headers = headers
		}
		if opts.OnStep != nil || opts.OnEvent != nil {
			req.onFrame = progressDispatcher(opts.OnStep, opts.OnEvent)
		}
	}
	if err := r.client.doEventStream(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// progressDispatcher routes one progress frame to the caller's callbacks.
func progressDispatcher(onStep func(AgentStepEvent), onEvent func(string, json.RawMessage)) func(string, []byte) {
	return func(name string, data []byte) {
		if name == "step" {
			if onStep == nil {
				return
			}
			var step AgentStepEvent
			if err := json.Unmarshal(data, &step); err != nil {
				return
			}
			onStep(step)
			return
		}
		if onEvent != nil && json.Valid(data) {
			onEvent(name, json.RawMessage(append([]byte(nil), data...)))
		}
	}
}

// Close ends the agent session and its browser (idempotent). Close every
// session you start — an open session keeps counting toward your plan's
// concurrent-session limit.
func (r *AgentSessionsResource) Close(ctx context.Context, agentSessionID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID),
	})
}

// SetMode sets the agent session's mode.
//
// Transitioning INTO "pair" initializes pair_mode_state to
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

// AgentSessionEgressResult is the discriminated result of an egress
// swap. Only Status "ok" means the egress changed; every other
// status leaves the session exactly as it was, with Reason saying why.
// ApplyPoint is present on success and is nil when the device accepted
// the swap without confirming when it takes effect — treat nil as
// possibly-immediate.
type AgentSessionEgressResult struct {
	Status     string  `json:"status"`
	ApplyPoint *string `json:"apply_point,omitempty"`
	Reason     string  `json:"reason,omitempty"`
}

// SetEgress moves a RUNNING session onto a different egress without
// restarting it.
//
// NOT AVAILABLE YET: no device can change egress on a running session,
// so this currently returns Status "unavailable" for every call —
// create a new session with the proxyID you want instead. The shapes
// are stable and will not change when device support lands.
//
// The page keeps its tabs, cookies and scroll position; only the exit
// changes.
//
// proxyID must be a proxy on your own account that has been tested at
// least once: the swap carries the exit's MEASURED identity — IP,
// country, timezone — to the device so the page keeps seeing a
// consistent origin. An untested proxy has no measured identity to
// carry, and the response is status "unavailable" rather than a
// guessed one.
//
// applyPoint may be "" (defaults to "next_navigation", swapping on the
// next page load and leaving connections in flight alone) or
// "immediate", which swaps at once and may reset connections mid-page.
//
// Read Status before assuming anything moved: only "ok" means the
// egress changed.
func (r *AgentSessionsResource) SetEgress(ctx context.Context, agentSessionID, proxyID, applyPoint string) (*AgentSessionEgressResult, error) {
	var out AgentSessionEgressResult
	body := map[string]string{"proxy_id": proxyID}
	if applyPoint != "" {
		body["apply_point"] = applyPoint
	}
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/egress",
		body:   body,
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendInputEventResponse is the envelope POST /:id/input-event
// returns. Discriminated union via `Kind`:
//   - "pair-mode-takeover-fired" → PairModeState populated; the
//     first input-event in a pair-mode ai-driving session asked for a
//     takeover.
//   - "forwarded" → DurationMS populated. No deployment forwards input
//     events, so this variant never arrives.
type SendInputEventResponse struct {
	Kind          string         `json:"kind"`
	PairModeState map[string]any `json:"pair_mode_state,omitempty"`
	DurationMS    int            `json:"duration_ms,omitempty"`
}

// SendInputEventOptions carries the optional client_id required
// when the first input-event in a pair-mode ai-driving session
// asks for a takeover.
type SendInputEventOptions struct {
	ClientID string
}

// SendInputEvent sends one raw input event to a manual or pair-mode
// session. The event map is one of the input-event variants (mouseMove /
// mouseDown / mouseUp / keyDown / keyUp / wheel / tap / touchStart /
// touchMove / touchEnd / swipe / ping).
//
// Modifier vocabulary: keyDown / keyUp `modifiers` arrays MUST use the
// 4-name set "cmd" / "ctrl" / "shift" / "option". DOM-standard names
// (Shift / Control / Alt / Meta) pass validation but are ignored.
//
// No deployment forwards input events to the browser. That does NOT make
// every call a 503. The response is a discriminated union and one arm is
// live today:
//
//   - "pair-mode-takeover-fired" (200): the FIRST input-event in a
//     mode="pair" session whose pair_mode_state.kind is "ai-driving"
//     asks for a takeover and returns the new state. It forwards
//     nothing, which is why "no deployment forwards input events" stays
//     true. ClientID is REQUIRED on this path.
//   - "forwarded": unreachable — it sits behind the "human-driving"
//     state, which no request can reach today. Branching on it is dead
//     code.
//
// Everything else returns 503 FeatureUnavailableError: mode="manual"
// always, and mode="pair" once the state has left "ai-driving".
//
// Returns 409 ConflictError if the session is not active, OR is in
// mode="ai" (input-event requires manual or pair mode), OR the pair-mode
// state is mid-transition. Returns 400 ValidationError when the
// pair-mode ai-driving path is taken without ClientID.
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
// Today no request can move a session into human-driving, so this returns
// the 409 below.
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

// LivekitToken mints a fresh live-video token for the agent session's
// video room. Use this when the LiveKit field on the created session is
// absent OR when the 24h token TTL has expired. Returns the same 5-field
// LiveKitInfo shape that AgentSession.LiveKit carries; one type, two paths.
//
// Errors (mapped to typed Driftstack errors):
//   - 403 — session is closed; cannot mint
//   - 404 — session unknown (or cross-account; existence not leaked)
//   - 503 — live video is not available for this session right now; try
//     again later, or contact support if it persists
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

// Resume resumes an agent session that paused on a detected bot check (a
// CAPTCHA or challenge page), once you've resolved it (e.g. in the live
// view). The session's Status stays "active" while it is paused; the
// session.challenge_detected webhook tells you it happened. Pass a body with
// ChallengeID to target a specific challenge; pass nil for a manual override
// resume.
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

// StopAgentTurnResponse is returned by Stop. Status is "stop_requested"
// (202: a turn was running and has been asked to stop) or "no_turn_running"
// (200: there was nothing to stop).
type StopAgentTurnResponse struct {
	Status    string `json:"status"`
	SessionID string `json:"session_id"`
}

// Stop stops the session's running turn. It returns as soon as the stop is
// requested and does not wait for the turn to wind down: the turn ends on its
// own Message call, which returns Kind "stopped" (or, if it was already
// finishing, its ordinary result) — that response is the signal that the
// session will accept the next message. A step that was already running when
// the stop arrived is given a short, bounded time to finish so its result is
// known; nothing is started after it. Safe to call again. Because Message
// blocks, call Stop from another goroutine (a timer, for example).
//
// Errors (mapped to typed Driftstack errors):
//   - 404 — session unknown (or cross-account; existence not leaked)
//   - 503 *FeatureUnavailableError — the stop could not be confirmed just
//     now; call Stop again
func (r *AgentSessionsResource) Stop(ctx context.Context, agentSessionID string) (*StopAgentTurnResponse, error) {
	var out StopAgentTurnResponse
	req := requestOptions{
		method: "POST",
		path:   "/v1/agent-sessions/" + url.PathEscape(agentSessionID) + "/stop",
		body:   struct{}{},
		out:    &out,
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}
