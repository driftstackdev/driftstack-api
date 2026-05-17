"""pytest fixture pattern — mock the Driftstack SDK in customer tests.

Drop the contents of ``mock_driftstack`` into your project's
``conftest.py`` (or any pytest fixture file). Tests can then depend
on the fixture and get a Driftstack client whose responses are
controlled by ``respx``.

Install the test deps::

    pip install pytest respx

Then in a customer test::

    def test_my_workflow(mock_driftstack):
        client, mock = mock_driftstack
        mock.post("/v1/sessions").mock(
            return_value=httpx.Response(201, json=SESSION_FIXTURE)
        )
        my_function_under_test(client)
        # ... assertions ...
"""

from __future__ import annotations

from collections.abc import Generator

import httpx
import pytest
import respx

from driftstack import Driftstack

_BASE = "https://api.driftstack.test"


@pytest.fixture
def mock_driftstack() -> Generator[tuple[Driftstack, respx.MockRouter], None, None]:
    """Yield ``(client, mock)`` — a Driftstack client + an active respx router."""
    with respx.mock(base_url=_BASE) as mock:
        with Driftstack(
            api_key="ds_test_fakefakefakefakefakefakefakefake", base_url=_BASE
        ) as client:
            yield client, mock


# Example assertion of how a customer test might use it.

SESSION_FIXTURE = {
    "id": "ses_00000000-0000-4000-8000-000000000001",
    "account_id": "acc_00000000-0000-4000-8000-000000000001",
    "api_key_id": "key_00000000-0000-4000-8000-000000000001",
    "status": "ready",
    "archetype": "iphone16pro_ios18_7_safari26_4",
    "label": None,
    "metadata": None,
    "egress_capabilities": None,
    "created_at": "2026-05-02T10:00:00Z",
    "updated_at": "2026-05-02T10:00:00Z",
    "last_state_at": None,
    "destroyed_at": None,
}


def example_test_using_the_fixture(
    mock_driftstack: tuple[Driftstack, respx.MockRouter],  # noqa: PT004 — intentional fixture-using example
) -> None:  # pragma: no cover — example, not a real pytest test
    client, mock = mock_driftstack
    mock.post("/v1/sessions").mock(return_value=httpx.Response(201, json=SESSION_FIXTURE))
    s = client.sessions.create({"label": "demo"})
    assert str(s.id).startswith("ses_")
