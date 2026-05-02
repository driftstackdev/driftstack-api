# Driftstack Python SDK

Stealth iPhone Safari automation, called from Python. Sync (`requests`/`httpx.Client`) and async (`asyncio`/`httpx.AsyncClient`) clients in one package.

> **Status:** alpha. The SDK is built and tested but not yet published to PyPI — gated on entity setup. `pyproject.toml.private` is `false` because the standard tooling will publish straight from `hatch build` once the gate clears.

## Install

```bash
pip install driftstack
```

Requires Python 3.10+.

## Quickstart (sync)

```python
from driftstack import Driftstack

with Driftstack(api_key="ds_live_…") as client:
    # PY2 lands the resource methods. The constructor + auth + transport
    # path is shipped in PY1 (V-023).
    pass
```

## Quickstart (async)

```python
import asyncio
from driftstack import AsyncDriftstack

async def main():
    async with AsyncDriftstack(api_key="ds_live_…") as client:
        pass

asyncio.run(main())
```

## Webhook signature verification

Already shipped in PY1 — customers can verify Driftstack webhook deliveries today regardless of whether the resource methods have landed:

```python
from driftstack import verify_webhook_signature

@app.post("/driftstack-webhook")
def receive():
    raw_body = request.get_data()  # Flask; framework-specific raw-body access
    ok = verify_webhook_signature(
        body=raw_body,
        header=request.headers.get("x-driftstack-signature"),
        secret=os.environ["DRIFTSTACK_WEBHOOK_SECRET"],
    )
    if not ok:
        return ("", 401)
    # ... process event ...
    return ("", 204)
```

## Errors

The SDK maps every server `application/problem+json` response onto a typed exception. The base class is `DriftstackError`; subclasses cover the documented problem types.

```python
from driftstack import RateLimitError, DriftstackError

try:
    client.sessions.create()  # PY2
except RateLimitError as e:
    time.sleep(e.retry_after_seconds or 1)
except DriftstackError as e:
    log.error("driftstack call failed: %s", e)
```

## Retry

Default policy: 3 retries with exponential backoff and full jitter. Honours `Retry-After` from rate-limit responses. Customize via `RetryConfig`:

```python
from driftstack import Driftstack
from driftstack.retry import RetryConfig

client = Driftstack(
    api_key="ds_live_…",
    retry=RetryConfig(max_retries=5, initial_delay_ms=500),
)
```

## Development

```bash
cd packages/sdk-python
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

Re-generate Pydantic models from a fresh OpenAPI spec:

```bash
# from the repo root
npm run sdk:python:dump-spec       # writes packages/sdk-python/openapi.json
npm run sdk:python:generate         # runs datamodel-codegen
```
