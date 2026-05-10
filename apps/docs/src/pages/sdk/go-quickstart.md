---
layout: ../../layouts/DocLayout.astro
title: Go quickstart
description: 5-minute getting-started for the driftstack-sdk Go client. Install, auth, first session, idiomatic error handling, and next steps.
---

# Go quickstart

V-504 — laser-focused 5-minute path to a working Go Driftstack
session. For the multi-language overview see the [combined quickstart](/quickstart/).

## Prerequisites

- Go 1.21+ (the SDK uses generic constraints + `slices` package).
- A Driftstack API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys).

## 1. Install

```bash
go get github.com/driftstackdev/driftstack-go
```

> The Go SDK is alpha until the first registry tag lands. Pin to a
> specific commit during the alpha by running
> `go get github.com/driftstackdev/driftstack-go@<sha>`.

## 2. Configure the client

```go
package main

import (
    "context"
    "log"
    "os"

    driftstack "github.com/driftstackdev/driftstack-go"
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

    driftstack "github.com/driftstackdev/driftstack-go"
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

Errors implement the `*driftstack.APIError` type, which carries
both HTTP-level metadata and the parsed RFC 9457 Problem Details:

```go
import (
    "errors"
    "log"
)

if _, err := client.Sessions.Create(ctx, req); err != nil {
    var apiErr *driftstack.APIError
    if errors.As(err, &apiErr) {
        switch {
        case apiErr.Status == 429 && apiErr.Problem.Type == "/tier-limit":
            log.Printf("cap reached: %s", apiErr.Problem.Detail)
        case apiErr.Status == 401:
            log.Print("bad API key")
        default:
            log.Printf("driftstack error: %+v", apiErr.Problem)
        }
        log.Printf("request id: %s", apiErr.RequestID)
    } else {
        log.Fatal(err) // Network / parse / unrecoverable.
    }
}
```

The SDK retries idempotent GETs on 5xx + network errors with
exponential backoff (max 3 attempts, jittered). Mutating writes
only retry when an [idempotency key](/api/idempotency/) is supplied
via the request struct's `IdempotencyKey` field (when present).

## 5. Webhooks (optional)

```go
import "github.com/driftstackdev/driftstack-go"

ok := driftstack.VerifyWebhookSignature(driftstack.VerifyWebhookSignatureInput{
    Body:       rawBody,
    Header:     r.Header.Get("X-Driftstack-Signature"),
    HeaderPrev: r.Header.Get("X-Driftstack-Signature-Prev"),
    Secret:     os.Getenv("DRIFTSTACK_WEBHOOK_SECRET"),
})
if !ok {
    http.Error(w, "invalid signature", http.StatusUnauthorized)
    return
}
```

`HeaderPrev` is set by the API during a 24h
[signing-secret rotation grace window](/webhooks/signature-rotation/);
verifier accepts either header so deliveries don't drop while you
roll the new secret across your verifier infra.

## Next steps

- [Session lifecycle reference](/guides/session-lifecycle/) —
  states, idle timeouts, reconnect semantics.
- [Profile management](/guides/profile-management/) — persistent
  identity slots that survive across sessions.
- [Webhook event catalog](/webhooks/events/) — every event the
  platform can push.
- [Error catalogue](/sdk/error-handling/) — every problem-type you
  might see and how to react.
- [API versioning](/api/versioning/) — what's additive vs. major.

Stuck? Email
[support@driftstack.dev](mailto:support@driftstack.dev) with your
account id (`acc_…`) and the failing `x-request-id`.
