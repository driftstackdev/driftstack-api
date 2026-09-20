package driftstack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultBaseURL points at production.
const DefaultBaseURL = "https://api.driftstack.dev"

// DefaultTimeout is the per-request timeout used when the caller
// doesn't pass http.Client with their own Timeout set.
const DefaultTimeout = 30 * time.Second

// bodyTimeoutHeadroom is added on top of a body-declared long-running
// operation timeout when deriving the transport timeout — covers network
// round-trip + the server's scheduling slack so the client never aborts a
// request the server would still honour. Mirrors the TS/Python SDKs.
const bodyTimeoutHeadroom = 15 * time.Second

// AgentMessageStreamTimeout is the absolute backstop for one agent turn's
// stream: 50 minutes. A turn stops planning new steps after about three
// minutes, but the steps it has already planned run to the end (a single step
// can wait several minutes) and the answer may still be read back after them.
// The stream's keep-alives hold the connection open meanwhile; this bound only
// stops a stream that keeps alive but never finishes from hanging forever.
const AgentMessageStreamTimeout = 50 * time.Minute

// bodyOperationTimeout extracts a long-running-operation deadline from a
// request body. Recognises the two server contract fields: timeout_ms
// (milliseconds — navigate / wait / interact) and timeout_seconds
// (login / search). Returns 0 when the body carries neither (or isn't a
// JSON object), so the caller falls back to the configured base timeout.
// Reads via a JSON round-trip so it tracks the body structs' json tags
// exactly (omitempty zero values serialise away → treated as absent).
func bodyOperationTimeout(body any) time.Duration {
	if body == nil {
		return 0
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return 0
	}
	var fields struct {
		TimeoutMS      int64 `json:"timeout_ms"`
		TimeoutSeconds int64 `json:"timeout_seconds"`
	}
	if err := json.Unmarshal(buf, &fields); err != nil {
		return 0
	}
	if fields.TimeoutMS > 0 {
		return time.Duration(fields.TimeoutMS) * time.Millisecond
	}
	if fields.TimeoutSeconds > 0 {
		return time.Duration(fields.TimeoutSeconds) * time.Second
	}
	return 0
}

// Client is the top-level Driftstack SDK client. All resource
// accessors hang off it. Construct with [New]; close with Close
// (which is a no-op when the underlying http.Client is the default
// one — only matters if you've passed a custom client whose Transport
// holds resources).
type Client struct {
	apiKey  string
	baseURL string
	// Team workspaces — when non-empty, every request carries
	// X-Driftstack-Account so reads resolve against that owner's workspace
	// (writes additionally require the admin role, server-enforced).
	effectiveAccount string
	http             *http.Client
	// timeout is the base per-request transport timeout, applied via a
	// per-request context deadline in do() (not http.Client.Timeout, so a
	// long-running op can auto-raise it — see resolveTimeout). Zero means no
	// SDK-applied timeout (a caller-supplied *http.Client via WithHTTPClient
	// owns its own Timeout instead).
	timeout time.Duration
	retry   RetryConfig

	// Resource accessors (filled in by New).
	Sessions         *SessionsResource
	Archetypes       *ArchetypesResource
	APIKeys          *APIKeysResource
	Usage            *UsageResource
	Webhooks         *WebhooksResource
	Profiles         *ProfilesResource
	ProfileSnapshots *ProfileSnapshotsResource
	Billing          *BillingResource
	// Resource for crypto-checkout / crypto-orders.
	CryptoOrders *CryptoOrdersResource
	Auth         *AuthResource
	Account      *AccountResource
	// Resource for MFA enrollment management.
	Mfa *MfaResource
	// Resource for the append-only customer audit log.
	AuditLog *AuditLogResource
	// Resource for email opt-in/opt-out preferences.
	EmailPreferences *EmailPreferencesResource
	// Resource for legal acceptance.
	Legal *LegalResource
	// Team RBAC. Act on an owner's account via X-Driftstack-Account.
	Team *TeamResource
	// Customer-configurable egress.
	Egress *EgressResource
	// Agent sessions: create, inspect, control, stream, and close browser-agent work.
	AgentSessions *AgentSessionsResource
	// Saved recipes: create, list, inspect, delete, and request reusable suggestions.
	Recipes *RecipesResource
}

