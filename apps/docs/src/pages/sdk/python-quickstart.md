---
layout: ../../layouts/DocLayout.astro
title: Python quickstart
description: 5-minute getting-started for the driftstack-sdk Python client. Sync + async, install, auth, first session, error handling, and next steps.
---

# Python quickstart

— laser-focused 5-minute path to a working Python Driftstack
session. For the multi-language overview see the [combined quickstart](/quickstart/).

## Prerequisites

- Python 3.10+ (the SDK uses modern type hints + structural matches).
- A Driftstack API key. Mint one at
  [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys).

## 1. Install

```bash
pip install driftstack-sdk
# or: uv add driftstack-sdk
# or: poetry add driftstack-sdk
```

The package ships both sync (`Driftstack`) and async
(`AsyncDriftstack`) clients off the same wire shape. Pick whichever
matches your runtime.

## 2. Configure the client

Sync (most common, integrates with Flask / Django / scripts):

```python
import os
from driftstack import Driftstack

client = Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"])
# Optional: base_url="https://staging.driftstack.dev"
```

Async (FastAPI / Starlette / asyncio scripts):

```python
import asyncio
import os
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
        ...
```

The async client is `httpx.AsyncClient`-backed and only opens the
connection pool inside `async with`. The sync client uses a
synchronous `httpx.Client` and supports the context-manager pattern
(`with Driftstack(...) as client:`) for explicit pool cleanup.

## 3. Run a session

Sync:

```python
import os
from driftstack import Driftstack

with Driftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
    session = client.sessions.create({"label": "demo"})
    sid = str(session.id)

    try:
        client.sessions.navigate(sid, {"url": "https://example.com"})
        screenshot = client.sessions.capture(sid, {"kind": "screenshot"})
        # capture() returns a CaptureResponse model — attribute access, not
        # subscript: .kind / .data / .encoding / .byte_size / .duration_ms.
        # For a screenshot, .data is the PNG base64-encoded.
        print(f"captured {screenshot.byte_size} bytes ({screenshot.encoding})")

        state = client.sessions.get_state(sid)
        print("url:", state.url, "title:", state.title)
    finally:
        client.sessions.destroy(sid)
```

Async:

```python
import asyncio
import os
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key=os.environ["DRIFTSTACK_API_KEY"]) as client:
        session = await client.sessions.create({"label": "demo"})
        sid = str(session.id)
        try:
            await client.sessions.navigate(sid, {"url": "https://example.com"})
            screenshot = await client.sessions.capture(sid, {"kind": "screenshot"})
            print(f"captured {screenshot.byte_size} bytes ({screenshot.encoding})")
        finally:
            await client.sessions.destroy(sid)

asyncio.run(main())
```

## 4. Error handling

The SDK raises typed exceptions for server errors. Catch
`DriftstackError` and inspect `.status` (HTTP) or `.problem_type`
(RFC 9457). Other RFC 9457 fields are on the parsed `.problem` dict:

```python
from driftstack.errors import DriftstackError

try:
    client.sessions.create({"label": "demo"})
except DriftstackError as err:
    if err.status == 429 and (err.problem_type or "").endswith("/tier-limit"):
        # Tier usage quota reached (not the concurrency cap — that is
        # /concurrency-limit). Wait + retry, or upgrade.
        print("cap reached:", err.problem.get("detail"))
    elif err.status == 401:
        print("bad API key")
    else:
        print("driftstack error:", err.problem_type, err.problem)
```

For granular handling, catch the subclass directly
(`RateLimitError`, `ConcurrencyLimitError`, `QuotaExceededError`,
`SessionDestroyedError`, …). The full mapping lives at
[/reference/errors](/reference/errors/).

## 5. Webhooks (optional)

```python
from driftstack import verify_webhook_signature

ok = verify_webhook_signature(
    body=raw_body,
    header=request.headers["x-driftstack-signature"],
    secret=os.environ["DRIFTSTACK_WEBHOOK_SECRET"],
)
if not ok:
    return Response("invalid signature", status_code=401)
```

During the 24h signing-secret rotation grace window the single
`x-driftstack-signature` header carries both the new and old HMACs
as two `v1=` entries (`t=…,v1=<new>,v1=<old>`) — see
[`/webhooks/endpoints`](/webhooks/endpoints/) for the rotate-secret
endpoint. `verify_webhook_signature` already checks every `v1=`
entry in that header, so the call above keeps verifying through a
rotation with no extra arguments while you roll the new secret
across your verifier infra.

## Pair-mode takeover (interactive AI sessions)

For sessions where a human needs to step in mid-flight:

```python
# Create a pair-mode session, or switch an existing AI session.
session = client.agent_sessions.create({"mode": "pair"})
# OR: client.agent_sessions.set_mode(session_id, "pair")

# When a dashboard user clicks the live preview, the first input-
# event automatically fires the takeover-request transition. Pass
# client_id (any string identifying the calling tab / bot):
result = client.agent_sessions.send_input_event(
    session["id"],
    {"type": "mouseDown", "x": 200, "y": 150, "button": 0},
    client_id="ops-dashboard-tab-a",
)
if result["kind"] == "pair-mode-takeover-fired":
    # result["pair_mode_state"]["kind"] == "takeover-pending"
    pass

# Programmatic takeover from your own ops tooling:
after = client.agent_sessions.takeover(session["id"], "cli-bot")
print(after["pair_mode_state"]["kind"])  # takeover-pending

# Hand control back when done:
back = client.agent_sessions.handback(session["id"])
print(back["pair_mode_state"]["kind"])  # handback-pending
```

Async mirrors are 1:1: `await aclient.agent_sessions.set_mode(...)`,
`await aclient.agent_sessions.send_input_event(...)`,
`await aclient.agent_sessions.takeover(...)`,
`await aclient.agent_sessions.handback(...)`.

State machine kinds you'll see: `ai-driving`, `takeover-pending`,
`takeover-queued` (mid-decompose deferral), `human-driving`,
`handback-pending`, `handback-queued`.

### Modifier vocabulary

`keyDown` / `keyUp` events accept a `modifiers` array. Use the
canonical 4-name set — these map 1:1 onto Quartz `CGEventFlags`
on the macOS harness side:

```py
from driftstack.resources.agent_sessions import CANONICAL_MODIFIER_NAMES

result = client.agent_sessions.send_input_event(
    session["id"],
    {"type": "keyDown", "key": "k", "modifiers": ["cmd", "shift"]},
    client_id="dashboard-tab-a",
)
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
  `client.agent_sessions.livekit_token(id)` after the 24h token TTL —
  also available on the async client).
- [Bundled LLM](/api/bundled-llm/) and
  [BYOK Anthropic](/api/byok-anthropic/) — the two LLM rails
  agent sessions can use.
- [Idempotency keys](/reference/idempotency/) — `Idempotency-Key`
  header on create-style POSTs makes retries safe.
- [Webhook event catalog](/webhooks/events/) — every event the
  platform can push.
- [Error catalogue](/sdk/error-handling/) — every problem-type you
  might see and how to react.

Stuck? Email
[support@driftstack.dev](mailto:support@driftstack.dev) with your
account id (`acc_…`) and the failing `x-request-id`.
