package driftstack

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// This file mirrors the Zod schemas in `packages/api-types/`. The
// schemas are the source of truth (Zod → OpenAPI 3.1 → these types).
// Re-generated when schemas change; tracked manually for now since
// oapi-codegen lacks OpenAPI 3.1 support (see the CHANGELOG for the
// codegen-vs-hand-written decision).
//
// Naming follows the Stripe-Go convention: PascalCase exported types,
// json tags using the underscore_case names the wire uses, omitempty
// on optional fields so customers can construct partial inputs.

// ──────────────────────────────────────────────────────────────────
// Common / shared
// ──────────────────────────────────────────────────────────────────

// AccountTier is the closed enum of pricing tiers: the two-ladder set of
// manual plans and API plans, plus free and enterprise. The `trial_pack`
// tier was retired on 2026-05-27; those accounts read as `free`.
type AccountTier string

const (
	TierFree         AccountTier = "free"
	TierSoloManual   AccountTier = "solo_manual"
	TierTeamManual   AccountTier = "team_manual"
	TierAgencyManual AccountTier = "agency_manual"
	TierAPIStarter   AccountTier = "api_starter"
	TierAPIBuilder   AccountTier = "api_builder"
	TierAPIScale     AccountTier = "api_scale"
	TierEnterprise   AccountTier = "enterprise"
)

// The tier names below belong to the single pricing ladder that ran until
// 2026-05-05. They are restored so a program written against v0.1.6 still
// compiles, and will be removed in a later minor release. No account is on
// any of them: the server never returns these values, so a comparison
// against one is always false. Replace each with the constant its notice
// names.
const (
	// Deprecated: the Starter plan is now API Starter.
	// Use TierAPIStarter.
	TierStarter AccountTier = "starter"
	// Deprecated: the Solo plan was split across the manual and API ladders
	// and has no single successor. Use TierSoloManual or TierTeamManual,
	// whichever matches what the account pays for.
	TierSolo AccountTier = "solo"
	// Deprecated: the Builder plan is now API Builder.
	// Use TierAPIBuilder.
	TierBuilder AccountTier = "builder"
	// Deprecated: the Scale plan is now API Scale.
	// Use TierAPIScale.
	TierScale AccountTier = "scale"
)

// AccountStatus.
type AccountStatus string

const (
	AccountActive    AccountStatus = "active"
	AccountSuspended AccountStatus = "suspended"
	AccountDeleted   AccountStatus = "deleted"
)

// APIKeyScope. The server split the legacy single `admin` scope into
// `account_owner` (customer self-serve) and `driftstack_internal_admin`
// (staff cross-account). The legacy `admin` token remains a customer-side
// alias for `account_owner` and `admin:*`; it never grants staff authority.
type APIKeyScope string

const (
	ScopeRead                    APIKeyScope = "read"
	ScopeWrite                   APIKeyScope = "write"
	ScopeAdmin                   APIKeyScope = "admin" // compat alias
	ScopeAccountOwner            APIKeyScope = "account_owner"
	ScopeDriftstackInternalAdmin APIKeyScope = "driftstack_internal_admin"
	ScopeGUIControl              APIKeyScope = "gui_control"
)

// SessionStatus is the lifecycle state of a session.
type SessionStatus string

const (
	SessionCreating  SessionStatus = "creating"
	SessionReady     SessionStatus = "ready"
	SessionBusy      SessionStatus = "busy"
	SessionDestroyed SessionStatus = "destroyed"
	SessionErrored   SessionStatus = "errored"
)

// SessionPurpose declares what a session is for; it selects the browser
// driver the session runs on. Customer traffic uses DefaultSessionPurpose;
// the other values exist for Driftstack's own validation runs and are not
// normally what you want.
type SessionPurpose string

// Purpose values — these are the only values the server's
// SessionPurposeSchema accepts. The previous Go SDK enum
// (`recapture_run` / `fingerprint_probe` / `behavioural_capture`)
// matched no server enum value and would 400 if a customer used
// them.
const (
	PurposeProductionCustomer      SessionPurpose = "production_customer"
	PurposeCumulativeRigValidation SessionPurpose = "cumulative_rig_validation"
	PurposeTestDomainProbe         SessionPurpose = "test_domain_probe"
)

// DefaultSessionPurpose matches packages/api-types DEFAULT_SESSION_PURPOSE.
const DefaultSessionPurpose = PurposeProductionCustomer

// BehavioralProfile selects the human-behaviour persona a session uses
// when it taps, scrolls and types. These are the only values the
// server's BehavioralProfileSchema accepts.
type BehavioralProfile string

const (
	PersonaCasual    BehavioralProfile = "casual"
	PersonaRegular   BehavioralProfile = "regular"
	PersonaPowerUser BehavioralProfile = "power_user"
)

// DefaultBehavioralProfile matches packages/api-types DEFAULT_BEHAVIORAL_PROFILE.
const DefaultBehavioralProfile = PersonaRegular

// WebhookEventType — closed enum of supported webhook events.
type WebhookEventType string

