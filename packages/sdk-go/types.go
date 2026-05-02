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

// AccountTier is the closed enum of pricing tiers (see D-019).
type AccountTier string

const (
	TierFree       AccountTier = "free"
	TierStarter    AccountTier = "starter"
	TierSolo       AccountTier = "solo"
	TierBuilder    AccountTier = "builder"
	TierScale      AccountTier = "scale"
	TierEnterprise AccountTier = "enterprise"
)

// AccountStatus.
type AccountStatus string

const (
	AccountActive    AccountStatus = "active"
	AccountSuspended AccountStatus = "suspended"
	AccountDeleted   AccountStatus = "deleted"
)

// APIKeyScope is one of the three scope tokens.
type APIKeyScope string

const (
	ScopeRead  APIKeyScope = "read"
	ScopeWrite APIKeyScope = "write"
	ScopeAdmin APIKeyScope = "admin"
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

// WebhookEventType — closed enum of supported webhook events.
type WebhookEventType string

const (
	EventSessionCompleted  WebhookEventType = "session.completed"
	EventSessionFailed     WebhookEventType = "session.failed"
	EventQuotaWarning80Pct WebhookEventType = "quota.warning_80pct"
	EventQuotaExceeded     WebhookEventType = "quota.exceeded"
	EventAPIKeyRevoked     WebhookEventType = "api_key.revoked"
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

// ──────────────────────────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────────────────────────

type Session struct {
	ID          string         `json:"id"`
	AccountID   string         `json:"account_id"`
	APIKeyID    string         `json:"api_key_id"`
	Status      SessionStatus  `json:"status"`
	Archetype   string         `json:"archetype"`
	Label       *string        `json:"label"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	LastStateAt *time.Time     `json:"last_state_at"`
	DestroyedAt *time.Time     `json:"destroyed_at"`
}

type CreateSessionRequest struct {
	Label    string         `json:"label,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
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
}

type NavigateResponse struct {
	URL        string `json:"url"`
	Status     int    `json:"status"`
	FinalURL   string `json:"final_url"`
	DurationMS int    `json:"duration_ms"`
}

// InteractAction is a discriminated-union of action kinds. Use the
// constructors (NewTapAction, NewTypeAction, ...) to build one.
type InteractAction struct {
	Kind     string  `json:"kind"`               // tap | type | scroll | press
	Selector string  `json:"selector,omitempty"` // tap, type, scroll
	Text     string  `json:"text,omitempty"`     // type
	X        int     `json:"x,omitempty"`        // scroll
	Y        int     `json:"y,omitempty"`        // scroll
	Key      string  `json:"key,omitempty"`      // press
	Offset   *Offset `json:"offset,omitempty"`   // tap
}

// Offset is a 2D pixel offset (used by tap actions).
type Offset struct {
	X int `json:"x"`
	Y int `json:"y"`
}

func NewTapAction(selector string) InteractAction {
	return InteractAction{Kind: "tap", Selector: selector}
}

func NewTypeAction(selector, text string) InteractAction {
	return InteractAction{Kind: "type", Selector: selector, Text: text}
}

func NewScrollAction(x, y int) InteractAction {
	return InteractAction{Kind: "scroll", X: x, Y: y}
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
	Kind     string `json:"kind"`               // selector | selector_hidden | url_matches | time_ms
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
	return WaitCondition{Kind: "time_ms", MS: ms}
}

type WaitRequest struct {
	Condition WaitCondition `json:"condition"`
	TimeoutMS int           `json:"timeout_ms,omitempty"`
}

type WaitResponse struct {
	Satisfied  bool `json:"satisfied"`
	DurationMS int  `json:"duration_ms"`
}

type SessionState struct {
	URL          *string          `json:"url"`
	Title        *string          `json:"title"`
	Cookies      []map[string]any `json:"cookies"`
	LocalStorage map[string]string `json:"local_storage"`
	CapturedAt   time.Time        `json:"captured_at"`
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

type WebhookEndpoint struct {
	ID                  string             `json:"id"`
	URL                 string             `json:"url"`
	SecretPrefix        string             `json:"secret_prefix"`
	Events              []WebhookEventType `json:"events"`
	Description         *string            `json:"description"`
	Active              bool               `json:"active"`
	ConsecutiveFailures int                `json:"consecutive_failures"`
	LastSuccessAt       *time.Time         `json:"last_success_at"`
	LastFailureAt       *time.Time         `json:"last_failure_at"`
	DisabledAt          *time.Time         `json:"disabled_at"`
	CreatedAt           time.Time          `json:"created_at"`
}

type WebhookEndpointList struct {
	Data []WebhookEndpoint `json:"data"`
}

type CreateWebhookRequest struct {
	URL         string             `json:"url"`
	Events      []WebhookEventType `json:"events"`
	Description string             `json:"description,omitempty"`
}

type CreateWebhookResponse struct {
	WebhookEndpoint
	Secret string `json:"secret"`
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
