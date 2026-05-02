# Driftstack Python SDK

Stealth iPhone Safari automation, called from Python. Sync (`Driftstack`) and async (`AsyncDriftstack`) clients in one package, sharing the same typed resources, error hierarchy, and retry policy.

> **Status:** alpha. The SDK is built, tested, and wheel-buildable, but **not yet published to PyPI** — gated on entity setup. Until then, install from a local checkout or a tagged commit.

## Install

```bash
pip install driftstack
```

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

| Accessor          | Methods                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `client.sessions` | `create`, `list`, `get`, `navigate`, `interact`, `wait`, `get_state`, `capture`, `destroy` |
| `client.api_keys` | `create`, `list`, `revoke`                                                                 |
| `client.usage`    | `current_period`                                                                           |
| `client.webhooks` | `create`, `list`, `get`, `delete`, `list_deliveries`                                       |

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

Retryable errors by default: `TransportError` (network / timeout / parse) + `RateLimitError`. Other typed errors (auth, validation, quota, concurrency) propagate immediately.

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