const (
	EventSessionCompleted WebhookEventType = "session.completed"
	EventSessionFailed    WebhookEventType = "session.failed"
	EventAPIKeyRevoked    WebhookEventType = "api_key.revoked"
	// Fired when a SOCKS5 session reports what its proxy can do;
	// subscribe to react to proxy-health changes without polling.
	EventSessionEgressCapabilityChanged WebhookEventType = "session.egress_capability_changed"
	// A synthetic test event sent only via
	// POST /v1/webhooks/:id/test. Customers cannot subscribe to it
	// (the create / update Zod schemas reject it); it's dispatched
	// regardless of subscription so customers can verify their
	// handler signature-checks correctly before relying on real events.
	EventTestPing WebhookEventType = "test.ping"
	// Crypto-order terminal transitions, fired when an order moves from
	// pending/confirming/partial to paid or failed. Subscribe to settle
	// crypto checkouts in your own accounting.
	EventCryptoOrderPaid   WebhookEventType = "crypto.order.paid"
	EventCryptoOrderFailed WebhookEventType = "crypto.order.failed"
	// Fired when a session meets a bot-check challenge
	// (DataDome/Arkose/PerimeterX/AWS-WAF/GeeTest/…). Subscribe to route
	// challenge alerts into your own on-call surface; the session pauses
	// itself and waits for you to resume it.
	EventSessionChallengeDetected WebhookEventType = "session.challenge_detected"
	// Saving the profile back failed as the session ended (terminal; the
	// session itself succeeded). Subscribe if you depend on profile state,
	// so you learn that the next restore will be stale.
	EventSessionProfileSaveFailed WebhookEventType = "session.profile_save_failed"
)

// The two event names below are restored so a program written against
// v0.1.6 still compiles, and will be removed in a later minor release.
// Neither event is sent any more and neither can be subscribed to — the
// create and update schemas reject them — and no event replaced them.
// Read quota headroom from Usage.CurrentPeriod instead.
const (
	// Deprecated: quota warnings are no longer delivered by webhook.
	// Read Quotas from Usage.CurrentPeriod instead.
	EventQuotaWarning80Pct WebhookEventType = "quota.warning_80pct"
	// Deprecated: quota-exceeded is no longer delivered by webhook.
	// Read Quotas from Usage.CurrentPeriod instead.
	EventQuotaExceeded WebhookEventType = "quota.exceeded"
)

// WebhookDeliveryStatus.
type WebhookDeliveryStatus string

const (
	DeliveryPending   WebhookDeliveryStatus = "pending"
	DeliveryInFlight  WebhookDeliveryStatus = "in_flight"
	DeliveryDelivered WebhookDeliveryStatus = "delivered"
	DeliveryFailed    WebhookDeliveryStatus = "failed"
	DeliveryDLQ       WebhookDeliveryStatus = "dlq"
)

// UsageRecordType.
type UsageRecordType string

const (
	UsageSessionMinute     UsageRecordType = "session_minute"
	UsageNavigate          UsageRecordType = "navigate"
	UsageInteract          UsageRecordType = "interact"
	UsageWait              UsageRecordType = "wait"
	UsageStateCapture      UsageRecordType = "state_capture"
	UsageScreenshotCapture UsageRecordType = "screenshot_capture"
)

// ──────────────────────────────────────────────────────────────────
// Account / API key
// ──────────────────────────────────────────────────────────────────

