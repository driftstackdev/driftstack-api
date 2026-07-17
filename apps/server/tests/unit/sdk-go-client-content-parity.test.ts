// W588.A — drift guard for packages/sdk-go/client.go.
// Top-level Driftstack Go client. Drift here either drops a
// resource accessor, breaks the functional-options pattern, or
// flips the User-Agent + Bearer + 8MB body-cap defaults.
//
//   • Constants: DefaultBaseURL = https://api.driftstack.dev,
//     DefaultTimeout = 30s.
//   • 15 resource accessors on Client struct (Sessions, APIKeys,
//     Usage, Webhooks, Profiles, ProfileSnapshots, Billing,
//     CryptoOrders, Auth, Account, Mfa, AuditLog, EmailPreferences,
//     Legal, Team).
//   • Functional options: WithBaseURL trim trailing slash +
//     WithHTTPClient + WithRetry + WithTimeout (ignored if
//     WithHTTPClient already set).
//   • New() sets defaults: baseURL=DefaultBaseURL, retry=
//     DefaultRetry(); http defaults to &http.Client{Timeout:
//     DefaultTimeout} when not set.
//   • Close() unwraps c.http.Transport to a `closer` interface;
//     safe no-op otherwise.
//   • userAgent: "driftstack-sdk-go/{Version}".
//   • doOnce: context cancellation surfaces as ctx.Err() not
//     TransportError; 8MB body cap; Authorization Bearer + Accept
//     + Content-Type when body + User-Agent + per-request extra
//     headers (V-666.AO Idempotency-Key path); terminal SSE response
//     envelopes become the authoritative status/body.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/client.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W588.A packages/sdk-go/client.go content parity', () => {
  const body = read(LIB);

  it('Package + constants: DefaultBaseURL https://api.driftstack.dev + DefaultTimeout 30s + framing comments pinned', () => {
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ DefaultBaseURL points at production\./);
    expect(body).toMatch(/^const DefaultBaseURL = "https:\/\/api\.driftstack\.dev"$/m);
    expect(body).toMatch(/\/\/ DefaultTimeout is the per-request timeout used when the caller/);
    expect(body).toMatch(/\/\/ doesn't pass http\.Client with their own Timeout set\./);
    expect(body).toMatch(/^const DefaultTimeout = 30 \* time\.Second$/m);
  });

  it('Client struct: apiKey/baseURL/http/retry private + 15 resource accessors (Sessions/APIKeys/Usage/Webhooks/Profiles/ProfileSnapshots/Billing/CryptoOrders/Auth/Account/Mfa/AuditLog/EmailPreferences/Legal/Team) with V-NNN inline comments', () => {
    // gofmt re-aligns these on every regen so absorb whitespace with \s+
    // rather than pinning exact column-counts (broke after 0fd7d437 sweep).
    expect(body).toMatch(/^type Client struct \{$/m);
    expect(body).toMatch(/^\s*apiKey\s+string$/m);
    expect(body).toMatch(/^\s*baseURL\s+string$/m);
    expect(body).toMatch(/^\s*http\s+\*http\.Client$/m);
    expect(body).toMatch(/^\s*retry\s+RetryConfig$/m);
    expect(body).toMatch(/Sessions\s+\*SessionsResource/);
    expect(body).toMatch(/APIKeys\s+\*APIKeysResource/);
    expect(body).toMatch(/Usage\s+\*UsageResource/);
    expect(body).toMatch(/Webhooks\s+\*WebhooksResource/);
    expect(body).toMatch(/Profiles\s+\*ProfilesResource/);
    expect(body).toMatch(/ProfileSnapshots\s+\*ProfileSnapshotsResource/);
    expect(body).toMatch(/Billing\s+\*BillingResource/);
    expect(body).toMatch(/\/\/ V-666 — crypto-checkout \/ crypto-orders\./);
    expect(body).toMatch(/CryptoOrders\s+\*CryptoOrdersResource/);
    expect(body).toMatch(/Auth\s+\*AuthResource/);
    expect(body).toMatch(/Account\s+\*AccountResource/);
    expect(body).toMatch(/\/\/ V-353b \/ V-448 — MFA enrollment management\./);
    expect(body).toMatch(/Mfa\s+\*MfaResource/);
    expect(body).toMatch(/\/\/ V-216 \/ V-449 — append-only customer audit log\./);
    expect(body).toMatch(/AuditLog\s+\*AuditLogResource/);
    expect(body).toMatch(/\/\/ V-204 \/ V-449 — email opt-in\/opt-out preferences\./);
    expect(body).toMatch(/EmailPreferences\s+\*EmailPreferencesResource/);
    expect(body).toMatch(/\/\/ V-049 \/ V-458 — legal acceptance\./);
    expect(body).toMatch(/Legal\s+\*LegalResource/);
    expect(body).toMatch(/\/\/ V-298c — Team RBAC\. Auth path integration is V-298d\./);
    expect(body).toMatch(/Team\s+\*TeamResource/);
  });

  it('Functional options: WithBaseURL trim trailing slash + WithHTTPClient + WithRetry + WithTimeout (only when http nil) pinned', () => {
    expect(body).toMatch(/^type Option func\(\*Client\)$/m);
    expect(body).toMatch(
      /func WithBaseURL\(baseURL string\) Option \{\s*\n\s*return func\(c \*Client\) \{ c\.baseURL = strings\.TrimRight\(baseURL, "\/"\) \}\s*\n\}/,
    );
    // sweep-3 — WithHTTPClient now also zeroes c.timeout (caller's client owns
    // timeouts); WithTimeout sets c.timeout (applied via a per-request context
    // deadline in do(), so a body-declared long-running op can auto-raise it).
    expect(body).toMatch(
      /func WithHTTPClient\(h \*http\.Client\) Option \{\s*\n\s*return func\(c \*Client\) \{\s*\n\s*c\.http = h\s*\n(\s*\/\/[^\n]*\n)*\s*c\.timeout = 0\s*\n\s*\}\s*\n\}/,
    );
    expect(body).toMatch(
      /func WithRetry\(cfg RetryConfig\) Option \{\s*\n\s*return func\(c \*Client\) \{ c\.retry = cfg \}\s*\n\}/,
    );
    expect(body).toMatch(/func WithTimeout\(d time\.Duration\) Option \{/);
    expect(body).toMatch(/if c\.http == nil \{\s*\n\s*c\.timeout = d\s*\n\s*\}/);
  });

  it('New() factory: api_key required + DefaultBaseURL + DefaultRetry() + timeout: DefaultTimeout + apply opts + default http.Client{} (no hard Timeout — per-request context deadline governs) + 15 resource wirings pinned', () => {
    expect(body).toMatch(
      /^func New\(apiKey string, opts \.\.\.Option\) \*Client \{\s*\n\s*c := &Client\{\s*\n\s*apiKey: {2}apiKey,\s*\n\s*baseURL: DefaultBaseURL,\s*\n\s*retry: {3}DefaultRetry\(\),\s*\n\s*timeout: DefaultTimeout,\s*\n\s*\}/m,
    );
    expect(body).toMatch(/for _, opt := range opts \{\s*\n\s*opt\(c\)\s*\n\s*\}/);
    // sweep-3 — no hard http.Client.Timeout; the per-request context deadline
    // in do() governs, so a body-declared long-running timeout can raise above
    // the base (DefaultTimeout / WithTimeout).
    expect(body).toMatch(
      /if c\.http == nil \{\s*\n(\s*\/\/[^\n]*\n)*\s*c\.http = &http\.Client\{\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/c\.Sessions = &SessionsResource\{client: c\}/);
    expect(body).toMatch(/c\.APIKeys = &APIKeysResource\{client: c\}/);
    expect(body).toMatch(/c\.Team = &TeamResource\{client: c\}/);
    expect(body).toMatch(/return c/);
  });

  it('Close() unwraps c.http.Transport via closer interface + safe no-op otherwise + userAgent format pinned', () => {
    expect(body).toMatch(
      /func \(c \*Client\) Close\(\) error \{\s*\n\s*if t, ok := c\.http\.Transport\.\(closer\); ok \{\s*\n\s*return t\.Close\(\)\s*\n\s*\}\s*\n\s*return nil\s*\n\}/,
    );
    expect(body).toMatch(/^type closer interface \{\s*\n\s*Close\(\) error\s*\n\}$/m);
    expect(body).toMatch(
      /func \(c \*Client\) userAgent\(\) string \{\s*\n\s*return fmt\.Sprintf\("driftstack-sdk-go\/%s", Version\)\s*\n\}/,
    );
  });

  it('requestOptions struct + do() with the retry-SAFETY gate (audit 2026-06-23): isRetrySafe(method, headers) ? withRetry-wrap : single doOnce — a keyless non-idempotent POST is sent exactly once (no double-submit), idempotent methods + keyed POST/PATCH still retry. doOnce() context-cancellation surfaces as ctx.Err() + 8MB body cap + headers (Authorization Bearer + Accept + UA + conditional Content-Type + per-request extra headers V-666.AO)', () => {
    expect(body).toMatch(
      /^type requestOptions struct \{\s*\n\s*method\s+string\s*\n\s*path\s+string\s*\n\s*query\s+url\.Values\s*\n\s*body\s+any \/\/ marshalled to JSON when non-nil\s*\n\s*out\s+any \/\/ pointer the JSON response is decoded into; pass nil for 204\./m,
    );
    expect(body).toMatch(/\/\/ headers are extra request headers merged on top of the auth \+/);
    expect(body).toMatch(/\/\/ User-Agent \+ Content-Type defaults\. Resource methods use this/);
    expect(body).toMatch(/\/\/ for one-shot needs like Idempotency-Key \(V-666\.AO\)\./);
    expect(body).toMatch(/headers map\[string\]string/);
    // sweep-3 — do() first applies the per-request timeout as a context
    // deadline (skipped for c.timeout==0 or an earlier caller deadline), then
    // the retry-safety gate.
    expect(body).toMatch(
      /func \(c \*Client\) do\(ctx context\.Context, opts requestOptions\) error \{/,
    );
    expect(body).toMatch(/if d := c\.resolveTimeout\(opts\); d > 0 \{/);
    expect(body).toMatch(/ctx, cancel = context\.WithTimeout\(ctx, d\)/);
    expect(body).toMatch(
      /if !isRetrySafe\(opts\.method, opts\.headers\) \{\s*\n\s*return c\.doOnce\(ctx, opts\)\s*\n\s*\}\s*\n\s*return withRetry\(ctx, c\.retry, func\(\) error \{\s*\n\s*return c\.doOnce\(ctx, opts\)\s*\n\s*\}\)\s*\n\}/,
    );
    // The retry-safety gate predicate itself (idempotent methods OR an
    // Idempotency-Key header) — the audit-2026-06-23 double-submit guard.
    expect(body).toMatch(/func isRetrySafe\(method string, headers map\[string\]string\) bool \{/);
    expect(body).toMatch(/req\.Header\.Set\("Authorization", "Bearer "\+c\.apiKey\)/);
    expect(body).toMatch(/req\.Header\.Set\("Accept", "application\/json"\)/);
    expect(body).toMatch(/req\.Header\.Set\("User-Agent", c\.userAgent\(\)\)/);
    expect(body).toMatch(
      /if opts\.body != nil \{\s*\n\s*req\.Header\.Set\("Content-Type", "application\/json"\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /for k, v := range opts\.headers \{\s*\n\s*req\.Header\.Set\(k, v\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if errors\.Is\(err, context\.Canceled\) \|\| errors\.Is\(err, context\.DeadlineExceeded\) \{\s*\n\s*return err\s*\n\s*\}/,
    );
    expect(body).toMatch(/return transportErrorFromHTTP\("http request failed", err\)/);
    expect(body).toMatch(/const maxBodyBytes = 8 \* 1024 \* 1024/);
    // Reads one byte past the cap so an oversized body is DETECTED and surfaced
    // as an explicit size-limit error rather than silently truncated by
    // io.LimitReader (which returns no error) and misreported as a JSON parse
    // failure. Fable SDK re-audit 2026-07-02.
    expect(body).toMatch(
      /body, err := io\.ReadAll\(io\.LimitReader\(resp\.Body, maxBodyBytes\+1\)\)/,
    );
    expect(body).toMatch(
      /if len\(body\) > maxBodyBytes \{\s*\n\s*return transportErrorFromHTTP\(\s*\n\s*fmt\.Sprintf\("response body exceeds %d-byte limit", maxBodyBytes\),/,
    );
    expect(body).toMatch(
      /statusCode := resp\.StatusCode\s*\n\s*retryAfter := resp\.Header\.Get\("Retry-After"\)/,
    );
    expect(body).toMatch(
      /if opts\.eventStream && statusCode >= 200 && statusCode < 300 &&\s*\n\s*strings\.EqualFold\(strings\.TrimSpace\(strings\.SplitN\(resp\.Header\.Get\("Content-Type"\), ";", 2\)\[0\]\), "text\/event-stream"\) \{\s*\n\s*statusCode, body, err = parseTerminalEventStream\(body\)/,
    );
    expect(body).toMatch(/retryAfter = ""/);
    expect(body).toMatch(
      /if statusCode >= 200 && statusCode < 300 \{\s*\n\s*if statusCode == http\.StatusNoContent \|\| len\(body\) == 0 \|\| opts\.out == nil \{\s*\n\s*return nil/,
    );
    expect(body).toMatch(/return errorFromResponse\(statusCode, body, retryAfter\)/);
    expect(body).toMatch(/func parseTerminalEventStream\(body \[\]byte\) \(int, \[\]byte, error\)/);
    expect(body).toMatch(/if event != "response" \{\s*\n\s*continue/);
    expect(body).toMatch(/if found \{\s*\n\s*return 0, nil, transportErrorFromHTTP/);
  });

  it('describes live agent-session and saved-recipe capabilities without internal roadmap or defer language', () => {
    expect(body).toContain(
      '// Agent sessions: create, inspect, control, stream, and close browser-agent work.',
    );
    expect(body).toContain(
      '// Saved recipes: create, list, inspect, delete, and request reusable suggestions.',
    );
    expect(body).not.toMatch(
      /AI-B4|AI-D|planning 132|write-only recipe|snapshot agent-session|stubs until|compile ahead/i,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
