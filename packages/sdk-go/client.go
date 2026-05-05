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

// Client is the top-level Driftstack SDK client. All resource
// accessors hang off it. Construct with [New]; close with Close
// (which is a no-op when the underlying http.Client is the default
// one — only matters if you've passed a custom client whose Transport
// holds resources).
type Client struct {
	apiKey  string
	baseURL string
	http    *http.Client
	retry   RetryConfig

	// Resource accessors (filled in by New).
	Sessions *SessionsResource
	APIKeys  *APIKeysResource
	Usage    *UsageResource
	Webhooks *WebhooksResource
	Profiles *ProfilesResource
	Billing  *BillingResource
	Auth     *AuthResource
}

// Option is the functional-options shape for [New].
type Option func(*Client)

// WithBaseURL overrides the API base URL (useful for self-host or
// integration tests against a local server).
func WithBaseURL(baseURL string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(baseURL, "/") }
}

// WithHTTPClient lets callers supply their own *http.Client (custom
// Transport, timeouts, etc.). When set, the SDK won't apply its
// default timeout on top.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

// WithRetry overrides the retry policy.
func WithRetry(cfg RetryConfig) Option {
	return func(c *Client) { c.retry = cfg }
}

// WithTimeout sets a per-request timeout. Ignored if WithHTTPClient
// is also passed (the caller's *http.Client wins).
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		if c.http == nil {
			c.http = &http.Client{Timeout: d}
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
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.http == nil {
		c.http = &http.Client{Timeout: DefaultTimeout}
	}

	c.Sessions = &SessionsResource{client: c}
	c.APIKeys = &APIKeysResource{client: c}
	c.Usage = &UsageResource{client: c}
	c.Webhooks = &WebhooksResource{client: c}
	c.Profiles = &ProfilesResource{client: c}
	c.Billing = &BillingResource{client: c}
	c.Auth = &AuthResource{client: c}
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
}

// do executes a single request with retry. Returns nil on success
// (with out populated when non-nil) or a typed Driftstack error.
func (c *Client) do(ctx context.Context, opts requestOptions) error {
	return withRetry(ctx, c.retry, func() error {
		return c.doOnce(ctx, opts)
	})
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
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent())
	if opts.body != nil {
		req.Header.Set("Content-Type", "application/json")
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
	// a hostile server can't OOM the SDK.
	const maxBodyBytes = 8 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return transportErrorFromHTTP("failed to read response body", err)
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if resp.StatusCode == http.StatusNoContent || len(body) == 0 || opts.out == nil {
			return nil
		}
		if err := json.Unmarshal(body, opts.out); err != nil {
			return transportErrorFromHTTP("failed to parse JSON response body", err)
		}
		return nil
	}

	return errorFromResponse(resp.StatusCode, body, resp.Header.Get("Retry-After"))
}