type Account struct {
	ID        string        `json:"id"`
	Email     string        `json:"email"`
	Name      *string       `json:"name"`
	Tier      AccountTier   `json:"tier"`
	Status    AccountStatus `json:"status"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

type APIKey struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	KeyPrefix  string        `json:"key_prefix"`
	Scopes     []APIKeyScope `json:"scopes"`
	LastUsedAt *time.Time    `json:"last_used_at"`
	RevokedAt  *time.Time    `json:"revoked_at"`
	ExpiresAt  *time.Time    `json:"expires_at"`
	CreatedAt  time.Time     `json:"created_at"`
}

type APIKeyList struct {
	Data []APIKey `json:"data"`
}

type CreateAPIKeyRequest struct {
	Name      string        `json:"name"`
	Scopes    []APIKeyScope `json:"scopes"`
	ExpiresAt *time.Time    `json:"expires_at,omitempty"`
}

type CreateAPIKeyResponse struct {
	APIKey
	Plaintext string `json:"plaintext"`
}

// RotateAPIKeyRequest is the body for POST /v1/api-keys/:id/rotate.
type RotateAPIKeyRequest struct {
	// Optional new name for the rotated key. Empty string defaults to the
	// old key's name.
	Name string `json:"name,omitempty"`
}

// RotateAPIKeyResponse extends CreateAPIKeyResponse with the
// previous-key reference and the timestamp at which the previous key
// auto-revokes via the existing expires_at-driven auth gate.
type RotateAPIKeyResponse struct {
	CreateAPIKeyResponse
	RotatedFrom       string    `json:"rotated_from"`
	GracePeriodEndsAt time.Time `json:"grace_period_ends_at"`
}

// ──────────────────────────────────────────────────────────────────
// Team RBAC v1.
// ──────────────────────────────────────────────────────────────────

type TeamRole string

const (
	TeamRoleMember TeamRole = "member"
	TeamRoleAdmin  TeamRole = "admin"
)

type TeamMember struct {
	ID                 string    `json:"id"`
	OwnerAccountID     string    `json:"owner_account_id"`
	MemberAccountID    string    `json:"member_account_id"`
	MemberEmail        string    `json:"member_email"`
	Role               TeamRole  `json:"role"`
	InvitedAt          time.Time `json:"invited_at"`
	AcceptedAt         time.Time `json:"accepted_at"`
	InvitedByAccountID *string   `json:"invited_by_account_id"`
}

type TeamInvite struct {
	ID                 string     `json:"id"`
	OwnerAccountID     string     `json:"owner_account_id"`
	InviteeEmail       string     `json:"invitee_email"`
	Role               TeamRole   `json:"role"`
	ExpiresAt          time.Time  `json:"expires_at"`
	InvitedByAccountID *string    `json:"invited_by_account_id"`
	AcceptedAt         *time.Time `json:"accepted_at"`
	CreatedAt          time.Time  `json:"created_at"`
}

type TeamOwner struct {
	OwnerAccountID string   `json:"owner_account_id"`
	OwnerEmail     string   `json:"owner_email"`
	OwnerName      *string  `json:"owner_name"`
	Role           TeamRole `json:"role"`
	MembershipID   string   `json:"membership_id"`
}

type TeamMembersList struct {
	Data []TeamMember `json:"data"`
}

type TeamInvitesList struct {
	Data []TeamInvite `json:"data"`
}

type TeamOwnersList struct {
	Data []TeamOwner `json:"data"`
}

// TeamRecord is a team as a record — what GET /v1/teams returns.
//
// Distinct from TeamOwner, which describes a team you BELONG to (it carries
// your Role and MembershipID). This one is the team itself.
//
// Slug is always nil today: the field exists on the record but no endpoint sets
// one, because whether team slugs become public URL components is an open
// decision. Safe to read; it stays nil until that is settled.
type TeamRecord struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Slug           *string `json:"slug"`
	OwnerAccountID string  `json:"owner_account_id"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// TeamRecordsList is the GET /v1/teams envelope.
type TeamRecordsList struct {
	Data []TeamRecord `json:"data"`
}

// RenameTeamRequest is the PATCH /v1/teams/{id} body.
type RenameTeamRequest struct {
	Name string `json:"name"`
}

// RenameTeamResponse is the PATCH /v1/teams/{id} envelope.
type RenameTeamResponse struct {
	Team TeamRecord `json:"team"`
}

type TeamInviteRequest struct {
	Email string   `json:"email"`
	Role  TeamRole `json:"role,omitempty"`
}

type TeamAcceptRequest struct {
	Token string `json:"token"`
}

type TeamAcceptResponse struct {
	Membership TeamMember `json:"membership"`
}

type TeamInviteResponse struct {
	Message string `json:"message"`
}

// ──────────────────────────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────────────────────────

type Session struct {
	ID                 string              `json:"id"`
	AccountID          string              `json:"account_id"`
	APIKeyID           string              `json:"api_key_id"`
	Status             SessionStatus       `json:"status"`
	Archetype          string              `json:"archetype"`
	Purpose            SessionPurpose      `json:"purpose"`
	Label              *string             `json:"label"`
	Metadata           map[string]any      `json:"metadata"`
	EgressCapabilities *EgressCapabilities `json:"egress_capabilities"`
	// The raw egress report exactly as the session sent it, kept
	// beside the derived EgressCapabilities view so a newer
	// report shape is never lost. Opaque map; prefer
	// EgressCapabilities for typed access. Null until the
	// session reports.
	EgressCapabilityReport map[string]any `json:"egress_capability_report"`
	CreatedAt              time.Time      `json:"created_at"`
	UpdatedAt              time.Time      `json:"updated_at"`
	LastStateAt            *time.Time     `json:"last_state_at"`
	DestroyedAt            *time.Time     `json:"destroyed_at"`
}

// EgressCapabilities is what a session reports about its SOCKS5 proxy:
// which capabilities that proxy actually offers. Null until the session
// reports `egress.capability_report`; non-SOCKS5 sessions stay null
// permanently.
type EgressCapabilities struct {
	UDPAssociate     bool   `json:"udp_associate"`
	QUICRoute        string `json:"quic_route"` // "proxy" | "direct" | "disabled"
	DNSRemoteResolve bool   `json:"dns_remote_resolve"`
	// Safeguards is "passed", "failed", or "unverified" — whether every
	// defence-in-depth egress safeguard held for this session. nil means the
	// row predates this field (the key was absent on the wire); never treat a
	// nil Safeguards as "unverified" or "passed".
	Safeguards *string  `json:"safeguards,omitempty"`
	Warnings   []string `json:"warnings"`
}

// CreateSessionRequest. All fields are optional; leave empty to let the
// server default (Archetype → your tier's default device: the locked
// archetype on tiers entitled to every device, the newest iPhone 13 on the
// free tier; Purpose → DefaultSessionPurpose, BehavioralProfile →
// DefaultBehavioralProfile).
type CreateSessionRequest struct {
	Archetype string         `json:"archetype,omitempty"`
	Purpose   SessionPurpose `json:"purpose,omitempty"`
	Label     string         `json:"label,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	// ProfileID binds the session to a persistent antidetect profile
	// (cookies/localStorage/archetype inherited). Optional.
	ProfileID string `json:"profile_id,omitempty"`
	// BehavioralProfile selects the per-session persona (2026-06-05).
	BehavioralProfile BehavioralProfile `json:"behavioral_profile,omitempty"`
}

// CreateSessionResponse mirrors the server's POST /v1/sessions
// response: it's a Session row.
type CreateSessionResponse = Session

type SessionsListPage struct {
	Data       []Session `json:"data"`
	HasMore    bool      `json:"has_more"`
	NextCursor *string   `json:"next_cursor"`
}

type ListSessionsQuery struct {
	Limit  int    `url:"limit,omitempty"`
	Cursor string `url:"cursor,omitempty"`
}

type NavigateRequest struct {
	URL       string `json:"url"`
	WaitUntil string `json:"wait_until,omitempty"` // load | domcontentloaded | networkidle
	// Per-call timeout in ms. Server clamps to 1000–120000. Zero/omit
	// = server default (currently 30s).
	TimeoutMS int `json:"timeout_ms,omitempty"`
}

type NavigateResponse struct {
	URL        string `json:"url"`
	Status     int    `json:"status"`
	FinalURL   string `json:"final_url"`
	DurationMS int    `json:"duration_ms"`
}

// InteractAction is a discriminated-union of action kinds. Use the
// constructors (NewTapAction, NewTypeAction, ...) to build one.
//
// This is the customer-facing intent-only surface. Coordinate
// primitives (tap_at / type_focused / tap.offset) live on the
// gui-control surface and are NOT part of this SDK — they're internal
// to the self-hosted GUI workflow and gated behind the `gui_control`
// API-key scope.
type InteractAction struct {
	Kind     string `json:"kind"`               // tap | type | scroll | press
	Selector string `json:"selector,omitempty"` // tap, type, scroll
	Text     string `json:"text,omitempty"`     // type
	DelayMs  *int   `json:"delay_ms,omitempty"` // type
	// Sensitive marks the typed value (card number / OTP / PIN) so the
	// session does not act out visible typo-corrections while typing it.
	Sensitive *bool  `json:"sensitive,omitempty"` // type
	DeltaX    int    `json:"delta_x,omitempty"`   // scroll
	DeltaY    int    `json:"delta_y,omitempty"`   // scroll
	Key       string `json:"key,omitempty"`       // press
}

func NewTapAction(selector string) InteractAction {
	return InteractAction{Kind: "tap", Selector: selector}
}

func NewTypeAction(selector, text string) InteractAction {
	return InteractAction{Kind: "type", Selector: selector, Text: text}
}

// NewScrollAction scrolls the viewport (or selected element) by the
// given pixel deltas. Positive Y scrolls down.
func NewScrollAction(deltaX, deltaY int) InteractAction {
	return InteractAction{Kind: "scroll", DeltaX: deltaX, DeltaY: deltaY}
}

func NewPressAction(key string) InteractAction {
	return InteractAction{Kind: "press", Key: key}
}

type InteractRequest struct {
	Action    InteractAction `json:"action"`
	TimeoutMS int            `json:"timeout_ms,omitempty"`
}

type InteractResponse struct {
	OK         bool `json:"ok"`
	DurationMS int  `json:"duration_ms"`
}

// WaitCondition is a discriminated-union of wait conditions. Use the
// constructors (NewSelectorCondition, ...) to build one.
type WaitCondition struct {
	Kind     string `json:"kind"` // selector | selector_hidden | url_matches | time
	Selector string `json:"selector,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
	MS       int    `json:"ms,omitempty"`
}

func NewSelectorCondition(selector string) WaitCondition {
	return WaitCondition{Kind: "selector", Selector: selector}
}

func NewSelectorHiddenCondition(selector string) WaitCondition {
	return WaitCondition{Kind: "selector_hidden", Selector: selector}
}

func NewURLMatchesCondition(pattern string) WaitCondition {
	return WaitCondition{Kind: "url_matches", Pattern: pattern}
}

func NewTimeCondition(ms int) WaitCondition {
	return WaitCondition{Kind: "time", MS: ms}
}

type WaitRequest struct {
	Condition WaitCondition `json:"condition"`
	TimeoutMS int           `json:"timeout_ms,omitempty"`
}

type WaitResponse struct {
	Satisfied  bool `json:"satisfied"`
	DurationMS int  `json:"duration_ms"`
}

// PageStateError describes a failed navigation as the browser saw it.
type PageStateError struct {
	Kind       string `json:"kind"` // http | tls | dns | net | timeout
	HTTPStatus *int   `json:"http_status,omitempty"`
	Message    string `json:"message"`
}

// PageState is the page lifecycle: loading | loaded | errored,
// with Error present only when errored. Nil on SessionState until the
// session reports a lifecycle event.
type PageState struct {
	State string          `json:"state"` // loading | loaded | errored
	Error *PageStateError `json:"error,omitempty"`
}

type SessionState struct {
	URL          *string           `json:"url"`
	Title        *string           `json:"title"`
	Cookies      []map[string]any  `json:"cookies"`
	LocalStorage map[string]string `json:"local_storage"`
	PageState    *PageState        `json:"page_state"`
	CapturedAt   time.Time         `json:"captured_at"`
}

// CaptureKind enumerates the supported capture outputs.
type CaptureKind string

const (
	CaptureScreenshot  CaptureKind = "screenshot"
	CaptureDOMSnapshot CaptureKind = "dom_snapshot"
	CapturePDF         CaptureKind = "pdf"
)

type CaptureRequest struct {
	Kind     CaptureKind `json:"kind"`
	FullPage bool        `json:"full_page,omitempty"`
}

type CaptureResponse struct {
	Kind       CaptureKind `json:"kind"`
	Data       string      `json:"data"`     // base64 or utf8 depending on Encoding
	Encoding   string      `json:"encoding"` // base64 | utf8
	ByteSize   int         `json:"byte_size"`
	DurationMS int         `json:"duration_ms"`
}

// ListFieldExtraction — per-field sub-extraction for a type:"list" extraction
// (runs against each matched element). Type is text|attribute only (no nested lists).
type ListFieldExtraction struct {
	Type      string `json:"type"`                // text | attribute
	Attribute string `json:"attribute,omitempty"` // required when Type=="attribute"
	Selector  string `json:"selector,omitempty"`  // optional sub-selector relative to the element
}

// Extraction — one named extraction in an ExtractRequest.
type Extraction struct {
	Name      string                         `json:"name"`
	Selector  string                         `json:"selector"`
	Type      string                         `json:"type"`                // text | attribute | list
	Attribute string                         `json:"attribute,omitempty"` // required when Type=="attribute"
	Transform string                         `json:"transform,omitempty"` // "number" parses the text as numeric
	Extract   map[string]ListFieldExtraction `json:"extract,omitempty"`   // per-field sub-extraction for Type=="list"
}

type ExtractRequest struct {
	Extractions []Extraction `json:"extractions"` // 1..100
}

type ExtractResponse struct {
	// Extracted values keyed by each extraction's Name (heterogeneous:
	// string | number | array per the extraction type — the page data).
	Value map[string]any `json:"value"`
}

type SearchRequest struct {
	Query          string `json:"query"`
	SearchSelector string `json:"search_selector,omitempty"`
	// Submit (Return) after typing. Defaults to true server-side; *bool so a
	// caller can send an explicit false (a plain bool's zero value can't).
	Submit                 *bool  `json:"submit,omitempty"`
	WaitForResultsSelector string `json:"wait_for_results_selector,omitempty"`
	// Caps the wait_for_results_selector wait (seconds; 1..120). Omit → server default (10s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

type SearchResponse struct {
	Submitted      bool `json:"submitted"`
	QueryTruncated bool `json:"query_truncated"`
	// Present only when WaitForResultsSelector was given (timeout → false).
	ResultsVisible *bool `json:"results_visible,omitempty"`
	DurationMS     int   `json:"duration_ms"`
}

// UnmarshalJSON enforces the strict complete-vs-safe-refusal search result.
// A truncated query is never submitted and cannot carry a results assessment.
func (r *SearchResponse) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	allowed := map[string]bool{
		"submitted": true, "query_truncated": true,
		"results_visible": true, "duration_ms": true,
	}
	for name := range fields {
		if !allowed[name] {
			return fmt.Errorf("invalid session search response field %q", name)
		}
	}
	if raw, present := fields["results_visible"]; present && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("invalid session search response: results_visible cannot be null")
	}

	var wire struct {
		Submitted      *bool `json:"submitted"`
		QueryTruncated *bool `json:"query_truncated"`
		ResultsVisible *bool `json:"results_visible"`
		DurationMS     *int  `json:"duration_ms"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Submitted == nil || wire.QueryTruncated == nil || wire.DurationMS == nil {
		return fmt.Errorf("invalid session search response: missing required outcome field")
	}
	if *wire.DurationMS < 0 || *wire.DurationMS > 600_000 {
		return fmt.Errorf("invalid session search response: duration_ms outside 0..600000")
	}
	if *wire.QueryTruncated && (*wire.Submitted || wire.ResultsVisible != nil) {
		return fmt.Errorf("invalid session search response: contradictory truncated outcome")
	}

	r.Submitted = *wire.Submitted
	r.QueryTruncated = *wire.QueryTruncated
	r.ResultsVisible = wire.ResultsVisible
	r.DurationMS = *wire.DurationMS
	return nil
}

// SessionLoginRequest drives the in-browser credential-login op. Named
// SessionLogin* (not Login*) to avoid colliding with the account-login types.
type SessionLoginRequest struct {
	Username string `json:"username"`
	// Password is SENSITIVE — typed via the behavioural send-keys path; never logged.
	Password         string `json:"password"`
	UsernameSelector string `json:"username_selector,omitempty"`
	PasswordSelector string `json:"password_selector,omitempty"`
	SubmitSelector   string `json:"submit_selector,omitempty"`
	SuccessSelector  string `json:"success_selector,omitempty"`
	// Caps the post-submit success wait (seconds; 1..120). Omit → server default (10s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

type SessionLoginResponse struct {
	Submitted            bool   `json:"submitted"`
	CredentialsTruncated bool   `json:"credentials_truncated"`
	LoggedIn             bool   `json:"logged_in"`
	PostLoginURL         string `json:"post_login_url,omitempty"`
	DurationMS           int    `json:"duration_ms"`
}

// UnmarshalJSON enforces the public two-branch login result. A truncated
// credential is a safe zero-submit refusal and therefore cannot carry a URL;
// a complete credential flow must report submitted=true. This keeps the Go SDK
// from silently accepting a contradictory server response.
func (r *SessionLoginResponse) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	allowed := map[string]bool{
		"submitted": true, "credentials_truncated": true, "logged_in": true,
		"post_login_url": true, "duration_ms": true,
	}
	for name := range fields {
		if !allowed[name] {
			return fmt.Errorf("invalid session login response field %q", name)
		}
	}
	if raw, present := fields["post_login_url"]; present && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("invalid session login response: post_login_url cannot be null")
	}

	var wire struct {
		Submitted            *bool   `json:"submitted"`
		CredentialsTruncated *bool   `json:"credentials_truncated"`
		LoggedIn             *bool   `json:"logged_in"`
		PostLoginURL         *string `json:"post_login_url"`
		DurationMS           *int    `json:"duration_ms"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Submitted == nil || wire.CredentialsTruncated == nil || wire.LoggedIn == nil || wire.DurationMS == nil {
		return fmt.Errorf("invalid session login response: missing required outcome field")
	}
	if *wire.DurationMS < 0 || *wire.DurationMS > 600_000 {
		return fmt.Errorf("invalid session login response: duration_ms outside 0..600000")
	}
	if *wire.CredentialsTruncated {
		if *wire.Submitted || *wire.LoggedIn || wire.PostLoginURL != nil {
			return fmt.Errorf("invalid session login response: contradictory truncated outcome")
		}
	} else if !*wire.Submitted {
		return fmt.Errorf("invalid session login response: complete credentials were not submitted")
	}

	r.Submitted = *wire.Submitted
	r.CredentialsTruncated = *wire.CredentialsTruncated
	r.LoggedIn = *wire.LoggedIn
	r.DurationMS = *wire.DurationMS
	r.PostLoginURL = ""
	if wire.PostLoginURL != nil {
		r.PostLoginURL = *wire.PostLoginURL
	}
	return nil
}

// ──────────────────────────────────────────────────────────────────
// Usage
// ──────────────────────────────────────────────────────────────────

type UsageTotals map[UsageRecordType]int

// UsageQuotas — null entries mean unmetered (enterprise tier).
type UsageQuotas map[UsageRecordType]*int

type UsagePeriodSummary struct {
	PeriodStart time.Time   `json:"period_start"`
	PeriodEnd   time.Time   `json:"period_end"`
	Tier        AccountTier `json:"tier"`
	Totals      UsageTotals `json:"totals"`
	Quotas      UsageQuotas `json:"quotas"`
}

// ──────────────────────────────────────────────────────────────────
// Webhooks
// ──────────────────────────────────────────────────────────────────

// WebhookEndpointDeliveryCounts — aggregate per-endpoint delivery
// counts surfaced on every WebhookEndpoint response.
type WebhookEndpointDeliveryCounts struct {
	Delivered int `json:"delivered"`
	Failed    int `json:"failed"`
	DLQ       int `json:"dlq"`
}

type WebhookEndpoint struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	SecretPrefix string `json:"secret_prefix"`
	// Secret rotation grace state. Both null when no rotation in flight.
	PrevSecretPrefix       *string                       `json:"prev_secret_prefix"`
	RotationGraceExpiresAt *time.Time                    `json:"rotation_grace_expires_at"`
	Events                 []WebhookEventType            `json:"events"`
	Description            *string                       `json:"description"`
	Active                 bool                          `json:"active"`
	ConsecutiveFailures    int                           `json:"consecutive_failures"`
	LastSuccessAt          *time.Time                    `json:"last_success_at"`
	LastFailureAt          *time.Time                    `json:"last_failure_at"`
	DisabledAt             *time.Time                    `json:"disabled_at"`
	DeliveryCounts         WebhookEndpointDeliveryCounts `json:"delivery_counts"`
	CreatedAt              time.Time                     `json:"created_at"`
}

