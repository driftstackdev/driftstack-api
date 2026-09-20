# Driftstack Go SDK

Stealth iPhone Safari automation, called from Go. Single-package, zero non-stdlib runtime dependencies, context-aware throughout.

> **Status:** published as a tagged pre-1.0 module. Commit `go.mod` and `go.sum` for reproducible deployments.

## Install

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest
```

Requires Go 1.22+ (the module's `go.mod` declares `go 1.22`; uses `errors.As`, `context.Cancel*`, and the `slices` package).

### Versions

Install normally. The version you `go get` is written into your `go.mod` and
does not move until you run `go get -u` — which is what you want, because while
the module is `0.x` a minor version can change the surface and a patch never
does. Read the CHANGELOG before moving to a new minor. `go.sum` already makes
the build reproducible, so there is nothing further to pin.

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

| Accessor                  | Methods                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.Sessions`         | `Create`, `List`, `Get`, `Navigate`, `Interact`, `Wait`, `GetState`, `Capture`, `Extract`, `Search`, `Login`, `Destroy`                                                                                                                         |
| `client.AgentSessions`    | `Create`, `Get`, `List`, `Iterate`, `Message`, `GetCapture`, `Transcript`, `Stop`, `Close`, `SetMode`, `SetEgress`, `SendInputEvent`, `Takeover`, `Handback`, `LivekitToken`, `Resume` (run AI tasks in a browser — see "Run an AI task" below) |
| `client.Egress`           | `AttachToSession`, `GetSessionProxy` (**capability-gated — 503/404 on every deployment today; no egress backend is wired**), `ListProxies`, `CreateProxy`, `UpdateProxy`, `DeleteProxy`, `TestProxy` (reusable proxy CRUD)                      |
| `client.Profiles`         | `Create`, `List`, `Iterate`, `Get`, `Update`, `Delete`, `Clone`                                                                                                                                                                                 |
| `client.ProfileSnapshots` | `Capture`, `ListForProfile`, `List`, `Iterate`, `Get`, `Restore`, `Delete`                                                                                                                                                                      |
| `client.Recipes`          | `Create`, `List`, `Iterate`, `Get`, `Delete` (snapshot and manage an agent-session's intent_log; no execute method)                                                                                                                             |
| `client.APIKeys`          | `Create`, `List`, `Rotate`, `Revoke`                                                                                                                                                                                                            |
| `client.Usage`            | `CurrentPeriod`                                                                                                                                                                                                                                 |
| `client.Webhooks`         | `Create`, `List`, `Get`, `Delete`, `ListDeliveries`, `ReplayDelivery`                                                                                                                                                                           |
| `client.Team`             | `Invite`, `ListMembers`, `ListInvites`, `ListOwners`, `AcceptInvite`, `RemoveMember`                                                                                                                                                            |
| `client.Billing`          | `GetState`, `CreateCheckoutSession`, `CreatePortalSession`                                                                                                                                                                                      |
| `client.CryptoOrders`     | `Quote`, `CreateCheckout`, `List`, `Iterate`, `Get`, `UpdateNote`, `Cancel`, `Receipt` (crypto checkout orders)                                                                                                                                 |
| `client.Auth`             | `Signup`, `VerifyEmail`, `Login`, `Refresh`, `Logout`, `RequestMagicLink`, `ConsumeMagicLink`, `RequestPasswordReset`, `ConfirmPasswordReset`                                                                                                   |
| `client.Mfa`              | `Status`, `Enroll`, `Verify`, `Disable`, `RegenerateRecoveryCodes` (TOTP MFA enrollment)                                                                                                                                                        |
| `client.Account`          | `Me` (full /v1/account/me with slug / region / avatar / mfa / teams)                                                                                                                                                                            |
| `client.Legal`            | `Documents`, `Required`, `Accept` (legal-document catalog + acceptance)                                                                                                                                                                         |
| `client.AuditLog`         | `List`, `Iterate`, `Export` (append-only account event ledger)                                                                                                                                                                                  |
| `client.EmailPreferences` | `List`, `Set`, `OptOut`, `OptIn` (non-critical email opt-out toggles)                                                                                                                                                                           |

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

A turn is never retried automatically. A refusal raised **before the turn did
any work** gives the key back, so the **same** key runs the turn once the cause
is gone: a 409 `TurnInProgress()`, a 429, a 402, a 403 about the plan's AI or
the model (`RequiresOwnKey()`), and a 502 whose `KeyRejected()` is false. So
does a `*ConflictError` whose `IdempotencyStatus()` is `"in_progress"` — the
first attempt is still being resolved. Every other answer is final for its key:
a completed turn, a failure after the turn started, a rejected own key
(`KeyRejected()`), a 500, a `"refuse"` result, and the 409 for a closed or
paused session. Those need a **new** key.

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
`answer`, `notice`; ignore names you do not recognise). When you asked for
information and none could be produced, `resp.AnswerUnavailable` says why.

When a turn ends before the task is finished, `resp.Notice` is the sentence to
show a person and `resp.NoticeReason` is the one word to switch on:
`step_limit`, `time_limit`, `budget_low`, `no_progress`, `repeated_step`,
`ai_unavailable`, `question` or `declined` — or, from a newer server, a value
this SDK has never heard of, so show `Notice` in the default branch.

A `capture` step's result carries a `CaptureID`; fetch the image as soon as the
turn ends, because screenshots are kept only briefly:

```go
results, _ := resp.ParsedResults()
for _, r := range results {
    if r.Kind == "success" && r.CaptureID != "" {
        shot, err := client.AgentSessions.GetCapture(ctx, session.ID, r.CaptureID)
        if err != nil {
            return err
        }
        name := "shot.png"
        if shot.ContentType == "image/jpeg" {
            name = "shot.jpg"
        }
        if err := os.WriteFile(name, shot.Bytes, 0o600); err != nil {
            return err
        }
    }
}
```

`Transcript` reads the conversation so far and then follows it live, so return
`false` when you have what you need (that closes the connection). To read only
what is there now:

```go
s, err := client.AgentSessions.Get(ctx, session.ID)
if err != nil {
    return err
}
if s.TranscriptLength > 0 {
    err = client.AgentSessions.Transcript(ctx, session.ID, nil,
        func(e driftstack.AgentTranscriptEvent) (bool, error) {
            fmt.Println(e.Index, e.Entry.Role, e.Entry.Body)
            return e.Index < s.TranscriptLength-1, nil
        })
}
```

Set `TranscriptOptions.LastEventID` (the last `Index` you saw) to carry on from
there.

AI refusals are typed: `*ForbiddenError` with `RequiresOwnKey()` (an Opus model
needs your own Anthropic key), `*ConflictError` with `TurnInProgress()` /
`SessionStatus()` / `ClosedReason()`, `*RateLimitError` (the message rate, or
too many AI turns running at once — wait `RetryAfterSeconds`, then send the
same request again, the same idempotency key and all), and the
`ErrBundledLlmBudgetExhausted`, `ErrBundledLlmConsentRequired` and
`ErrByokAnthropicRequired` sentinels — the last with `KeyRejected()`,
`KeySource()` and `KeyRejectedReason()` when Anthropic refused your own key. On
`Stop`, `(*FeatureUnavailableError).StopUnconfirmed()` means the stop could not
be confirmed: call `Stop` again. See
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

The OpenAPI 3.1 spec produced by the server is at `packages/sdk-python/openapi.json`. Types in `types.go` are hand-maintained against it (oapi-codegen is not used: current versions don't support OpenAPI 3.1 nullable shorthand).

## License

MIT.
