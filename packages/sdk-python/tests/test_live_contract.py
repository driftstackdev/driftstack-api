"""The published Python SDK, driven against a real running server.

Thirty-one test files in this package and twenty-two of them mock the
transport. Not one has ever opened a socket to the API this client wraps, so
every assertion here has been about what the SDK *sends* — never about whether
the server agrees.

That gap matters more for this SDK than for the TypeScript one, because this
client PARSES. Every resource method funnels its 2xx body through
``parse_model``, which runs pydantic validation and re-raises a mismatch as
``TransportError``. A server that returns a field this package's models do not
describe is therefore not a silent degradation here — it is an exception in the
customer's process, on a call that succeeded. Mocked tests cannot reach that
path at all: they feed the parser exactly the body the test author wrote.

Skipped unless ``DS_LIVE_BASE_URL`` and ``DS_LIVE_API_KEY`` are set, so
``pytest`` stays runnable on its own. The server-side harness in
``apps/server/tests/integration/sdk-python-against-the-real-server.test.ts``
starts a real app, sets both, and asserts these tests actually RAN rather than
skipped — a permanently-skipped test is the exact false green this file exists
to avoid.
"""

from __future__ import annotations

import os

import pytest

from driftstack import Driftstack
from driftstack.errors import AuthError

BASE_URL = os.environ.get("DS_LIVE_BASE_URL")
API_KEY = os.environ.get("DS_LIVE_API_KEY")

pytestmark = pytest.mark.skipif(
    not BASE_URL or not API_KEY,
    reason="needs DS_LIVE_BASE_URL + DS_LIVE_API_KEY pointing at a running server",
)


@pytest.fixture()
def client():
    with Driftstack(api_key=API_KEY or "", base_url=BASE_URL or "") as sdk:
        yield sdk


def test_authenticates_against_an_authed_route(client) -> None:
    """The SDK's own Authorization header is read by the real server.

    Asserted on an AUTHED route on purpose: ``/v1/archetypes`` is deliberately
    public, so it answers a bogus key too and would prove nothing here.
    """
    me = client.account.me()
    assert isinstance(me, dict)
    assert me.get("id"), "account.me() returns the caller's profile"


def test_archetype_catalog_parses_into_the_generated_model(client) -> None:
    """The strongest assertion available to this SDK.

    ``parse_model`` validates the real body against the generated model, so
    this fails if the server sends a shape the published package does not
    describe — the drift a mocked test is structurally unable to see.
    """
    catalog = client.archetypes.list()
    assert catalog.data, "the roster is non-empty"
    assert catalog.default_archetype_id, "a default is named"
    assert all(a.id for a in catalog.data), "every entry carries an id"


def test_paginated_envelope_parses(client) -> None:
    page = client.sessions.list()
    assert isinstance(page.data, list), "rows arrive under `data`"
    assert isinstance(page.has_more, bool)
    # Declared `str | None`; a server sending anything else fails validation.
    assert page.next_cursor is None or isinstance(page.next_cursor, str)


def test_a_rejected_key_raises_a_typed_auth_error(client) -> None:
    """A bad key must surface as the SDK's typed error, not a parse failure.

    The distinction is the whole contract: callers are told to catch
    ``AuthError``. If a 401 fell through as a raw parse error instead, every
    documented recovery path would miss it.
    """
    with Driftstack(api_key="ds_live_definitely_not_a_real_key", base_url=BASE_URL or "") as bad:
        with pytest.raises(AuthError):
            bad.account.me()