// Option is the functional-options shape for [New].
type Option func(*Client)

// WithBaseURL overrides the API base URL (useful for self-host or
// integration tests against a local server).
func WithBaseURL(baseURL string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(baseURL, "/") }
}

// WithEffectiveAccount sets the team workspace (the owner's account id,
// "acc_<uuid>") — sends X-Driftstack-Account on every request. Reads
// resolve against that workspace; writes need the admin role
// (server-enforced). Omit for your own account.
func WithEffectiveAccount(ownerAccountID string) Option {
	return func(c *Client) { c.effectiveAccount = ownerAccountID }
}

// WithHTTPClient lets callers supply their own *http.Client (custom
// Transport, timeouts, etc.). When set, the SDK won't apply its
// default timeout on top (the supplied client's own Timeout / the
// caller's context deadline govern instead).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		c.http = h
		// The caller's client owns timeouts; don't layer the SDK's context
		// deadline on top.
		c.timeout = 0
	}
}

// WithRetry overrides the retry policy.
func WithRetry(cfg RetryConfig) Option {
	return func(c *Client) { c.retry = cfg }
}

// WithTimeout sets the base per-request timeout. Ignored if WithHTTPClient
// is also passed (the caller's *http.Client wins). Applied via a per-request
// context deadline — a long-running op whose body carries a longer
// timeout_ms / timeout_seconds auto-raises above this base so the SDK never
// aborts a request the server would still honour (see resolveTimeout).
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		if c.http == nil {
			c.timeout = d
		}
	}
}

// New constructs a Driftstack client. The API key is required; pass
// any combination of options for non-default behaviour.
func New(apiKey string, opts ...Option) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: DefaultBaseURL,
		retry:   DefaultRetry(),
		timeout: DefaultTimeout,
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.http == nil {
		// No hard http.Client.Timeout — the per-request context deadline in
		// do() governs instead, so a body-declared long-running timeout can
		// raise above the base (DefaultTimeout / WithTimeout).
		c.http = &http.Client{
			// Do NOT follow redirects: an authenticated JSON API call has no
			// legitimate 3xx, and Go copies custom headers across a cross-host
			// redirect (only Authorization/Cookie are stripped), which would leak
			// the customer's BYOK Anthropic key + Idempotency-Key to a foreign host
			// (audit 2026-09-08). Return the 3xx as-is so do() surfaces it.
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}

	c.Sessions = &SessionsResource{client: c}
	c.Archetypes = &ArchetypesResource{client: c}
	c.APIKeys = &APIKeysResource{client: c}
	c.Usage = &UsageResource{client: c}
	c.Webhooks = &WebhooksResource{client: c}
	c.Profiles = &ProfilesResource{client: c}
	c.ProfileSnapshots = &ProfileSnapshotsResource{client: c}
	c.Billing = &BillingResource{client: c}
	c.CryptoOrders = &CryptoOrdersResource{client: c}
	c.Auth = &AuthResource{client: c}
	c.Account = &AccountResource{client: c}
	c.Mfa = &MfaResource{client: c}
	c.AuditLog = &AuditLogResource{client: c}
	c.EmailPreferences = &EmailPreferencesResource{client: c}
	c.Legal = &LegalResource{client: c}
	c.Team = &TeamResource{client: c}
	c.Egress = &EgressResource{client: c}
	c.AgentSessions = &AgentSessionsResource{client: c}
	c.Recipes = &RecipesResource{client: c}
	return c
}

// Close releases resources held by the client. Safe to call multiple
// times; safe to skip if you didn't pass a custom transport.
func (c *Client) Close() error {
	if t, ok := c.http.Transport.(closer); ok {
		return t.Close()
	}
	return nil
}

