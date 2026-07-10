package driftstack

import (
	"encoding/json"
	"time"
)

// This file mirrors the Zod schemas in `packages/api-types/`. The
// schemas are the source of truth (Zod → OpenAPI 3.1 → these types).
// Re-generated when schemas change; tracked manually for now since
// oapi-codegen lacks OpenAPI 3.1 support (see V-026 for the
// codegen-vs-hand-written decision).
//
// Naming follows the Stripe-Go convention: PascalCase exported types,
// json tags using the underscore_case names the wire uses, omitempty
// on optional fields so customers can construct partial inputs.

// ──────────────────────────────────────────────────────────────────
// Common / shared
// ──────────────────────────────────────────────────────────────────

// AccountTier is the closed enum of pricing tiers (V-148 two-ladder
// restructure; locked per ADR-004; trial_pack retired 2026-05-27 → free).
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

// AccountStatus.
type AccountStatus string

const (
	AccountActive    AccountStatus = "active"
	AccountSuspended AccountStatus = "suspended"
	AccountDeleted   AccountStatus = "deleted"
)

// APIKeyScope. V-174 split the legacy single `admin` scope into
// `account_owner` (customer self-serve) and `driftstack_internal_admin`
// (staff cross-account). The legacy `admin` token remains accepted as
// a compat alias for both during migration.
type APIKeyScope string

