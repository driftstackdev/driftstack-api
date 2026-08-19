# Driftstack Go SDK

Stealth iPhone Safari automation, called from Go. Single-package, zero non-stdlib runtime dependencies, context-aware throughout.

> **Status:** published as a tagged pre-1.0 module. Commit `go.mod` and `go.sum` for reproducible deployments.

## Install

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest
```

Requires Go 1.22+ (the module's `go.mod` declares `go 1.22`; uses `errors.As`, `context.Cancel*`, and the `slices` package).

## Quickstart

```go
package main

import (
    "context"
    "log"

    driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
    client := driftstack.New("ds_live_…")
    defer client.Close()

    ctx := context.Background()
    s, err := client.Sessions.Create(ctx, nil)
    if err != nil {
        log.Fatal(err)
    }
    if _, err := client.Sessions.Navigate(ctx, s.ID, &driftstack.NavigateRequest{
        URL: "https://example.com/",
    }); err != nil {
        log.Fatal(err)
    }
    state, err := client.Sessions.GetState(ctx, s.ID)
    if err != nil {
        log.Fatal(err)
    }
    log.Printf("title=%v", state.Title)
    _ = client.Sessions.Destroy(ctx, s.ID)
}
```

## Resources

Every public API endpoint is a typed method on a resource accessor. All take `context.Context` first.

| Accessor                  | Methods                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.Sessions`         | `Create`, `List`, `Get`, `Navigate`, `Interact`, `Wait`, `GetState`, `Capture`, `Extract`, `Search`, `Login`, `Destroy`                                                                                                    |
| `client.AgentSessions`    | `Create`, `Get`, `Message`, `Close`, `SetMode`, `SendInputEvent`, `Takeover`, `Handback`, `LivekitToken`, `Resume` (AI chat — decompose + execute)                                                                         |
| `client.Egress`           | `AttachToSession`, `GetSessionProxy` (**capability-gated — 503/404 on every deployment today; no egress backend is wired**), `ListProxies`, `CreateProxy`, `UpdateProxy`, `DeleteProxy`, `TestProxy` (reusable proxy CRUD) |
| `client.Profiles`         | `Create`, `List`, `Iterate`, `Get`, `Update`, `Delete`, `Clone` (V-313)                                                                                                                                                    |
| `client.ProfileSnapshots` | `Capture`, `ListForProfile`, `List`, `Iterate`, `Get`, `Restore`, `Delete` (V-312)                                                                                                                                         |
| `client.Recipes`          | `Create`, `List`, `Iterate`, `Get`, `Delete` (snapshot and manage an agent-session's intent_log; no execute method)                                                                                                        |
| `client.APIKeys`          | `Create`, `List`, `Rotate` (V-296), `Revoke`                                                                                                                                                                               |
| `client.Usage`            | `CurrentPeriod`                                                                                                                                                                                                            |
| `client.Webhooks`         | `Create`, `List`, `Get`, `Delete`, `ListDeliveries`, `ReplayDelivery` (V-307)                                                                                                                                              |
| `client.Team`             | `Invite`, `ListMembers`, `ListInvites`, `ListOwners`, `AcceptInvite`, `RemoveMember` (V-298)                                                                                                                               |
| `client.Billing`          | `GetState`, `CreateCheckoutSession`, `CreatePortalSession`                                                                                                                                                                 |
| `client.CryptoOrders`     | `Quote`, `CreateCheckout`, `List`, `Iterate`, `Get`, `UpdateNote`, `Cancel`, `Receipt` (V-666 — crypto checkout orders)                                                                                                    |
| `client.Auth`             | `Signup`, `VerifyEmail`, `Login`, `Refresh`, `Logout`, `RequestMagicLink`, `ConsumeMagicLink`, `RequestPasswordReset`, `ConfirmPasswordReset`                                                                              |
| `client.Mfa`              | `Status`, `Enroll`, `Verify`, `Disable`, `RegenerateRecoveryCodes` (V-353b — TOTP MFA enrollment)                                                                                                                          |
| `client.Account`          | `Me` (V-385 — full /v1/account/me with slug / region / avatar / mfa / teams)                                                                                                                                               |
| `client.Legal`            | `Documents`, `Required`, `Accept` (V-049 — legal-document catalog + acceptance)                                                                                                                                            |
| `client.AuditLog`         | `List`, `Iterate`, `Export` (V-216 — append-only account event ledger; V-462 export)                                                                                                                                       |
| `client.EmailPreferences` | `List`, `Set`, `OptOut`, `OptIn` (V-204 — non-critical email opt-out toggles)                                                                                                                                              |

Discriminated-union builders (`NewTapAction`, `NewSelectorCondition`, etc.) live in `types.go` for `Interact` and `Wait` requests.

## Error handling

Every server `application/problem+json` response maps to a typed Go error. Use `errors.As` for the structured payload, `errors.Is` for category matching.

```go
import "errors"

s, err := client.Sessions.Create(ctx, nil)
if err != nil {
    var rl *driftstack.RateLimitError
    if errors.As(err, &rl) {
        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
        return
    }

    var cle *driftstack.ConcurrencyLimitError
    if errors.As(err, &cle) {
        log.Printf("at concurrent ceiling: %d/%d", cle.CurrentSessions, cle.Limit)
        return
    }

    if errors.Is(err, driftstack.ErrAuth) {
        log.Fatal("API key bad")
    }
    log.Fatal(err)
}
```

The full hierarchy lives in `errors.go`; the URI → type mapping is in `error_mapping.go`.

## Retry

Default: 3 retries with exponential backoff and full jitter. Honours `Retry-After`. Retryable: `*TransportError`, `*RateLimitError`, and `*InternalError` — the plain 500. Other typed errors propagate immediately, and so do the other 5xx kinds such as `*DriverError` (502), where retrying an idempotent call would not help. This is the same set the TypeScript and Python SDKs retry; `IsRetryable` is the exported predicate the loop uses.

```go
client := driftstack.New(
    "ds_live_…",
    driftstack.WithRetry(driftstack.RetryConfig{
        MaxRetries:        5,
        InitialDelay:      500 * time.Millisecond,
        MaxDelay:          10 * time.Second,
        BackoffMultiplier: 2.0,
    }),
)

// Disable entirely:
client := driftstack.New("…", driftstack.WithRetry(driftstack.RetryConfig{Disabled: true}))
```

`context.Cancel` aborts the retry loop between attempts; the in-flight request is cancelled by the inner `http.NewRequestWithContext` chain.

For a streamed browser turn, set
`&driftstack.MessageOptions{IdempotencyKey: "…"}` and reuse the key only for
an ambiguous retry of the exact same session/message/approvals/BYOK request. A
completed turn replays without executing its browser actions again; changed or
still-running turns fail closed.

## Webhook signature verification

Stripe-style HMAC-SHA256 over `<unix_seconds>.<raw_body>`. Constant-time comparison via `hmac.Equal`. 5-minute default tolerance.

```go
http.HandleFunc("/driftstack-webhook", func(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    if !driftstack.VerifyWebhookSignature(body, r.Header.Get("X-Driftstack-Signature"), os.Getenv("DRIFTSTACK_WEBHOOK_SECRET")) {
        http.Error(w, "", http.StatusUnauthorized)
        return
    }
    // ... process event ...
    w.WriteHeader(http.StatusNoContent)
})
```

A complete stdlib-only receiver lives in [`examples/webhook_receiver`](examples/webhook_receiver/main.go).

## Examples

- [`quickstart`](examples/quickstart/main.go) — minimal create/navigate/capture/destroy.
- [`agent_chat`](examples/agent_chat/main.go) — AI agent session: create, send a task message, poll status, close.
- [`profile_management`](examples/profile_management/main.go) — persistent profiles: create, update, clone, iterate, delete.
- [`pagination`](examples/pagination/main.go) — cursor pagination over list endpoints.
- [`billing_flow`](examples/billing_flow/main.go) — billing state, checkout session, portal session.
- [`crypto_checkout`](examples/crypto_checkout/main.go) — crypto checkout + order lifecycle (idempotency-key pattern).
- [`egress_flow`](examples/egress_flow/main.go) — per-session SOCKS5 proxy config.
- [`egress_openvpn`](examples/egress_openvpn/main.go) — OpenVPN egress variant.
- [`error_handling`](examples/error_handling/main.go) — `errors.As` + `errors.Is` patterns and a custom retry loop.
- [`webhook_receiver`](examples/webhook_receiver/main.go) — stdlib HTTP receiver verifying signatures + dispatching by event type.
- [`goroutine_pool`](examples/goroutine_pool/main.go) — fan-out N concurrent session ops with a worker pool.
- [`scraping_pipeline`](examples/scraping_pipeline/main.go) — small target-list → session-per-target → screenshot pipeline.

## Configuration

```go
client := driftstack.New(
    apiKey,
    driftstack.WithBaseURL("https://api.driftstack.dev"),  // default
    driftstack.WithTimeout(30 * time.Second),              // default
    driftstack.WithRetry(driftstack.DefaultRetry()),
    driftstack.WithHTTPClient(myCustom *http.Client),      // BYO transport
)
```

## Development

```bash
cd packages/sdk-go
go build ./...
go test ./...
go vet ./...
```

The OpenAPI 3.1 spec produced by the server is at `packages/sdk-python/openapi.json`. Types in `types.go` are hand-maintained against it (see V-026 for why we don't run oapi-codegen — current versions don't support OpenAPI 3.1 nullable shorthand).

## License

MIT.