type WebhookEndpointList struct {
	Data []WebhookEndpoint `json:"data"`
}

// CreateWebhookRequest — Description is a pointer so nil omits the field
// entirely while a pointer to "" transmits an explicit empty description
// (a plain string with omitempty could never send an empty value).
// Matches UpdateWebhookRequest and the nullable contract.
type CreateWebhookRequest struct {
	URL         string             `json:"url"`
	Events      []WebhookEventType `json:"events"`
	Description *string            `json:"description,omitempty"`
}

type CreateWebhookResponse struct {
	WebhookEndpoint
	Secret string `json:"secret"`
}

// UpdateWebhookRequest — partial update. Pointer fields so
// callers can distinguish "leave as-is" (nil) from "set explicitly"
// (non-nil). At least one field must be non-nil; the server returns
// 400 otherwise.
type UpdateWebhookRequest struct {
	URL         *string             `json:"url,omitempty"`
	Events      *[]WebhookEventType `json:"events,omitempty"`
	Description *string             `json:"description,omitempty"`
	Active      *bool               `json:"active,omitempty"`
}

type WebhookDelivery struct {
	ID                  string                `json:"id"`
	WebhookID           string                `json:"webhook_id"`
	EventID             string                `json:"event_id"`
	EventType           WebhookEventType      `json:"event_type"`
	Status              WebhookDeliveryStatus `json:"status"`
	Attempts            int                   `json:"attempts"`
	NextAttemptAt       time.Time             `json:"next_attempt_at"`
	LastResponseStatus  *int                  `json:"last_response_status"`
	LastResponseExcerpt *string               `json:"last_response_excerpt"`
	LastError           *string               `json:"last_error"`
	DeliveredAt         *time.Time            `json:"delivered_at"`
	CreatedAt           time.Time             `json:"created_at"`
}