const (
	ScopeRead                    APIKeyScope = "read"
	ScopeWrite                   APIKeyScope = "write"
	ScopeAdmin                   APIKeyScope = "admin" // compat alias (V-174)
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

// SessionPurpose drives WebKit driver harness selection (V-169).
type SessionPurpose string

// V-433 — these are the only values the server's
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

// BehavioralProfile selects the per-session human-behaviour persona the
// harness drives touch/scroll/typing with (file 05 "Persona model"). These
// are the only values the server's BehavioralProfileSchema accepts.
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
	EventSessionCompleted  WebhookEventType = "session.completed"
	EventSessionFailed     WebhookEventType = "session.failed"
	EventQuotaWarning80Pct WebhookEventType = "quota.warning_80pct"
	EventQuotaExceeded     WebhookEventType = "quota.exceeded"
	EventAPIKeyRevoked     WebhookEventType = "api_key.revoked"
	// Arc 5 EGRESS eg.7 — fired when a SOCKS5 session's egress
	// capability report is ingested; subscribable so customers can
	// branch on proxy-health changes without a GET.
	EventSessionEgressCapabilityChanged WebhookEventType = "session.egress_capability_changed"
	// V-356 — synthetic test event sent only via
	// POST /v1/webhooks/:id/test. Customers cannot subscribe to it
	// (the create / update Zod schemas reject it); it's dispatched
	// regardless of subscription so customers can verify their
	// handler signature-checks correctly before relying on real events.
	EventTestPing WebhookEventType = "test.ping"
	// V-666 — crypto-order terminal transitions, fired by the IPN
	// handler on pending/confirming/partial → paid|failed. Subscribable
	// so crypto-checkout integrators can react in their own accounting.
	EventCryptoOrderPaid   WebhookEventType = "crypto.order.paid"
	EventCryptoOrderFailed WebhookEventType = "crypto.order.failed"
	// W393 — challenge-handling. Fired when the harness ChallengeDetector flags
	// a bot-check (DataDome/Arkose/PerimeterX/AWS-WAF/GeeTest/…) and the control
	// plane relays it. Subscribable so customers wire challenge alerts into their
	// own ops surface; the harness auto-pauses + the customer resumes.
	EventSessionChallengeDetected WebhookEventType = "session.challenge_detected"
	// A3 W1364 — profile save-back failed at session teardown (terminal; the
	// session itself succeeded). Subscribable so customers persisting profile
	// state can alert on a stale next restore.
	EventSessionProfileSaveFailed WebhookEventType = "session.profile_save_failed"
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

// V-296 — RotateAPIKeyRequest is the body for POST /v1/api-keys/:id/rotate.
type RotateAPIKeyRequest struct {
	// Optional new name for the rotated key. Empty string defaults to the
	// old key's name.
	Name string `json:"name,omitempty"`
}

// V-296 — RotateAPIKeyResponse extends CreateAPIKeyResponse with the
// previous-key reference and the timestamp at which the previous key
// auto-revokes via the existing expires_at-driven auth gate.
type RotateAPIKeyResponse struct {
	CreateAPIKeyResponse
	RotatedFrom       string    `json:"rotated_from"`
	GracePeriodEndsAt time.Time `json:"grace_period_ends_at"`
}

// ──────────────────────────────────────────────────────────────────
// V-298c / V-309g — Team RBAC v1.
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

type TeamMembersList struct {
	Data []TeamMember `json:"data"`
}

type TeamInvitesList struct {
	Data []TeamInvite `json:"data"`
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
	// Arc 5 EGRESS eg.1.g — RAW harness-emitted event payload
	// (migration 0054). Stored alongside the derived
	// EgressCapabilities view for forensics + schema-evolution
	// safety. Opaque map; consumers should prefer
	// EgressCapabilities for typed access. Null until the
	// harness emits.
	EgressCapabilityReport map[string]any `json:"egress_capability_report"`
	CreatedAt              time.Time      `json:"created_at"`
	UpdatedAt              time.Time      `json:"updated_at"`
	LastStateAt            *time.Time     `json:"last_state_at"`
	DestroyedAt            *time.Time     `json:"destroyed_at"`
}

// EgressCapabilities is the harness-reported per-session SOCKS5
// capability shape (cross-agent contract 7d5992d9 + EG-WK-1.9
// dns_remote_resolve extension, migration 0045). Null until the
// harness emits `egress.capability_report`; non-SOCKS5 sessions stay
// null permanently.
type EgressCapabilities struct {
	UDPAssociate     bool     `json:"udp_associate"`
	QUICRoute        string   `json:"quic_route"` // "proxy" | "direct" | "disabled"
	DNSRemoteResolve bool     `json:"dns_remote_resolve"`
	Warnings         []string `json:"warnings"`
}

// CreateSessionRequest. All fields are optional; leave empty to let the
// server default (Archetype → locked archetype, Purpose →
// DefaultSessionPurpose, BehavioralProfile → DefaultBehavioralProfile).
type CreateSessionRequest struct {
	Archetype string         `json:"archetype,omitempty"`
	Purpose   SessionPurpose `json:"purpose,omitempty"`
	Label     string         `json:"label,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	// ProfileID binds the session to a persistent antidetect profile
	// (cookies/localStorage/archetype inherited). Optional (V-081/V-480).
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
// This is the customer-facing intent-only surface (L-001). Coordinate
// primitives (tap_at / type_focused / tap.offset) live on the
// gui-control plane and are NOT part of this SDK — they're internal
// to the self-hosted GUI workflow and gated behind the `gui_control`
// API-key scope.
type InteractAction struct {
	Kind     string `json:"kind"`               // tap | type | scroll | press
	Selector string `json:"selector,omitempty"` // tap, type, scroll
	Text     string `json:"text,omitempty"`     // type
	DelayMs  *int   `json:"delay_ms,omitempty"` // type
	// Sensitive marks the typed value (card number / OTP / PIN) so the
	// harness suppresses visible typo-corrections while typing it (W1150).
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

// PageState is the page lifecycle (W615): loading | loaded | errored,
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
	// Caps the wait_for_results_selector wait (seconds; 1..120). Omit → harness default (10s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

type SearchResponse struct {
	Submitted bool `json:"submitted"`
	// Present only when WaitForResultsSelector was given (timeout → false).
	ResultsVisible *bool `json:"results_visible,omitempty"`
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
	// Caps the post-submit success wait (seconds; 1..120). Omit → harness default (10s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

type SessionLoginResponse struct {
	LoggedIn     bool   `json:"logged_in"`
	PostLoginURL string `json:"post_login_url,omitempty"`
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

// WebhookEndpointDeliveryCounts — V-185 aggregate per-endpoint delivery
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
	// V-359 — rotation grace state. Both null when no rotation in flight.
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

// UpdateWebhookRequest — V-351 partial update. Pointer fields so
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
// Profiles (V-081)
// ──────────────────────────────────────────────────────────────────

// Profile — V-426. Matches the public ProfileSchema returned by
// /v1/profiles. Per-profile browser state (persona / storage_state /
// notes) lives in the WebKit driver layer, not the control plane;
// the customer API surfaces only the metadata below. `Description`
// is `*string` to capture explicit-null vs. unset.
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
	// SizeBytes + LastSavedAt — doc-150 item 5. SizeBytes is the byte size of
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

// CreateProfileRequest — V-426. Server's CreateProfileRequestSchema
// is `{ name, archetype?, description?, folder?, tags? }`. `Archetype` defaults
// server-side to the locked iPhone-16-Pro / iOS / Safari archetype
// when omitted (V-136 LOCKED_ARCHETYPE_ID).
type CreateProfileRequest struct {
	Name        string   `json:"name"`
	Archetype   string   `json:"archetype,omitempty"`
	Description string   `json:"description,omitempty"`
	Folder      string   `json:"folder,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Icon        string   `json:"icon,omitempty"` // short emoji (≤16) — per-account UI metadata
	Note        string   `json:"note,omitempty"` // short inline note (≤280)
}

// UpdateProfileRequest — V-426. Server's UpdateProfileRequestSchema
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
// Billing (V-082, V-183)
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

// Subscription — V-429. Matches the server's `publicSubscription`
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

// GetBillingStateResponse — V-429. `Subscription` is nullable
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
// Auth flows (V-079) — unauthenticated endpoints
// ──────────────────────────────────────────────────────────────────

type SignupRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name,omitempty"`
}