type closer interface {
	Close() error
}

// userAgent returns the SDK's User-Agent string. Public for tests so
// they can assert it; not part of the customer-facing surface.
func (c *Client) userAgent() string {
	return fmt.Sprintf("driftstack-sdk-go/%s", Version)
}

// requestOptions holds per-call inputs for client.do.
type requestOptions struct {
	method string
	path   string
	query  url.Values
	body   any // marshalled to JSON when non-nil
	out    any // pointer the JSON response is decoded into; pass nil for 204.
	// headers are extra request headers merged on top of the auth +
	// User-Agent + Content-Type defaults. Resource methods use this
	// for one-shot needs like Idempotency-Key.
	headers map[string]string
	// eventStream negotiates/decodes the heartbeat-backed terminal response
	// representation. streamTimeout is its absolute SDK backstop.
	eventStream   bool
	streamTimeout time.Duration
	// onFrame, when set on an eventStream request, receives every progress
	// frame (event name + raw JSON data) as it arrives; the stream is then
	// parsed incrementally instead of being read whole first.
	onFrame func(event string, data []byte)
	// onOpenFrame, when set on an eventStream request, marks a stream that has
	// NO terminal event: the server keeps it open and sends frames as things
	// happen. Each frame goes to the callback, which returns false to stop
	// reading; the request returns when it does, when the server closes the
	// stream, or when the context ends.
	onOpenFrame func(event string, data []byte) (bool, error)
	// rawOut, when set, receives a 2xx body as bytes — with the media type the
	// server gave them — instead of being decoded as JSON.
	rawOut *rawBody
}

// rawBody is a response body that is not JSON: a screenshot, say.
type rawBody struct {
	contentType string
	bytes       []byte
}

// do executes a request with retry. Returns nil on success (with out
// populated when non-nil) or a typed Driftstack error.
//
// Retry SAFETY gate: only idempotent methods (or a POST/PATCH carrying an
// Idempotency-Key) are auto-retried. A keyless create is sent exactly once
// — a transient 5xx / network blip might already have been applied
// server-side, so retrying it could double-submit.
func (c *Client) do(ctx context.Context, opts requestOptions) error {
	// Apply the SDK's per-request transport timeout via a context deadline so a
	// long-running op (body timeout_ms / timeout_seconds) can auto-raise it,
	// and so the deadline covers the WHOLE retry loop (not just one attempt).
	// Skipped when timeout is 0 (caller-supplied http.Client owns timeouts) or
	// when the caller's context already carries an EARLIER deadline.
	if d := c.resolveTimeout(opts); d > 0 {
		if dl, ok := ctx.Deadline(); !ok || time.Until(dl) > d {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, d)
			defer cancel()
		}
	}
	if !isRetrySafe(opts.method, opts.headers) {
		return c.doOnce(ctx, opts)
	}
	return withRetry(ctx, c.retry, func() error {
		return c.doOnce(ctx, opts)
	})
}

// doEventStream runs one non-idempotent SSE request exactly once. It uses a
// long absolute backstop instead of the generic 30s request deadline; 15s server
// heartbeat comments keep intermediary/read-idle timers alive. Never retry: a
// dropped turn stream may have already dispatched browser actions.
func (c *Client) doEventStream(ctx context.Context, opts requestOptions) error {
	if c.timeout > 0 {
		d := opts.streamTimeout
		if d <= 0 {
			d = AgentMessageStreamTimeout
		}
		if dl, ok := ctx.Deadline(); !ok || time.Until(dl) > d {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, d)
			defer cancel()
		}
	}
	return c.doOnce(ctx, opts)
}

