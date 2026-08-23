"""The published Python SDK, driven against a real running server.

Thirty-one test files in this package and twenty-two of them mock the
transport. Not one has ever opened a socket to the API this client wraps, so
every assertion here has been about what the SDK *sends* — never about whether
the server agrees.

Part of this SDK PARSES, and that part fails loudly: ``parse_model`` runs
pydantic validation and re-raises a mismatch as ``TransportError``, so a server
sending a shape the package's models do not describe raises in the customer's
process on a call that succeeded. Mocked tests cannot reach that path at all —
they feed the parser exactly the body the test author wrote.

But it is a minority of the surface, and this header used to claim otherwise.
Measured with ``ast`` over ``src/driftstack/resources``: 48 of 276 public
resource methods parse into a model. The other 228 return the decoded JSON as
``dict[str, Any]``, unvalidated — including ``account.me``, ``profiles.list``
and ``usage.series``, three of the endpoints exercised below. For those, drift
is exactly as silent as it is in the TypeScript client: the caller gets a dict
without the key it expected, and finds out at their own access site.

That is an argument for MORE assertions here rather than fewer. Where a method
parses, "no exception" is itself the assertion; where it does not, only an
explicit check on the field notices. The arms below say which kind they are.

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
from driftstack.errors import AuthError, FeatureUnavailableError

BASE_URL = os.environ.get("DS_LIVE_BASE_URL")
API_KEY = os.environ.get("DS_LIVE_API_KEY")

pytestmark = pytest.mark.skipif(
    not BASE_URL or not API_KEY,
    reason="needs DS_LIVE_BASE_URL + DS_LIVE_API_KEY pointing at a running server",
)


@pytest.fixture
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


def test_profiles_page_envelope(client) -> None:
    """UNVALIDATED path: ``profiles.list`` returns the raw dict.

    The listing customers reach for first, and its envelope is built in its own
    route rather than shared with sessions — so the arm above proves nothing
    about it. No model stands behind this one, which is why every key is
    asserted by hand: a server keying the rows under ``items`` would hand back a
    dict this SDK reports no error about at all.
    """
    page = client.profiles.list()
    assert isinstance(page, dict)
    assert isinstance(page.get("data"), list), "profile rows arrive under `data`"
    assert isinstance(page.get("has_more"), bool), "the envelope carries has_more"
    assert "next_cursor" in page, "the envelope carries a cursor field"


def test_usage_series_is_the_envelope_that_differs(client) -> None:
    """UNVALIDATED path, and the one response whose shape is not the others'.

    Every other listing here keys its rows under ``data``. This one uses
    ``buckets`` and carries ``from_date``/``to_date`` instead of a cursor, so it
    is the single endpoint where applying the pagination envelope would be
    wrong — and with no model behind it, nothing but this assertion would say so.
    """
    series = client.usage.series(days=7)
    assert isinstance(series, dict)
    assert isinstance(series.get("buckets"), list), "daily rows arrive under `buckets`"
    assert series.get("from_date"), "the window start is surfaced"
    assert series.get("to_date"), "the window end is surfaced"
    assert "has_more" not in series, "this endpoint is NOT the paginated envelope"


def test_webhook_endpoint_list_is_the_bare_envelope(client) -> None:
    """PARSED path, and the third envelope shape in this API.

    ``GET /v1/webhooks`` returns ``data`` and nothing else — no ``has_more``,
    no ``next_cursor``. Asserting their ABSENCE here would say nothing about the
    server: ``page`` is a parsed model, so it carries the fields the model
    declares whatever the body held, and the check would be true by
    construction. What this arm proves live is that ``data`` still maps at all —
    the model's own shape is what pins the rest.
    """
    page = client.webhooks.list()
    assert isinstance(page.data, list), "endpoints arrive under `data`"


def test_a_disabled_feature_raises_the_typed_error(client) -> None:
    """A deployment gate must surface as the documented class.

    This server registers the recipes disabled-stub, so the 503 and its problem
    type are real rather than a body a test author wrote. The mapping from
    ``https://errors.driftstack.dev/feature-unavailable`` onto the exported
    class is what makes the documented recovery path reachable; a caller on a
    deployment without recipes catches this class or catches nothing.
    """
    with pytest.raises(FeatureUnavailableError):
        client.recipes.list()


def test_a_write_round_trips_and_surfaces_the_one_time_plaintext(client) -> None:
    """PARSED path, and the only WRITE this file performs.

    Every other arm reads. A create the server accepts but the models cannot
    describe raises ``TransportError`` inside the customer's process on a call
    that succeeded — and for a create that is worse than for a read, because the
    key EXISTS by then and the plaintext is gone with the exception.

    ``plaintext`` is surfaced once and is not retrievable afterwards, so an SDK
    that dropped or renamed it hands back a key nobody can use and no retry
    recovers.
    """
    created = client.api_keys.create({"name": "py-live-write-probe", "scopes": ["read"]})
    assert created.id, "the created key has an id"
    assert isinstance(created.plaintext, str), "the one-time plaintext is surfaced"
    assert len(created.plaintext) > 20, "and it is a real key, not an empty string"

    listed = client.api_keys.list()
    assert any(k.id == created.id for k in listed.data), (
        "the key the SDK created is visible through the SDK that listed it"
    )


def test_a_rejected_key_raises_a_typed_auth_error(client) -> None:
    """A bad key must surface as the SDK's typed error, not a parse failure.

    The distinction is the whole contract: callers are told to catch
    ``AuthError``. If a 401 fell through as a raw parse error instead, every
    documented recovery path would miss it.
    """
    with Driftstack(api_key="ds_live_definitely_not_a_real_key", base_url=BASE_URL or "") as bad:
        with pytest.raises(AuthError):
            bad.account.me()
