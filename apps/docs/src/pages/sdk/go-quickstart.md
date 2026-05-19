---
layout: ../../layouts/DocLayout.astro
title: Go quickstart
description: 5-minute getting-started for the driftstack-sdk Go client. Install, auth, first session, idiomatic error handling, and next steps.
---

# Go quickstart

— laser-focused 5-minute path to a working Go Driftstack
session. For the multi-language overview see the [combined quickstart](/quickstart/).

## Prerequisites

- Go 1.21+ (the SDK uses generic constraints + `slices` package).
- A Driftstack API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys).

## 1. Install

```bash
go get github.com/driftstackdev/driftstack-api/packages/sdk-go
```

> The Go SDK is alpha until the first tagged release lands. Pin to a
> specific commit during the alpha by running
> `go get github.com/driftstackdev/driftstack-api/packages/sdk-go@<sha>`.

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
    driftstack.WithBaseURL("https://api-staging.driftstack.dev"),
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
    log.Printf("captured: %s", shot.ID)
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
    "time"
)

if _, err := client.Sessions.Create(ctx, req); err != nil {
    var rl *driftstack.RateLimitError
    var cl *driftstack.ConcurrencyLimitError
    var qe *driftstack.QuotaExceededError
    switch {
    case errors.As(err, &rl):
        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
        // … retry
    case errors.As(err, &cl):
        log.Printf("concurrent cap reached (%d/%d)", cl.CurrentSessions, cl.Limit)
    case errors.As(err, &qe):
        log.Printf("tier limit reached (current=%d/limit=%d)", qe.Current, qe.Limit)
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
    driftstack.VerifyWebhookOptions{
        HeaderPrev: r.Header.Get("X-Driftstack-Signature-Prev"),
    },
)
if !ok {
    http.Error(w, "invalid signature", http.StatusUnauthorized)
    return
}
```

`HeaderPrev` is set by the API during the 24h signing-secret
rotation grace window — see
[`/webhooks/endpoints`](/webhooks/endpoints/) for the rotate-secret
endpoint. Verifier accepts either header so deliveries don't drop
while you roll the new secret across your verifier infra.

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
    map[string]any{"type": "mouseDown", "x": 200, "y": 150, "button": 0},
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

## Next steps

- [Session lifecycle reference](/guides/session-lifecycle/) —
  states, idle timeouts, reconnect semantics.
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