type WebhookDeliveryListPage struct {
	Data       []WebhookDelivery `json:"data"`
	HasMore    bool              `json:"has_more"`
	NextCursor *string           `json:"next_cursor"`
}

type ListDeliveriesQuery struct {
	Limit  int                   `url:"limit,omitempty"`
	Cursor string                `url:"cursor,omitempty"`
	Status WebhookDeliveryStatus `url:"status,omitempty"`
}

// ──────────────────────────────────────────────────────────────────
// Webhook event payload (what the server POSTs to your endpoint)
// ──────────────────────────────────────────────────────────────────

// Event is the envelope every webhook delivery wraps. Customers
// typically un-marshal the body into this and switch on Type.
type Event struct {
	ID        string           `json:"id"`
	Type      WebhookEventType `json:"type"`
	CreatedAt time.Time        `json:"created_at"`
	Data      json.RawMessage  `json:"data"`
}

// SessionCompletedData is the Data shape for type=session.completed.
type SessionCompletedData struct {
	SessionID  string `json:"session_id"`
	DurationMS int    `json:"duration_ms"`
	OpsCount   int    `json:"ops_count"`
}

// APIKeyRevokedData is the Data shape for type=api_key.revoked.
type APIKeyRevokedData struct {
	APIKeyID  string    `json:"api_key_id"`
	Name      string    `json:"name"`
	RevokedAt time.Time `json:"revoked_at"`
}

