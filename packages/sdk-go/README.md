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
| `client.AgentSessions`    | `Create`, `Get`, `List`, `Iterate`, `Message`, `Stop`, `Close`, `SetMode`, `SetEgress`, `SendInputEvent`, `Takeover`, `Handback`, `LivekitToken`, `Resume` (run AI tasks in a browser — see "Run an AI task" below)        |
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

A turn is never retried automatically, and once the server has accepted a key
the response it gives for that key is final — errors included. Reuse the same
key only when you got no response at all, or a `*ConflictError` whose
`IdempotencyStatus()` is `"in_progress"`. After any other error (a 409
`TurnInProgress()`, a 429, a 402, a 502, a 403 `RequiresOwnKey()`), fix the
cause or wait, then send the turn with a **new** key.

## Run an AI task

```go
session, err := client.AgentSessions.Create(ctx,
    &driftstack.CreateAgentSessionRequest{Mode: "ai"},
    &driftstack.CreateOptions{IdempotencyKey: newKey()})
if err != nil {
    return err
}
defer client.AgentSessions.Close(ctx, session.ID)
// Poll Get while session.Status is "provisioning" before sending.

resp, err := client.AgentSessions.Message(ctx, session.ID,
    "Open https://example.com and tell me the main heading.",
    &driftstack.MessageOptions{
        IdempotencyKey: newKey(),
        OnStep: func(step driftstack.AgentStepEvent) { // live progress
            fmt.Println(step.Index, step.Result.Kind)
        },
    })
if err != nil {
    return err
}
if resp.Kind == "plan-executed" {
    fmt.Println(resp.Answer, resp.Notice) // Notice set = the task is not finished yet
    results, _ := resp.ParsedResults()
    for _, r := range results {
        if r.Kind == "confirmation_required" {
            // To approve it, send the next message with
            // ApproveConsequentialActions: []driftstack.ConsequentialActionApproval{driftstack.ApprovalFor(r)}.
        }
    }
}
```

`OnEvent` receives the other progress events (`phase`, `plan`, `step_start`,
`answer`, `notice`; ignore names you do not recognise). AI refusals are typed:
`*ForbiddenError` with `RequiresOwnKey()` (an Opus model needs your own
Anthropic key), `*ConflictError` with `TurnInProgress()` / `SessionStatus()`,
`*RateLimitError`, and the `ErrBundledLlmBudgetExhausted`,
`ErrBundledLlmConsentRequired` and `ErrByokAnthropicRequired` sentinels. See
[`examples/agent_chat`](examples/agent_chat/main.go) for the complete flow.

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
- [`agent_chat`](examples/agent_chat/main.go) — run an AI task: create, wait until ready, send a task with live progress, handle each result kind (answer, notice, approvals), close.
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