// resolveTimeout returns the effective per-request transport timeout. It's the
// configured base (DefaultTimeout / WithTimeout), auto-raised to a body-
// declared long-running deadline + headroom when the request body carries a
// timeout_ms / timeout_seconds (the navigate / wait / login / search contract,
// up to 120s server-side) — so a 30s base never aborts a 90s op the server
// would honour. The body timeout only ever RAISES the floor; a tiny body
// timeout never shortens a longer configured base. Zero base (custom client)
// returns zero (no SDK-applied timeout).
func (c *Client) resolveTimeout(opts requestOptions) time.Duration {
	if c.timeout <= 0 {
		return 0
	}
	bodyTimeout := bodyOperationTimeout(opts.body)
	if bodyTimeout <= 0 {
		return c.timeout
	}
	raised := bodyTimeout + bodyTimeoutHeadroom
	if raised > c.timeout {
		return raised
	}
	return c.timeout
}

// isRetrySafe reports whether a request may be transparently retried.
// True for methods that are idempotent by RFC 7231 semantics, or for any
// method carrying an Idempotency-Key header (case-insensitive) — the
// server replays the original response on that key, so a retry can't
// double-submit.
func isRetrySafe(method string, headers map[string]string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete,
		http.MethodOptions, http.MethodTrace:
		return true
	}
	// The VALUE check is load-bearing, not defensive tidying. The server treats
	// an empty or whitespace-only Idempotency-Key as ABSENT — it stores no dedup
	// record and replays nothing. A header present with a blank value is the
	// worst case: no server-side protection, yet it used to switch retries on,
	// so an unset variable reaching the map as "" turned a single POST into an
	// auto-retried one that could mint duplicates.
	for k, v := range headers {
		if strings.EqualFold(k, "Idempotency-Key") && strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

func (c *Client) doOnce(ctx context.Context, opts requestOptions) error {
	u, err := url.Parse(c.baseURL + opts.path)
	if err != nil {
		return transportErrorFromHTTP("invalid url", err)
	}
	if opts.query != nil {
		u.RawQuery = opts.query.Encode()
	}

	var bodyReader io.Reader
	if opts.body != nil {
		buf, err := json.Marshal(opts.body)
		if err != nil {
			return transportErrorFromHTTP("failed to marshal request body", err)
		}
		bodyReader = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, opts.method, u.String(), bodyReader)
	if err != nil {
		return transportErrorFromHTTP("failed to build request", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if c.effectiveAccount != "" {
		req.Header.Set("X-Driftstack-Account", c.effectiveAccount)
	}
	if opts.eventStream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	req.Header.Set("User-Agent", c.userAgent())
	if opts.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range opts.headers {
		req.Header.Set(k, v)
	}
	if opts.eventStream {
		// Resource headers cannot accidentally downgrade the negotiated transport.
		req.Header.Set("Accept", "text/event-stream")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// Cancellation surfaces as ctx.Err() through the transport;
		// honour it directly so callers see context.Canceled rather
		// than a wrapped TransportError.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return transportErrorFromHTTP("http request failed", err)
	}
	defer resp.Body.Close()

	// Drain body once — needed both for success path (decode) and
	// error path (parse problem-json). Cap at a reasonable ceiling so
	// a hostile server can't OOM the SDK. Read ONE byte past the cap so a
	// body that exceeds the ceiling is DETECTED and surfaced as an explicit
	// "too large" transport error rather than silently truncated: io.LimitReader
	// returns no error on truncation, so a >cap valid JSON body would otherwise
	// masquerade as a misleading "failed to parse JSON response body" below.
	const maxBodyBytes = 8 * 1024 * 1024
	if opts.onOpenFrame != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// An open-ended stream: same byte ceiling, no terminal event to wait for.
		if !isEventStreamSuccess(resp) {
			return transportErrorFromHTTP("expected an event stream and the response was not one", nil)
		}
		return readOpenEventStream(resp.Body, maxBodyBytes, opts.onOpenFrame)
	}
	if opts.eventStream && opts.onFrame != nil && isEventStreamSuccess(resp) {
		// Live path: hand each progress frame to the caller as it lands, under
		// the same byte ceiling and single-terminal rule as the buffered path.
		liveStatus, liveBody, err := readLiveEventStream(resp.Body, maxBodyBytes, opts.onFrame)
		if err != nil {
			return err
		}
		return decodeTerminalResult(liveStatus, liveBody, opts.out)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil {
		return transportErrorFromHTTP("failed to read response body", err)
	}
	if len(body) > maxBodyBytes {
		return transportErrorFromHTTP(
			fmt.Sprintf("response body exceeds %d-byte limit", maxBodyBytes),
			nil,
		)
	}

	statusCode := resp.StatusCode
	retryAfter := resp.Header.Get("Retry-After")
	if opts.eventStream && statusCode >= 200 && statusCode < 300 &&
		strings.EqualFold(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]), "text/event-stream") {
		statusCode, body, err = parseTerminalEventStream(body)
		if err != nil {
			return err
		}
		retryAfter = ""
	}

	if opts.rawOut != nil && statusCode >= 200 && statusCode < 300 {
		opts.rawOut.bytes = body
		opts.rawOut.contentType = strings.ToLower(strings.TrimSpace(
			strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]))
		return nil
	}
	if statusCode >= 200 && statusCode < 300 {
		if statusCode == http.StatusNoContent || len(body) == 0 || opts.out == nil {
			return nil
		}
		if err := json.Unmarshal(body, opts.out); err != nil {
			return transportErrorFromHTTP("failed to parse JSON response body", err)
		}
		return nil
	}

	return errorFromResponse(statusCode, body, retryAfter)
}