// ──────────────────────────────────────────────────────────────────
// Profiles
// ──────────────────────────────────────────────────────────────────

// Profile matches the public ProfileSchema returned by
// /v1/profiles. The browser state a profile carries (persona /
// storage_state / notes) is held for you and is not readable through
// the API; this struct is the metadata you can read and set.
// `Description` is `*string` to capture explicit-null vs. unset.
type Profile struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Archetype   string   `json:"archetype"`
	Description *string  `json:"description"`
	Folder      *string  `json:"folder"`
	Tags        []string `json:"tags"`
	// Icon + Note — per-account UI metadata (2026-06-16). Icon = short emoji
	// (nil/empty = monogram); Note = short inline annotation.
	Icon       *string    `json:"icon"`
	Note       *string    `json:"note"`
	LastUsedAt *time.Time `json:"last_used_at"`
	// SizeBytes + LastSavedAt. SizeBytes is the byte size of
	// the last saved sealed store (the opaque encrypted browser-state blob);
	// nil until the profile is first saved. *int64: a sealed store can exceed
	// the 2^31 int ceiling. LastSavedAt is when it was last saved back.
	SizeBytes   *int64     `json:"size_bytes"`
	LastSavedAt *time.Time `json:"last_saved_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	// DeletedAt — L4b recycle bin. nil for a live profile; set to the trash
	// timestamp for a soft-deleted one (only ListTrash returns trashed rows).
	DeletedAt *time.Time `json:"deleted_at"`
}

// CreateProfileRequest matches the server's create-profile request.
// Archetype defaults to the live catalog's default_archetype_id when omitted;
// call GET /v1/archetypes instead of hard-coding a device generation.
type CreateProfileRequest struct {
	Name        string   `json:"name"`
	Archetype   string   `json:"archetype,omitempty"`
	Description string   `json:"description,omitempty"`
	Folder      string   `json:"folder,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Icon        string   `json:"icon,omitempty"` // short emoji (≤16) — per-account UI metadata
	Note        string   `json:"note,omitempty"` // short inline note (≤280)
}

