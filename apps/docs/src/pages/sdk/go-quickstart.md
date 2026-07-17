---
layout: ../../layouts/DocLayout.astro
title: Go quickstart
description: 5-minute getting-started for the driftstack-sdk Go client. Install, auth, first session, idiomatic error handling, and next steps.
---

# Go quickstart

— laser-focused 5-minute path to a working Go Driftstack
session. For the multi-language overview see the [combined quickstart](/quickstart/).

## Prerequisites

- Go 1.22+ (the SDK uses generic constraints + `slices` package).
- Any paid Driftstack tier, including Manual. Free is supported through the
  desktop app, whose browser sign-in automatically stores a restricted
  `ds_test_…` device credential; that credential is not a general SDK or
  sandbox key.
- A `ds_live_…` customer API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys/).

## 1. Install

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest
```

> The Go SDK is published as a tagged pre-1.0 module. Commit the resulting
> `go.mod` and `go.sum` so production builds remain reproducible.

## 2. Configure the client

```go
package main

import (
    "context"
    "log"
    "os"

    driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
    client := driftstack.New(os.Getenv("DRIFTSTACK_API_KEY"))
    defer client.Close()

    ctx := context.Background()
    _ = ctx
    _ = client
}
```

`driftstack.New` returns `*Client`. The constructor accepts options:

```go
client := driftstack.New(
    os.Getenv("DRIFTSTACK_API_KEY"),
    driftstack.WithBaseURL("https://staging.driftstack.dev"),
    driftstack.WithHTTPClient(myInstrumentedHTTPClient), // OpenTelemetry, retries, etc.
)
```

`Close()` releases the underlying `http.Transport` connection pool.
Call once at process shutdown; idiomatic Go is `defer client.Close()`
in `main`.

## 3. Run a session

```go
package main

