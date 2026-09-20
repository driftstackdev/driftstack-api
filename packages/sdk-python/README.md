# Driftstack Python SDK

Stealth iPhone Safari automation, called from Python. Sync (`Driftstack`) and async (`AsyncDriftstack`) clients in one package, sharing the same typed resources, error hierarchy, and retry policy.

> **Status:** published on PyPI, pre-1.0, and classified Alpha. Use requirements constraints or a lockfile for reproducible deployments.

## Install

```bash
pip install driftstack-sdk
```

The distribution name is `driftstack-sdk`; the import name is `driftstack`.

Requires Python 3.10+.

### Versions

Install normally. In a requirements file, write the compatible-release
specifier `driftstack-sdk~=0.2.0`: it takes patch releases and stops before the
next minor — which is what you want, because while the SDK is `0.x` a minor
version can change the surface and a patch never does. Read the CHANGELOG before
moving to a new minor. Pin an exact version only if you need a byte-for-byte
reproducible build, and note that a lockfile already gives you one.

## Quickstart (sync)

```python
from driftstack import Driftstack

with Driftstack(api_key="ds_live_…") as client:
    session = client.sessions.create({"label": "ci-run"})
    client.sessions.navigate(str(session.id), {"url": "https://example.com/"})
    state = client.sessions.get_state(str(session.id))
    print(state.url, state.title)
    client.sessions.destroy(str(session.id))
```

## Quickstart (async)

```python
import asyncio
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key="ds_live_…") as client:
        s = await client.sessions.create()
        await client.sessions.navigate(str(s.id), {"url": "https://example.com/"})
        await client.sessions.destroy(str(s.id))

asyncio.run(main())
```

## Resources

Every public API endpoint is a typed method on a resource accessor:

| Accessor                   | Methods                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sessions`          | `create`, `list`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `extract`, `search`, `login`, `destroy`                                                                                                                              |
| `client.agent_sessions`    | `create`, `get`, `list`, `iterate`, `message`, `get_capture`, `transcript`, `stop`, `close`, `set_mode`, `set_egress`, `send_input_event`, `takeover`, `handback`, `livekit_token`, `resume` (run AI tasks in a browser — see "Run an AI task" below) |
| `client.egress`            | `attach_to_session`, `get_session_proxy` (**capability-gated — 503/404 on every deployment today; no egress backend is wired**), `list_proxies`, `create_proxy`, `update_proxy`, `delete_proxy`, `test_proxy` (reusable proxy CRUD)                   |
| `client.profiles`          | `create`, `list`, `iterate`, `get`, `update`, `delete`, `clone`                                                                                                                                                                                       |
| `client.profile_snapshots` | `capture`, `list_for_profile`, `list`, `iterate`, `get`, `restore`, `delete` (immutable point-in-time copies)                                                                                                                                         |
| `client.recipes`           | `create`, `list`, `iterate`, `get`, `delete` (snapshot and manage an agent-session's intent_log; no execute method)                                                                                                                                   |
| `client.api_keys`          | `create`, `list`, `rotate`, `revoke`                                                                                                                                                                                                                  |
| `client.usage`             | `current_period`                                                                                                                                                                                                                                      |
| `client.webhooks`          | `create`, `list`, `get`, `delete`, `list_deliveries`, `iterate_deliveries`, `replay_delivery`                                                                                                                                                         |
| `client.team`              | `invite`, `list_members`, `list_invites`, `list_owners`, `accept_invite`, `remove_member`                                                                                                                                                             |
| `client.billing`           | `get_state`, `create_checkout_session`, `create_portal_session`                                                                                                                                                                                       |
| `client.crypto_orders`     | `quote`, `create_checkout`, `list`, `iterate`, `get`, `update_note`, `cancel`, `receipt` (crypto checkout orders)                                                                                                                                     |
| `client.auth`              | `signup`, `verify_email`, `login`, `refresh`, `logout`, `request_magic_link`, `consume_magic_link`, `request_password_reset`, `confirm_password_reset`                                                                                                |
| `client.mfa`               | `status`, `enroll`, `verify`, `disable`, `regenerate_recovery_codes` (TOTP MFA enrollment)                                                                                                                                                            |
| `client.account`           | `me` (full /v1/account/me with slug / region / avatar / mfa / teams)                                                                                                                                                                                  |
| `client.legal`             | `documents`, `required`, `accept` (legal-document catalog + acceptance)                                                                                                                                                                               |
| `client.audit_log`         | `list`, `iterate`, `export` (append-only account event ledger)                                                                                                                                                                                        |
| `client.email_preferences` | `list`, `set`, `opt_out`, `opt_in` (non-critical email opt-out toggles)                                                                                                                                                                               |

Inputs accept either a Pydantic model OR a plain `dict` (both serialize identically on the wire). `sessions`, `api_keys`, `usage`, `webhooks`, `team` and `archetypes` return typed Pydantic models; the other resources — `agent_sessions` included — return plain dicts that mirror the API's JSON.

```python
# Either of these works:
from driftstack._generated.models import CreateSessionRequest
client.sessions.create(CreateSessionRequest(label="ci"))
client.sessions.create({"label": "ci"})
```

## Error handling

Every server `application/problem+json` response is mapped to a typed exception. The base class is `DriftstackError`; subclasses cover the documented problem types.

```python
from driftstack import (
    AuthError,
    ConcurrencyLimitError,
    DriftstackError,
    QuotaExceededError,
    RateLimitError,
    ValidationError,
)

