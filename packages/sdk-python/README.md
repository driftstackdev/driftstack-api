# Driftstack Python SDK

Stealth iPhone Safari automation, called from Python. Sync (`Driftstack`) and async (`AsyncDriftstack`) clients in one package, sharing the same typed resources, error hierarchy, and retry policy.

> **Status:** published on PyPI, pre-1.0, and classified Alpha. Use requirements constraints or a lockfile for reproducible deployments.

## Install

```bash
pip install driftstack-sdk
```

The distribution name is `driftstack-sdk`; the import name is `driftstack`. Pin a compatible release in your requirements or generated lockfile before production deployment.

Requires Python 3.10+.

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

| Accessor                   | Methods                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sessions`          | `create`, `list`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `extract`, `search`, `login`, `destroy`                                                                                                            |
| `client.agent_sessions`    | `create`, `get`, `message`, `close`, `set_mode`, `send_input_event`, `takeover`, `handback`, `livekit_token`, `resume` (AI chat — decompose + execute a task)                                                                       |
| `client.egress`            | `attach_to_session`, `get_session_proxy` (**capability-gated — 503/404 on every deployment today; no egress backend is wired**), `list_proxies`, `create_proxy`, `update_proxy`, `delete_proxy`, `test_proxy` (reusable proxy CRUD) |
| `client.profiles`          | `create`, `list`, `iterate`, `get`, `update`, `delete`, `clone` (V-313)                                                                                                                                                             |
| `client.profile_snapshots` | `capture`, `list_for_profile`, `list`, `iterate`, `get`, `restore`, `delete` (V-312 — immutable point-in-time copies)                                                                                                               |
| `client.recipes`           | `create`, `list`, `iterate`, `get`, `delete` (snapshot and manage an agent-session's intent_log; no execute method)                                                                                                                 |
| `client.api_keys`          | `create`, `list`, `rotate` (V-296), `revoke`                                                                                                                                                                                        |
| `client.usage`             | `current_period`                                                                                                                                                                                                                    |
| `client.webhooks`          | `create`, `list`, `get`, `delete`, `list_deliveries`, `iterate_deliveries`, `replay_delivery` (V-307)                                                                                                                               |
| `client.team`              | `invite`, `list_members`, `list_invites`, `list_owners`, `accept_invite`, `remove_member` (V-298)                                                                                                                                   |
| `client.billing`           | `get_state`, `create_checkout_session`, `create_portal_session`                                                                                                                                                                     |
| `client.crypto_orders`     | `quote`, `create_checkout`, `list`, `iterate`, `get`, `update_note`, `cancel`, `receipt` (V-666 — crypto checkout orders)                                                                                                           |
| `client.auth`              | `signup`, `verify_email`, `login`, `refresh`, `logout`, `request_magic_link`, `consume_magic_link`, `request_password_reset`, `confirm_password_reset`                                                                              |
| `client.mfa`               | `status`, `enroll`, `verify`, `disable`, `regenerate_recovery_codes` (V-353b — TOTP MFA enrollment)                                                                                                                                 |
| `client.account`           | `me` (V-385 — full /v1/account/me with slug / region / avatar / mfa / teams)                                                                                                                                                        |
| `client.legal`             | `documents`, `required`, `accept` (V-049 — legal-document catalog + acceptance)                                                                                                                                                     |
| `client.audit_log`         | `list`, `iterate`, `export` (V-216 — append-only account event ledger; V-462 export)                                                                                                                                                |
| `client.email_preferences` | `list`, `set`, `opt_out`, `opt_in` (V-204 — non-critical email opt-out toggles)                                                                                                                                                     |

Inputs accept either a Pydantic model OR a plain `dict` (both serialize identically on the wire). Outputs are typed Pydantic models — IDEs autocomplete every field.

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
    ...                                    # invalid / expired / revoked key
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
- [`agent_chat.py`](examples/agent_chat.py) — AI agent session: create, send a task message, poll status, close.
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