// UpdateProfileRequest matches the server's update-profile request.
// is `{ name?, description?, folder?, tags? }`. All optional. Tags is
// an exact-set replace. Note: `omitempty` means a nil Folder is
// omitted (field untouched) — same explicit-null limitation as
// Description; clear via Tags: []string{} marshals away too, so
// null-clears need a raw request (documented SDK-wide limitation).
type UpdateProfileRequest struct {
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Folder      *string  `json:"folder,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Icon        *string  `json:"icon,omitempty"` // short emoji (≤16) — per-account UI metadata
	Note        *string  `json:"note,omitempty"` // short inline note (≤280)
}

type ProfilesListPage struct {
	Data       []Profile `json:"data"`
	HasMore    bool      `json:"has_more"`
	NextCursor *string   `json:"next_cursor"`
}

// ProfilesTrashList — L4b recycle bin. The trashed-profiles list is small +
// ephemeral, so it's an unpaginated { data } envelope (no cursor).
type ProfilesTrashList struct {
	Data []Profile `json:"data"`
}

type ListProfilesQuery struct {
	Limit  int
	Cursor string
}

// ──────────────────────────────────────────────────────────────────
// Billing
// ──────────────────────────────────────────────────────────────────

type SubscriptionStatus string

const (
	SubStatusActive            SubscriptionStatus = "active"
	SubStatusTrialing          SubscriptionStatus = "trialing"
	SubStatusPastDue           SubscriptionStatus = "past_due"
	SubStatusCanceled          SubscriptionStatus = "canceled"
	SubStatusUnpaid            SubscriptionStatus = "unpaid"
	SubStatusIncomplete        SubscriptionStatus = "incomplete"
	SubStatusIncompleteExpired SubscriptionStatus = "incomplete_expired"
	SubStatusPaused            SubscriptionStatus = "paused"
)

// Subscription — the account's billing subscription. Matches the server's `publicSubscription`
// output shape. `stripe_subscription_id` is always present (Stripe's
// id assigned at checkout-completion); `current_period_end` and
// `canceled_at` are nullable depending on subscription state.
type Subscription struct {
	Tier                 AccountTier        `json:"tier"`
	Status               SubscriptionStatus `json:"status"`
	StripeSubscriptionID string             `json:"stripe_subscription_id"`
	CurrentPeriodEnd     *time.Time         `json:"current_period_end"`
	CancelAtPeriodEnd    bool               `json:"cancel_at_period_end"`
	CanceledAt           *time.Time         `json:"canceled_at"`
	CreatedAt            time.Time          `json:"created_at"`
	UpdatedAt            time.Time          `json:"updated_at"`
}

// GetBillingStateResponse — `Subscription` is nullable
// (account never subscribed). The trial_pack envelope was removed
// 2026-05-27 with the trial_pack retirement.
type GetBillingStateResponse struct {
	Subscription *Subscription `json:"subscription"`
}

type CreateCheckoutSessionRequest struct {
	Tier       AccountTier `json:"tier"`
	SuccessURL string      `json:"success_url"`
	CancelURL  string      `json:"cancel_url"`
}

type CreateCheckoutSessionResponse struct {
	CheckoutURL string `json:"checkout_url"`
	SessionID   string `json:"session_id"`
}

type CreatePortalSessionResponse struct {
	PortalURL string `json:"portal_url"`
}

// ──────────────────────────────────────────────────────────────────
// Auth flows — unauthenticated endpoints
// ──────────────────────────────────────────────────────────────────

type SignupRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name,omitempty"`
}

// SignupResponse matches the server's response to a signup: when the
// verification email expires, and nothing else you need to act on.
// `DebugToken` is populated only when the
// server runs with `EMAIL_DELIVERY_MODE=stub`; production responses
// omit it.
type SignupResponse struct {
	VerificationEmailExpiresAt time.Time `json:"verification_email_expires_at"`
	DebugToken                 string    `json:"debug_token,omitempty"`
}

type VerifyEmailRequest struct {
	Token string `json:"token"`
}

// WebSession matches the server's `WebSessionSchema`
// returned nested under `session` on every web-auth flow response
// (verify-email, login non-MFA branch, magic-link consume, password-
// reset confirm, refresh).
type WebSession struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	AccountID string    `json:"account_id"`
}