try:
    session = client.sessions.create()
except AuthError:
    ...                                    # 401 key problems (and 403 ForbiddenError, a subclass — catch it first)
except ConcurrencyLimitError as e:
    ...                                    # e.current_sessions / e.limit
except QuotaExceededError as e:
    ...                                    # e.current / e.limit / e.record_type
except RateLimitError as e:
    time.sleep(e.retry_after_seconds or 1)
except ValidationError as e:
    ...                                    # e.message has the server's detail
except DriftstackError as e:
    ...                                    # catch-all for anything else
```

The full hierarchy lives in `driftstack/errors.py`; the URI → exception mapping is in `PROBLEM_TYPE_TO_ERROR`.

## Retry

Default policy: 3 retries with exponential backoff and full jitter. Honours `Retry-After` from rate-limit responses. Customize via `RetryConfig`:

```python
from driftstack import Driftstack
from driftstack.retry import RetryConfig

client = Driftstack(
    api_key="ds_live_…",
    retry=RetryConfig(max_retries=5, initial_delay_ms=500, max_delay_ms=10_000),
)

# Disable entirely for predictable testing:
client = Driftstack(api_key="…", retry=RetryConfig(enabled=False))
```

Retryable errors by default: `TransportError` (network / timeout / parse), `RateLimitError`, and `InternalError` — the plain 500. Other typed errors (auth, validation, quota, concurrency) propagate immediately, and so do the other 5xx kinds such as `DriverError` (502), where retrying an idempotent call would not help. This is the same set the TypeScript and Go SDKs retry; `RetryConfig.retryable_errors` is the tuple the loop actually uses.

> **Idempotency on retried writes.** A `TransportError` can mean a request the server already processed but whose response was lost, so an automatically-retried create or charge can execute twice. Pass an `idempotency_key` on non-idempotent calls — e.g. `client.agent_sessions.create(body, idempotency_key="…")` — and the server dedupes the retry onto the first request (Stripe-pattern `(account_id, idempotency_key)` uniqueness).

For a streamed browser turn, pass
`client.agent_sessions.message(id, text, idempotency_key="…")` and reuse the
key only for an ambiguous retry of the exact same
session/message/approvals/BYOK request. A completed turn replays without
executing its browser actions again; changed or still-running turns fail closed.

A turn is never retried automatically. A refusal raised **before the turn did
any work** gives the key back, so the **same** key runs the turn once the cause
is gone: a 409 `turn_in_progress`, a 429, a 402, a 403 about the plan's AI or
the model (`requires_own_key`), and a 502 whose `key_rejected` is false. So does
a `ConflictError` whose `idempotency_status` is `"in_progress"` — the first
attempt is still being resolved. Every other answer is final for its key:
a completed turn, a failure after the turn started, a rejected own key
(`key_rejected`), a 500, a `"refuse"` result, and the 409 for a closed or
paused session. Those need a **new** key.

## Run an AI task

```python
import uuid

session = client.agent_sessions.create({"mode": "ai"}, idempotency_key=str(uuid.uuid4()))
try:
    # Poll get(id) while session["status"] is "provisioning" before sending.
    resp = client.agent_sessions.message(
        session["id"],
        "Open https://example.com and tell me the main heading.",
        idempotency_key=str(uuid.uuid4()),
        on_step=lambda step: print(step["index"], step["result"]["kind"]),  # live progress
    )
    if resp["kind"] == "plan-executed":
        print(resp.get("answer"), resp.get("notice"))  # notice set = not finished yet
        paused = [r for r in resp["results"] if r["kind"] == "confirmation_required"]
        # To approve a purchase / payment / account deletion the agent stopped on,
        # send the next message with approve_consequential_actions=paused.
finally:
    client.agent_sessions.close(session["id"])
```

`on_event(name, data)` receives the other progress events (`phase`, `plan`,
`step_start`, `answer`, `notice`; ignore names you do not recognise); on
`AsyncDriftstack` both callbacks may be `async def`. `timeout_s=` bounds the
whole call (default 50 minutes). When you asked for information and none could
be produced, `resp.get("answer_unavailable")` says why.

When a turn ends before the task is finished, `resp["notice"]` is the sentence
to show a person and `resp.get("notice_reason")` is the one word to branch on:
`step_limit`, `time_limit`, `budget_low`, `no_progress`, `repeated_step`,
`ai_unavailable`, `question` or `declined` — or, from a newer server, a value
this SDK has never heard of, so show `notice` for anything you do not know.

A `capture` step's result carries a `captureId`; fetch the image as soon as the
turn ends, because screenshots are kept only briefly:

```python
for r in resp["results"]:
    if r["kind"] == "success" and "captureId" in r:
        shot = client.agent_sessions.get_capture(session["id"], r["captureId"])
        name = "shot.jpg" if shot["content_type"] == "image/jpeg" else "shot.png"
        with open(name, "wb") as f:
            f.write(shot["bytes"])
