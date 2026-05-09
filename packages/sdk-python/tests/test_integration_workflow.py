"""End-to-end workflow tests through the SDK.

These exercise multi-call sequences (subscribe → create → navigate →
capture → destroy) through respx, asserting the full chain decodes
correctly. They aren't real-wire integration tests against a running
Fastify — that would require a node test-server in the loop, which
isn't trivially CI-friendly. The respx-driven workflow tests catch
the same class of "type drift between server and SDK" issue at the
Pydantic validation boundary, which is the actual surface customers
care about.

A real-wire integration suite is queued for PY4 once we have a small
node script that boots the e2e helpers/server.ts and exposes
``DRIFTSTACK_TEST_SERVER_URL`` for pytest to pick up.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack, RateLimitError, ValidationError
from driftstack._generated.models import CaptureResponse, NavigateResponse
from driftstack.retry import RetryConfig

API_KEY = "ds_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


def _session_fixture(session_id: str = "ses_00000000-0000-4000-8000-000000000001") -> dict:
    return {
        "id": session_id,
        "account_id": "acc_00000000-0000-4000-8000-000000000001",
        "api_key_id": "key_00000000-0000-4000-8000-000000000001",
        "status": "ready",
        "archetype": "iphone16pro_ios18_7_safari26_4",
        "purpose": "production_customer",
        "label": "ci",
        "metadata": None,
        "created_at": "2026-05-02T10:00:00Z",
        "updated_at": "2026-05-02T10:00:00Z",
        "last_state_at": None,
        "destroyed_at": None,
    }


def _navigate_fixture(url: str = "https://example.com/") -> dict:
    return {"url": url, "status": 200, "final_url": url, "duration_ms": 100}


def _capture_fixture() -> dict:
    return {
        "kind": "screenshot",
        "data": "iVBORw0KGgo=",
        "encoding": "base64",
        "byte_size": 100,
        "duration_ms": 50,
    }


def test_customer_journey_create_navigate_capture_destroy() -> None:
    """One-customer workflow exercised end-to-end through the typed surface."""
    session = _session_fixture()

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions").mock(return_value=httpx.Response(201, json=session))
        mock.post(f"/v1/sessions/{session['id']}/navigate").mock(
            return_value=httpx.Response(200, json=_navigate_fixture())
        )
        mock.post(f"/v1/sessions/{session['id']}/capture").mock(
            return_value=httpx.Response(200, json=_capture_fixture())
        )
        mock.delete(f"/v1/sessions/{session['id']}").mock(return_value=httpx.Response(204))

        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            s = client.sessions.create({"label": "ci"})
            nav = client.sessions.navigate(str(s.id), {"url": "https://example.com/"})
            assert isinstance(nav, NavigateResponse)
            assert nav.status == 200

            cap = client.sessions.capture(str(s.id), {"kind": "screenshot"})
            assert isinstance(cap, CaptureResponse)
            assert cap.byte_size == 100

            client.sessions.destroy(str(s.id))


def test_rate_limit_problem_surfaces_typed_with_retry_after() -> None:
    """A 429 response with the rate-limit problem-type maps to the right exception."""
    problem = {
        "type": "https://errors.driftstack.dev/rate-limited",
        "title": "Rate limited",
        "status": 429,
        "detail": "global bucket exhausted",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions").mock(
            return_value=httpx.Response(429, json=problem, headers={"retry-after": "7"})
        )
        # Disable retries — we want to observe the raised error, not have
        # the SDK silently retry it.
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=RetryConfig(enabled=False)) as client:
            with pytest.raises(RateLimitError) as exc:
                client.sessions.create()
            assert exc.value.retry_after_seconds == 7


def test_validation_problem_surfaces_typed() -> None:
    """A 400 response with a validation-failed problem-type maps to ValidationError."""
    problem = {
        "type": "https://errors.driftstack.dev/validation-failed",
        "title": "Validation failed",
        "status": 400,
        "detail": "events must contain at least one entry",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/webhooks").mock(return_value=httpx.Response(400, json=problem))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ValidationError) as exc:
                client.webhooks.create({"url": "https://customer.test/h", "events": []})
            assert "at least one entry" in exc.value.message


@pytest.mark.asyncio
async def test_async_customer_journey() -> None:
    """Same workflow, async path. Proves the async resources decode the same way."""
    session = _session_fixture()

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions").mock(return_value=httpx.Response(201, json=session))
        mock.post(f"/v1/sessions/{session['id']}/navigate").mock(
            return_value=httpx.Response(200, json=_navigate_fixture())
        )
        mock.delete(f"/v1/sessions/{session['id']}").mock(return_value=httpx.Response(204))

        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            s = await client.sessions.create()
            nav = await client.sessions.navigate(str(s.id), {"url": "https://example.com/"})
            assert nav.status == 200
            await client.sessions.destroy(str(s.id))


def test_retry_recovers_after_transient_network_failure() -> None:
    """The SDK's default retry policy recovers from a transient network blip.

    Network errors map to TransportError, which is in the default
    retryable set. The SDK retries, the second attempt succeeds, the
    customer never sees the blip.
    """
    session = _session_fixture()

    with respx.mock(base_url=BASE) as mock:
        # First call raises a connection error; second succeeds.
        # respx routes pop side_effects FIFO.
        mock.post("/v1/sessions").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.Response(201, json=session),
            ]
        )
        # Tight retry so the test runs fast.
        retry = RetryConfig(max_retries=2, initial_delay_ms=1, max_delay_ms=2)
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=retry) as client:
            s = client.sessions.create()
            assert str(s.id) == session["id"]