func parseTerminalEventStream(body []byte) (int, []byte, error) {
	normalized := strings.ReplaceAll(string(body), "\r\n", "\n")
	status := 0
	var terminalBody []byte
	found := false
	for _, block := range strings.Split(normalized, "\n\n") {
		event, data, _ := parseEventBlock(block)
		if event != "response" {
			continue
		}
		if found {
			return 0, nil, transportErrorFromHTTP("agent turn stream contained multiple terminal responses", nil)
		}
		s, b, err := decodeTerminalEnvelope(data)
		if err != nil {
			return 0, nil, err
		}
		found = true
		status = s
		terminalBody = b
	}
	if !found {
		return 0, nil, transportErrorFromHTTP("agent turn stream ended without a terminal response", nil)
	}
	return status, terminalBody, nil
}

// parseEventBlock reads one SSE block: its event name ("message" when none is
// given), its joined data lines, and whether it had any data. Comment lines
// (starting ":") are skipped.
func parseEventBlock(block string) (string, string, bool) {
	event := "message"
	data := make([]string, 0, 1)
	for _, line := range strings.Split(block, "\n") {
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimLeft(strings.TrimPrefix(line, "data:"), " \t"))
		}
	}
	return event, strings.Join(data, "\n"), len(data) > 0
}

// decodeTerminalEnvelope validates the one `event: response` payload,
// {status, body}, and returns its status and raw body.
func decodeTerminalEnvelope(data string) (int, []byte, error) {
	var envelope struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		return 0, nil, transportErrorFromHTTP("failed to parse terminal agent turn event", err)
	}
	if envelope.Status < 100 || envelope.Status > 599 || envelope.Body == nil {
		return 0, nil, transportErrorFromHTTP("terminal agent turn event had an invalid response envelope", nil)
	}
	return envelope.Status, append([]byte(nil), envelope.Body...), nil
}

// isEventStreamSuccess reports a 2xx text/event-stream response — the only
// shape read live.
func isEventStreamSuccess(resp *http.Response) bool {
	mediaType := strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
	return resp.StatusCode >= 200 && resp.StatusCode < 300 && strings.EqualFold(mediaType, "text/event-stream")
}

