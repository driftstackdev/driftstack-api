---
layout: ../../layouts/DocLayout.astro
title: Concurrency & backpressure
description: How many sessions you can run at once on each tier, the 429 you get when you hit the cap, and how to back off cleanly in each SDK.
---

# Concurrency & backpressure

Driftstack caps how many sessions an account can keep open at the
same time — that's your **concurrency cap**, and it's the thing you
pay for (capacity, not per-call charges). When a create would push
you past it, the API answers with a `429` — that refusal is
**backpressure**: the server's signal to slow down and try again
later. This page covers the cap per tier, the exact 429 you'll see,
and the clean way to back off in each SDK.

## Concurrent-session caps

The caps match the shared `TIER_CONCURRENT_SESSION_LIMITS` constant
in `@driftstack/api-types` — the server enforces from the same
constant, so this table can't silently drift:

| Tier            | Cap | Notes                                                      |
| --------------- | --: | ---------------------------------------------------------- |
| `free`          |   1 | Evaluation tier; sessions also auto-destroy at 20 minutes. |
| `solo_manual`   |   1 | Manual operator workflow.                                  |
| `team_manual`   |   3 | Shared across the team.                                    |
| `agency_manual` |   8 | Shared across the agency.                                  |
| `api_starter`   |   2 |                                                            |
| `api_builder`   |   8 |                                                            |
| `api_scale`     |  24 |                                                            |
| `enterprise`    |  32 | Contract floor — per-account overrides raise it further.   |

A session counts against the cap from the moment it's created until
it reaches a terminal state (`destroyed` or `errored`). Cleanup is
your responsibility: paid tiers have no session time cap, so a leaked
session holds its slot until you destroy it. Wrap session work in a
`try / finally` (or `defer` in Go) so the destroy always runs — the
[session lifecycle guide](/guides/session-lifecycle/) shows the
pattern.

## The 429 signal

When `POST /v1/sessions` would exceed the cap, the server responds
with an RFC 9457 problem body:

```json
{
  "type": "https://errors.driftstack.dev/concurrency-limit",
  "title": "Concurrent session limit reached",
  "status": 429,
  "detail": "Account already has 2 active sessions; tier permits 2.",
  "current_sessions": 2,
  "limit": 2
}
```

Dispatch on the `type` URI (or the SDK's typed error class), never on
the `title` / `detail` strings — those can be reworded; the type URI
is stable.

Note there is **no `Retry-After` header on this 429** — that header
appears on [rate-limit](/reference/rate-limits/) 429s, where waiting
a fixed time genuinely helps. A concurrency 429 clears only when one
of _your own_ sessions finishes, so the right reaction is to destroy
or wait out your existing sessions, then retry with backoff.

## Backing off in each SDK

The SDKs retry rate-limit and transport errors automatically, but
deliberately do **not** retry `concurrency-limit` — retrying without
freeing a slot can't succeed, so the error is surfaced to your code
to decide. A simple exponential backoff:

**TypeScript:**

```ts
import { Driftstack, ConcurrencyLimitError } from '@driftstack/sdk';

async function createWithBackoff(client: Driftstack, opts = {}) {
  let delayMs = 1_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await client.sessions.create(opts);
    } catch (err) {
      if (!(err instanceof ConcurrencyLimitError)) throw err;
      console.warn(`at ceiling: ${err.currentSessions}/${err.limit}`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
  throw new Error('no session slot freed up after 5 attempts');
}
```

**Python:**

```python
import time
from driftstack import Driftstack, ConcurrencyLimitError

def create_with_backoff(client: Driftstack, opts: dict | None = None):
    delay_s = 1.0
    for _ in range(5):
        try:
            return client.sessions.create(opts or {})
        except ConcurrencyLimitError as e:
            print(f"at ceiling: {e.current_sessions}/{e.limit}")
            time.sleep(delay_s)
            delay_s = min(delay_s * 2, 60.0)
    raise RuntimeError("no session slot freed up after 5 attempts")
```

**Go:**

```go
func createWithBackoff(ctx context.Context, client *driftstack.Client) (*driftstack.Session, error) {
    delay := time.Second
    for attempt := 0; attempt < 5; attempt++ {
        session, err := client.Sessions.Create(ctx, nil)
        if err == nil {
            return session, nil
        }
        var cle *driftstack.ConcurrencyLimitError
        if !errors.As(err, &cle) {
            return nil, err
        }
        log.Printf("at ceiling: %d/%d", cle.CurrentSessions, cle.Limit)
        time.Sleep(delay)
        if delay *= 2; delay > time.Minute {
            delay = time.Minute
        }
    }
    return nil, fmt.Errorf("no session slot freed up after 5 attempts")
}
```

Better than a blind timer: if your workers run in one process, have
the finishing worker's `destroy` unblock the next create directly —
you're reacting to the actual slot release instead of guessing.

Don't pre-emptively throttle yourself below your cap, either. The
server's count is the truth; back off when it tells you to.

## Pooling sessions vs creating ephemeral ones

Two patterns work well:

- **Ephemeral (default):** create a session, do the work, destroy it.
  Simple, and there's nothing to leak as long as the destroy is in a
  `finally`.
- **Pooled:** keep N sessions alive and round-robin work onto them.
  Saves the per-job create round-trip for bursty workloads, but you
  now own pool health — replace sessions that hit `errored`, and
  destroy the pool on shutdown.

If you pool, don't subscribe the whole cap: on a 24-slot `api_scale`
account, a pool of 22 leaves headroom for ad-hoc creates that
shouldn't have to evict a pooled session.

## Rate limits vs concurrency limits

These are separate systems that both answer `429`:

- **[Rate limits](/reference/rate-limits/)** cap _request
  throughput_ (token buckets — how many calls per second). Their 429
  carries `type: …/rate-limited`, a `retry_after_seconds` field, and
  a `Retry-After` header, and the SDKs retry it for you.
- **Concurrency limits** (this page) cap _simultaneously-open
  sessions_. Their 429 carries `type: …/concurrency-limit` and no
  `Retry-After`, and the SDKs hand it to your code.

You can hit either one independently — a `POST /v1/sessions` draws
from both the `global` and `sessions:create` rate buckets _and_
checks the concurrency cap.

## Raising the cap

Upgrading your tier raises the cap — see
[driftstack.dev/pricing](https://driftstack.dev/pricing/). Above the
Enterprise floor, per-account overrides are possible: email
[support@driftstack.dev](mailto:support@driftstack.dev) with the
workload shape.

## Watching your own concurrency

- `GET /v1/account/me` returns `concurrent_session_active` next to
  `concurrent_session_cap` — a live gauge. See
  [Account](/api/account/).
- The [audit log](/api/audit-log/) records `session.created` and
  `session.destroyed` entries; diffing the two gives you an
  open-sessions timeseries for capacity planning.

## Next steps

- **[Session lifecycle](/guides/session-lifecycle/)** — states, teardown, and the always-destroy pattern.
- **[Rate limits](/reference/rate-limits/)** — the other 429, with per-tier bucket tables.
- **[Errors](/reference/errors/)** — every problem type and which ones are retryable.