import (
    "context"
    "log"
    "os"

    driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func main() {
    client := driftstack.New(os.Getenv("DRIFTSTACK_API_KEY"))
    defer client.Close()
    ctx := context.Background()

    session, err := client.Sessions.Create(ctx, &driftstack.CreateSessionRequest{
        Label: "demo",
    })
    if err != nil {
        log.Fatal(err)
    }
    defer func() {
        if err := client.Sessions.Destroy(ctx, session.ID); err != nil {
            log.Printf("destroy failed: %v", err)
        }
    }()

    if _, err := client.Sessions.Navigate(ctx, session.ID, &driftstack.NavigateRequest{
        URL: "https://example.com",
    }); err != nil {
        log.Fatal(err)
    }

    shot, err := client.Sessions.Capture(ctx, session.ID, &driftstack.CaptureRequest{
        Kind: "screenshot",
    })
    if err != nil {
        log.Fatal(err)
    }
    // CaptureResponse: Kind / Data / Encoding / ByteSize / DurationMS.
    // For a screenshot, Data is the PNG base64-encoded.
    log.Printf("captured %d bytes (%s)", shot.ByteSize, shot.Encoding)
}
```

## 4. Error handling

Each problem-type maps to a typed error class. Match with
`errors.As` for the granular case, or `errors.Is` against a sentinel
for category-only matching:

```go
import (
    "errors"
    "log"
    "strings"
    "time"
)

if _, err := client.Sessions.Create(ctx, req); err != nil {
    var rl *driftstack.RateLimitError
    var cl *driftstack.ConcurrencyLimitError
    var qe *driftstack.QuotaExceededError
    var forbidden *driftstack.ForbiddenError
    switch {
    case errors.As(err, &rl):
        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
        // … retry
    case errors.As(err, &cl):
        log.Printf("concurrent cap reached (%d/%d)", cl.CurrentSessions, cl.Limit)
    case errors.As(err, &qe):
        log.Printf("tier limit reached (current=%d/limit=%d)", qe.Current, qe.Limit)
    case errors.As(err, &forbidden):
        if strings.Contains(forbidden.Message, "apiAccess") {
            // A Free account keeps desktop access but pauses customer API access.
            // The server detail is actionable; upgrade resumes an unrevoked key.
            log.Print(forbidden.Message)
        } else {
            log.Printf("forbidden: %s", forbidden.Message)
        }
    case errors.Is(err, driftstack.ErrAuth):
        log.Print("bad API key")
    default:
        log.Fatal(err) // Network / parse / unrecoverable.
    }
}
```

The full mapping from problem-type to Go error class lives at
[/reference/errors](/reference/errors/). For low-level cases the
errors also satisfy `errors.As` to a shared payload carrying
`.Status`, `.ProblemType`, and a `.Problem map[string]any` with the
unmapped extension fields.

## 5. Webhooks (optional)

```go
import driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"

ok := driftstack.VerifyWebhookSignature(
    rawBody,
    r.Header.Get("X-Driftstack-Signature"),
    os.Getenv("DRIFTSTACK_WEBHOOK_SECRET"),
    driftstack.VerifyWebhookOptions{},
)
if !ok {
    http.Error(w, "invalid signature", http.StatusUnauthorized)
    return
}
```

During the 24h signing-secret rotation grace window the single
`X-Driftstack-Signature` header carries both the new and old HMACs
as two `v1=` entries (`t=…,v1=<new>,v1=<old>`) — see
[`/webhooks/endpoints`](/webhooks/endpoints/) for the rotate-secret
endpoint. `VerifyWebhookSignature` already checks every `v1=` entry
in that header, so the call above keeps verifying through a rotation
without setting any option while you roll the new secret across your
verifier infra.

## Pair-mode takeover (interactive AI sessions)

For sessions where a human needs to step in mid-flight:

```go
ctx := context.Background()

// Create a pair-mode session, or switch an existing AI session.
session, err := client.AgentSessions.Create(ctx,
    &driftstack.CreateAgentSessionRequest{Mode: "pair"}, nil)
if err != nil { return err }
// OR: client.AgentSessions.SetMode(ctx, session.ID, "pair")

// The first input-event from a dashboard tab in pair-mode
// ai-driving fires the takeover-request transition. Pass a
// ClientID to scope the pair-mode lock to your tab / bot.
result, err := client.AgentSessions.SendInputEvent(ctx, session.ID,
    // Touch is the iPhone-native input (preferred over the mouse variants).
    map[string]any{"type": "tap", "x": 200, "y": 430},
    &driftstack.SendInputEventOptions{ClientID: "ops-dashboard-tab-a"},
)
if err != nil { return err }
if result.Kind == "pair-mode-takeover-fired" {
    // result.PairModeState["kind"] == "takeover-pending"
}

// Programmatic takeover from your own ops tooling:
after, err := client.AgentSessions.Takeover(ctx, session.ID, "cli-bot")
if err != nil { return err }
// after.PairModeState["kind"] == "takeover-pending"

// Hand control back when done:
back, err := client.AgentSessions.Handback(ctx, session.ID)
if err != nil { return err }
// back.PairModeState["kind"] == "handback-pending"
```

State machine kinds you'll see: `ai-driving`, `takeover-pending`,
`takeover-queued` (mid-decompose deferral), `human-driving`,
`handback-pending`, `handback-queued`.

### Modifier vocabulary

`keyDown` / `keyUp` events accept a `modifiers` array. Use the
canonical 4-name set — these map 1:1 onto Quartz `CGEventFlags`
on the macOS harness side:

```go
result, err := client.AgentSessions.SendInputEvent(ctx, session.ID,
    map[string]any{
        "type":      "keyDown",
        "key":       "k",
        "modifiers": []string{"cmd", "shift"},
    },
    &driftstack.SendInputEventOptions{ClientID: "ops-dashboard-tab-a"},
)
// driftstack.CanonicalModifierNames is the exported slice if you'd
// rather reference it than hard-code string literals.
```

DOM-standard names (`Shift / Control / Alt / Meta`) round-trip
through the schema unchanged but the harness decoder drops them.

## Next steps

- [Session lifecycle reference](/guides/session-lifecycle/) —
  states, the free-tier 20-minute duration cap, reconnect semantics.
- [Profile management](/guides/profile-management/) — persistent
  identity slots that survive across sessions.
- [Agent sessions](/api/agent-sessions/) — natural-language
  decompose-and-execute on top of the regular driver surface;
  AI / manual / pair modes, live SSE transcript stream, and the
  LiveKit-based live video subscription (auto-populated `livekit`
  field on session-create, or re-mint via
  `client.AgentSessions.LivekitToken(ctx, id)` after the 24h token TTL).
- [Bundled LLM](/api/bundled-llm/) and
  [BYOK Anthropic](/api/byok-anthropic/) — the two LLM rails
  agent sessions can use.
- [Idempotency keys](/reference/idempotency/) — `Idempotency-Key`
  header on create-style POSTs makes retries safe.
- [Webhook event catalog](/webhooks/events/) — every event the
  platform can push.
- [Error catalogue](/sdk/error-handling/) — every problem-type you
  might see and how to react.
- [API versioning](/api/versioning/) — what's additive vs. major.

Stuck? Email
[support@driftstack.dev](mailto:support@driftstack.dev) with your
account id (`acc_…`) and the failing `x-request-id`.