// readLiveEventStream parses an agent-turn stream as it arrives. Every
// non-terminal frame with data goes to onFrame in arrival order; the one
// terminal `event: response` is returned. The whole stream is held to limit
// bytes, and a second terminal is refused, exactly as parseTerminalEventStream
// does for a stream read whole.
func readLiveEventStream(r io.Reader, limit int, onFrame func(string, []byte)) (int, []byte, error) {
	status := 0
	var terminalBody []byte
	found := false
	handle := func(block string) error {
		event, data, hasData := parseEventBlock(block)
		if event == "response" {
			if found {
				return transportErrorFromHTTP("agent turn stream contained multiple terminal responses", nil)
			}
			s, b, err := decodeTerminalEnvelope(data)
			if err != nil {
				return err
			}
			found = true
			status = s
			terminalBody = b
			return nil
		}
		if hasData {
			onFrame(event, []byte(data))
		}
		return nil
	}

	buf := make([]byte, 32*1024)
	pending := ""
	total := 0
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			total += n
			if total > limit {
				return 0, nil, transportErrorFromHTTP(
					fmt.Sprintf("response body exceeds %d-byte limit", limit),
					nil,
				)
			}
			pending = strings.ReplaceAll(pending+string(buf[:n]), "\r\n", "\n")
			for {
				end := strings.Index(pending, "\n\n")
				if end < 0 {
					break
				}
				block := pending[:end]
				pending = pending[end+2:]
				if err := handle(block); err != nil {
					return 0, nil, err
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return 0, nil, transportErrorFromHTTP("failed to read response body", readErr)
		}
	}
	for _, block := range strings.Split(pending, "\n\n") {
		if err := handle(block); err != nil {
			return 0, nil, err
		}
	}
	if !found {
		return 0, nil, transportErrorFromHTTP("agent turn stream ended without a terminal response", nil)
	}
	return status, terminalBody, nil
}

// readOpenEventStream reads a stream that has no terminal event, handing each
// frame with data to onFrame as it arrives. Comments (the keep-alives) are
// skipped by parseEventBlock. It returns nil when onFrame returns false or the
// server closes the stream, onFrame's error when it returns one, and the
// context's error when the context ends. The whole stream is held to limit
// bytes, exactly as readLiveEventStream holds a turn's.
func readOpenEventStream(r io.Reader, limit int, onFrame func(string, []byte) (bool, error)) error {
	handle := func(block string) (bool, error) {
		event, data, hasData := parseEventBlock(block)
		if !hasData {
			return true, nil
		}
		return onFrame(event, []byte(data))
	}

	buf := make([]byte, 32*1024)
	pending := ""
	total := 0
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			total += n
			if total > limit {
				return transportErrorFromHTTP(
					fmt.Sprintf("response body exceeds %d-byte limit", limit),
					nil,
				)
			}
			pending = strings.ReplaceAll(pending+string(buf[:n]), "\r\n", "\n")
			for {
				end := strings.Index(pending, "\n\n")
				if end < 0 {
					break
				}
				block := pending[:end]
				pending = pending[end+2:]
				cont, err := handle(block)
				if err != nil || !cont {
					return err
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// The caller's cancel, or a deadline, surfaces as itself — the same
			// rule doOnce applies to a request that never got its headers.
			if errors.Is(readErr, context.Canceled) || errors.Is(readErr, context.DeadlineExceeded) {
				return readErr
			}
			return transportErrorFromHTTP("failed to read response body", readErr)
		}
	}
	for _, block := range strings.Split(pending, "\n\n") {
		cont, err := handle(block)
		if err != nil || !cont {
			return err
		}
	}
	return nil
}

// decodeTerminalResult is the success/problem tail for a live-read stream:
// a 2xx body is decoded into out, anything else maps to a typed error.
func decodeTerminalResult(statusCode int, body []byte, out any) error {
	if statusCode >= 200 && statusCode < 300 {
		if statusCode == http.StatusNoContent || len(body) == 0 || out == nil {
			return nil
		}
		if err := json.Unmarshal(body, out); err != nil {
			return transportErrorFromHTTP("failed to parse JSON response body", err)
		}
		return nil
	}
	return errorFromResponse(statusCode, body, "")
}