```

`transcript(id)` yields the conversation so far and then follows it live, so
leave the loop when you have what you need (that closes the connection). To
read only what is there now:

```python
length = client.agent_sessions.get(session["id"])["transcript_length"]
if length > 0:
    for event in client.agent_sessions.transcript(session["id"]):
        print(event["index"], event["entry"]["role"], event["entry"]["body"])
        if event["index"] == length - 1:
            break
```

Pass `last_event_id=` (the last `index` you saw) to carry on from there. On
`AsyncDriftstack` use `async for`.

AI refusals are typed: `ForbiddenError.requires_own_key` (an Opus model needs
your own Anthropic key), `ConflictError.turn_in_progress` / `.session_status` /
`.closed_reason`, `RateLimitError` (the message rate, or too many AI turns
running at once — wait `retry_after_seconds`, then send the same request
again, the same idempotency key and all),
`BundledLlmBudgetExhaustedError`, `BundledLlmConsentRequiredError` and
`ByokAnthropicRequiredError` (`.key_rejected`, `.key_source`,
`.key_rejected_reason` when Anthropic refused your own key). On `stop()`,
`FeatureUnavailableError.stop_unconfirmed` means the stop could not be
confirmed: call `stop()` again. See
[`examples/agent_chat.py`](examples/agent_chat.py) for the complete flow.

## Webhook signature verification

Stripe-style HMAC-SHA256 over `<unix_seconds>.<raw_body>`. Constant-time comparison via `hmac.compare_digest`. 5-minute default tolerance.

```python
from driftstack import verify_webhook_signature

@app.post("/driftstack-webhook")
def receive():
    raw = request.get_data()                   # framework-specific raw body
    ok = verify_webhook_signature(
        body=raw,
        header=request.headers.get("x-driftstack-signature"),
        secret=os.environ["DRIFTSTACK_WEBHOOK_SECRET"],
    )
    if not ok:
        return ("", 401)
    # ... process event ...
    return ("", 204)
```

A complete stdlib-only receiver lives in [`examples/webhook_receiver.py`](examples/webhook_receiver.py).

## Examples

- [`quickstart.py`](examples/quickstart.py) — minimal create/navigate/capture/destroy.
- [`agent_chat.py`](examples/agent_chat.py) — run an AI task: create, wait until ready, send a task with live progress, handle each result kind (answer, notice, approvals), close.
- [`profile_management.py`](examples/profile_management.py) — persistent profiles: create, update, clone, iterate, delete.
- [`pagination.py`](examples/pagination.py) — cursor pagination over list endpoints.
- [`billing_flow.py`](examples/billing_flow.py) — billing state, checkout session, portal session.
- [`crypto_checkout.py`](examples/crypto_checkout.py) — crypto checkout + order lifecycle (idempotency-key pattern).
- [`egress_flow.py`](examples/egress_flow.py) — per-session SOCKS5 proxy config.
- [`egress_openvpn.py`](examples/egress_openvpn.py) — OpenVPN egress variant.
- [`error_handling.py`](examples/error_handling.py) — granular catch + custom retry loop.
- [`webhook_receiver.py`](examples/webhook_receiver.py) — stdlib HTTP receiver with signature verify + dispatch.
- [`langchain_tool.py`](examples/langchain_tool.py) — LangChain `Tool` adapter for AI-agent QA pipelines.
- [`pytest_fixture.py`](examples/pytest_fixture.py) — drop-in `mock_driftstack` fixture for customer test suites.

## Configuration

```python
client = Driftstack(
    api_key="ds_live_…",          # required
    base_url="https://api.driftstack.dev",   # default; override for self-host or test
    timeout_s=30.0,               # per-request timeout
    retry=RetryConfig(...),       # see above
    http_client=httpx.Client(...) # advanced: BYO httpx.Client
)
```

The async client takes the same arguments; pass `httpx.AsyncClient(...)` instead of `httpx.Client(...)`.

## Development

```bash
# from packages/sdk-python/
python3.10 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
ruff check . && ruff format --check .
mypy src
```

Re-generate Pydantic models from a fresh OpenAPI spec:

```bash
# from the repo root
npm run sdk:python:dump-spec     # writes packages/sdk-python/openapi.json
npm run sdk:python:generate      # runs datamodel-codegen
```

Build the wheel:

```bash
# from packages/sdk-python/
python -m pip install build
python -m build       # → dist/driftstack-X.Y.Z-py3-none-any.whl + sdist
```

## License

MIT.