type VerifyEmailResponse struct {
	Session WebSession `json:"session"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// LoginResponse is the result of a password login. The server returns one of two
// shapes:
//
//   - Non-MFA: `{ "session": { ... } }` — `Session` is populated;
//     `MfaRequired` is false / zero.
//   - MFA-required: `{ "mfa_required": true, "challenge_token": "...",
//     "challenge_expires_at": "..." }` — `MfaRequired` is true;
//     `Session.Token` is empty.
//
// Customer code branches on `MfaRequired`:
//
//	resp, err := client.Auth.Login(ctx, &LoginRequest{...})
//	if resp.MfaRequired {
//	    // exchange resp.ChallengeToken via the /v1/auth/mfa/challenge endpoint
//	} else {
//	    // resp.Session is the real session
//	}
type LoginResponse struct {
	// Populated on the non-MFA branch.
	Session WebSession `json:"session,omitempty"`
	// Populated on the MFA-required branch.
	MfaRequired        bool   `json:"mfa_required,omitempty"`
	ChallengeToken     string `json:"challenge_token,omitempty"`
	ChallengeExpiresAt string `json:"challenge_expires_at,omitempty"`
}

type MagicLinkRequest struct {
	Email string `json:"email"`
}

// MagicLinkRequestResponse — always `Sent: true` to the client even
// when the email doesn't exist, so the shape doesn't leak account-
// existence. ExpiresAt is when the magic-link token expires; DebugToken
// is populated only when the server runs with `EMAIL_DELIVERY_MODE=stub`
// (production responses omit it), matching SignupResponse.
type MagicLinkRequestResponse struct {
	Sent       bool      `json:"sent"`
	ExpiresAt  time.Time `json:"expires_at"`
	DebugToken string    `json:"debug_token,omitempty"`
}

type MagicLinkConsumeRequest struct {
	Token string `json:"token"`
}

type MagicLinkConsumeResponse struct {
	Session            WebSession `json:"session,omitempty"`
	MfaRequired        bool       `json:"mfa_required,omitempty"`
	ChallengeToken     string     `json:"challenge_token,omitempty"`
	ChallengeExpiresAt string     `json:"challenge_expires_at,omitempty"`
}

type PasswordResetRequest struct {
	Email string `json:"email"`
}

// PasswordResetRequestResponse — always `Sent: true` to the client even
// when the email doesn't exist, so the shape doesn't leak account-
// existence. ExpiresAt is when the reset token expires; DebugToken is
// populated only when the server runs with `EMAIL_DELIVERY_MODE=stub`
// (production responses omit it), matching SignupResponse.
type PasswordResetRequestResponse struct {
	Sent       bool      `json:"sent"`
	ExpiresAt  time.Time `json:"expires_at"`
	DebugToken string    `json:"debug_token,omitempty"`
}

type PasswordResetConfirmRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

type PasswordResetConfirmResponse struct {
	Session            WebSession `json:"session,omitempty"`
	MfaRequired        bool       `json:"mfa_required,omitempty"`
	ChallengeToken     string     `json:"challenge_token,omitempty"`
	ChallengeExpiresAt string     `json:"challenge_expires_at,omitempty"`
}

// RefreshSessionRequest — the server expects `{ "token": "..." }`,
// not `{ "session_token": "..." }`.
type RefreshSessionRequest struct {
	Token string `json:"token"`
}

type RefreshSessionResponse struct {
	Session WebSession `json:"session"`
}

// LogoutRequest — the server expects `{ "token": "..." }`, not
// `{ "session_token": "..." }`.
type LogoutRequest struct {
	Token string `json:"token"`
}

type LogoutResponse struct {
	OK bool `json:"ok"`
}

// MFA challenge + step-up shapes.

// MfaChallengeRequest — exchange the login challenge_token
// for a session via TOTP code or recovery code. Supply exactly one
// of `Code` (6-digit TOTP) OR `RecoveryCode` (single-use recovery
// code).
type MfaChallengeRequest struct {
	ChallengeToken string `json:"challenge_token"`
	Code           string `json:"code,omitempty"`
	RecoveryCode   string `json:"recovery_code,omitempty"`
}

// MfaChallengeResponse — issued session + which factor was used.
type MfaChallengeResponse struct {
	Session WebSession `json:"session"`
	Via     string     `json:"via"` // "totp" | "recovery"
}

// MfaStepUpRequest — refresh `mfa_satisfied_at` on the calling web
// session (step-up gate; 15-minute freshness window). Same
// one-of code-vs-recovery_code constraint as challenge.
type MfaStepUpRequest struct {
	Code         string `json:"code,omitempty"`
	RecoveryCode string `json:"recovery_code,omitempty"`
}

// MfaStepUpResponse — no new session issued; the existing session
// row's mfa_satisfied_at advances to the returned timestamp.
type MfaStepUpResponse struct {
	Via            string    `json:"via"` // "totp" | "recovery"
	MfaSatisfiedAt time.Time `json:"mfa_satisfied_at"`
}

// CLI/GUI activation flow (browser-OAuth-style).

// CliAuthorizeInitiateRequest — the CLI/GUI starts the flow with a
// CSRF nonce + optional human-friendly client label that appears on
// the dashboard's confirmation screen.
type CliAuthorizeInitiateRequest struct {
	State       string `json:"state"`
	ClientLabel string `json:"client_label,omitempty"`
}

// CliAuthorizeInitiateResponse — one-shot device code, a separate
// user verification code, and the browser URL the CLI/GUI opens.
type CliAuthorizeInitiateResponse struct {
	Code       string    `json:"code"`
	UserCode   string    `json:"user_code"`
	BrowserURL string    `json:"browser_url"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// CliAuthorizeBindRequest — web-session-authenticated. Scopes default
// to ["account_owner"] server-side when omitted.
type CliAuthorizeBindRequest struct {
	Code     string   `json:"code"`
	State    string   `json:"state"`
	UserCode string   `json:"user_code"`
	Scopes   []string `json:"scopes,omitempty"`
}

// CliAuthorizeBindResponse — the dashboard's confirmation UI gets
// AccountID echoed back. The plaintext API key NEVER returns through
// this endpoint — only the CLI/GUI receives it via /exchange.
type CliAuthorizeBindResponse struct {
	OK        bool      `json:"ok"`
	AccountID string    `json:"account_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CliAuthorizeExchangeRequest — polled by the CLI/GUI after opening
// the browser_url returned by /initiate.
type CliAuthorizeExchangeRequest struct {
	Code  string `json:"code"`
	State string `json:"state"`
}

// CliAuthorizeExchangeResponse — discriminated on Status:
//   - "pending" — keep polling.
//   - "bound"   — one-shot delivery; APIKey + AccountID populated.
//     The server deletes the code on delivery, so a subsequent poll
//     returns Status "expired" with HTTP 200.
//   - "expired" — user took too long (or already collected the key);
//     restart the flow.
type CliAuthorizeExchangeResponse struct {
	Status    string `json:"status"`
	APIKey    string `json:"api_key,omitempty"`
	AccountID string `json:"account_id,omitempty"`
}