// SignupResponse — V-425. Matches the server's actual response shape
// (was previously typed as { account_id, verify_email_sent } which the
// server never returns). `DebugToken` is populated only when the
// server runs with `EMAIL_DELIVERY_MODE=stub`; production responses
// omit it.
type SignupResponse struct {
	VerificationEmailExpiresAt time.Time `json:"verification_email_expires_at"`
	DebugToken                 string    `json:"debug_token,omitempty"`
}

type VerifyEmailRequest struct {
	Token string `json:"token"`
}

// WebSession — V-425. Matches the server's `WebSessionSchema`
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

// LoginResponse — V-425 + V-353d. The server returns one of two
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
	// Populated on the MFA-required branch (V-353d).
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
	Session WebSession `json:"session"`
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
	Session WebSession `json:"session"`
}

// RefreshSessionRequest — V-425. Server expects `{ "token": "..." }`,
// not `{ "session_token": "..." }` as the Go SDK previously sent.
type RefreshSessionRequest struct {
	Token string `json:"token"`
}

type RefreshSessionResponse struct {
	Session WebSession `json:"session"`
}

// LogoutRequest — V-425. Server expects `{ "token": "..." }`, not
// `{ "session_token": "..." }`.
type LogoutRequest struct {
	Token string `json:"token"`
}

type LogoutResponse struct {
	OK bool `json:"ok"`
}

// V-445 — MFA challenge + step-up shapes.

// MfaChallengeRequest — exchange the V-353d login challenge_token
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
// session (V-353e step-up gate; 15-minute freshness window). Same
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

// V-460 / V-266 CLI/GUI activation flow (browser-OAuth-style).

// CliAuthorizeInitiateRequest — the CLI/GUI starts the flow with a
// CSRF nonce + optional human-friendly client label that appears on
// the dashboard's confirmation screen.
type CliAuthorizeInitiateRequest struct {
	State       string `json:"state"`
	ClientLabel string `json:"client_label,omitempty"`
}

// CliAuthorizeInitiateResponse — one-shot code + browser URL the
// CLI/GUI opens. The code is opaque and never displayed to the user;
// the CLI/GUI polls /exchange with it.
type CliAuthorizeInitiateResponse struct {
	Code       string    `json:"code"`
	BrowserURL string    `json:"browser_url"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// CliAuthorizeBindRequest — web-session-authenticated. Scopes default
// to ["account_owner"] server-side when omitted.
type CliAuthorizeBindRequest struct {
	Code   string   `json:"code"`
	State  string   `json:"state"`
	Scopes []string `json:"scopes,omitempty"`
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
