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
//     headers (V-666.AO Idempotency-Key path).

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
    expect(body).toMatch(/^type Client struct \{$/m);
    expect(body).toMatch(/^\s*apiKey {2}string$/m);
    expect(body).toMatch(/^\s*baseURL string$/m);
    expect(body).toMatch(/^\s*http {4}\*http\.Client$/m);
    expect(body).toMatch(/^\s*retry {3}RetryConfig$/m);
    expect(body).toMatch(/Sessions \*SessionsResource/);
    expect(body).toMatch(/APIKeys {2}\*APIKeysResource/);
    expect(body).toMatch(/Usage {4}\*UsageResource/);
    expect(body).toMatch(/Webhooks \*WebhooksResource/);
    expect(body).toMatch(/Profiles {9}\*ProfilesResource/);
    expect(body).toMatch(/ProfileSnapshots \*ProfileSnapshotsResource/);
    expect(body).toMatch(/Billing {10}\*BillingResource/);
    expect(body).toMatch(/\/\/ V-666 — crypto-checkout \/ crypto-orders\./);
    expect(body).toMatch(/CryptoOrders {5}\*CryptoOrdersResource/);
    expect(body).toMatch(/Auth {13}\*AuthResource/);
    expect(body).toMatch(/Account {10}\*AccountResource/);
    expect(body).toMatch(/\/\/ V-353b \/ V-448 — MFA enrollment management\./);
    expect(body).toMatch(/Mfa \*MfaResource/);
    expect(body).toMatch(/\/\/ V-216 \/ V-449 — append-only customer audit log\./);
    expect(body).toMatch(/AuditLog \*AuditLogResource/);
    expect(body).toMatch(/\/\/ V-204 \/ V-449 — email opt-in\/opt-out preferences\./);
    expect(body).toMatch(/EmailPreferences \*EmailPreferencesResource/);
    expect(body).toMatch(/\/\/ V-049 \/ V-458 — legal acceptance\./);
    expect(body).toMatch(/Legal \*LegalResource/);
    expect(body).toMatch(/\/\/ V-298c — Team RBAC\. Auth path integration is V-298d\./);
    expect(body).toMatch(/Team \*TeamResource/);
  });

  it('Functional options: WithBaseURL trim trailing slash + WithHTTPClient + WithRetry + WithTimeout (only when http nil) pinned', () => {
    expect(body).toMatch(/^type Option func\(\*Client\)$/m);
    expect(body).toMatch(
      /func WithBaseURL\(baseURL string\) Option \{\s*\n\s*return func\(c \*Client\) \{ c\.baseURL = strings\.TrimRight\(baseURL, "\/"\) \}\s*\n\}/,
    );
    expect(body).toMatch(
      /func WithHTTPClient\(h \*http\.Client\) Option \{\s*\n\s*return func\(c \*Client\) \{ c\.http = h \}\s*\n\}/,
    );
    expect(body).toMatch(
      /func WithRetry\(cfg RetryConfig\) Option \{\s*\n\s*return func\(c \*Client\) \{ c\.retry = cfg \}\s*\n\}/,
    );
    expect(body).toMatch(/func WithTimeout\(d time\.Duration\) Option \{/);
    expect(body).toMatch(
      /if c\.http == nil \{\s*\n\s*c\.http = &http\.Client\{Timeout: d\}\s*\n\s*\}/,
    );
  });

  it('New() factory: api_key required + DefaultBaseURL + DefaultRetry() + apply opts + default http.Client{Timeout: DefaultTimeout} + 15 resource wirings pinned', () => {
    expect(body).toMatch(
      /^func New\(apiKey string, opts \.\.\.Option\) \*Client \{\s*\n\s*c := &Client\{\s*\n\s*apiKey: {2}apiKey,\s*\n\s*baseURL: DefaultBaseURL,\s*\n\s*retry: {3}DefaultRetry\(\),\s*\n\s*\}/m,
    );
    expect(body).toMatch(/for _, opt := range opts \{\s*\n\s*opt\(c\)\s*\n\s*\}/);
    expect(body).toMatch(
      /if c\.http == nil \{\s*\n\s*c\.http = &http\.Client\{Timeout: DefaultTimeout\}\s*\n\s*\}/,
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

  it('requestOptions struct + do() with withRetry wrap + doOnce() context-cancellation surfaces as ctx.Err() + 8MB body cap + headers (Authorization Bearer + Accept + UA + conditional Content-Type + per-request extra headers V-666.AO)', () => {
    expect(body).toMatch(
      /^type requestOptions struct \{\s*\n\s*method\s+string\s*\n\s*path\s+string\s*\n\s*query\s+url\.Values\s*\n\s*body\s+any \/\/ marshalled to JSON when non-nil\s*\n\s*out\s+any \/\/ pointer the JSON response is decoded into; pass nil for 204\./m,
    );
    expect(body).toMatch(/\/\/ headers are extra request headers merged on top of the auth \+/);
    expect(body).toMatch(/\/\/ User-Agent \+ Content-Type defaults\. Resource methods use this/);
    expect(body).toMatch(/\/\/ for one-shot needs like Idempotency-Key \(V-666\.AO\)\./);
    expect(body).toMatch(/headers map\[string\]string/);
    expect(body).toMatch(
      /func \(c \*Client\) do\(ctx context\.Context, opts requestOptions\) error \{\s*\n\s*return withRetry\(ctx, c\.retry, func\(\) error \{\s*\n\s*return c\.doOnce\(ctx, opts\)\s*\n\s*\}\)\s*\n\}/,
    );
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
    expect(body).toMatch(/body, err := io\.ReadAll\(io\.LimitReader\(resp\.Body, maxBodyBytes\)\)/);
    expect(body).toMatch(
      /if resp\.StatusCode == http\.StatusNoContent \|\| len\(body\) == 0 \|\| opts\.out == nil \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /return errorFromResponse\(resp\.StatusCode, body, resp\.Header\.Get\("Retry-After"\)\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
