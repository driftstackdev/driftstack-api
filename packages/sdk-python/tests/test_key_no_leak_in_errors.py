"""Security invariant: the API key must NEVER appear in a thrown error.

Errors are built from the response (problem body / status) or the
transport-failure message — never from the request, which carries
`authorization: Bearer <api_key>`. If a refactor ever stashed the request
or its headers on an error, the customer's key would leak into THEIR logs.
These guards both error paths (problem response + network failure) by
asserting the key string is absent from str() and repr() of the raised
exception and its cause chain.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import Driftstack
from driftstack.errors import NotFoundError, TransportError
from driftstack.retry import RetryConfig

SECRET = "ds_live_DO_NOT_LEAK_abcdefghijklmnop"
BASE = "https://api.test"


def _assert_no_key(exc: BaseException) -> None:
    cur: BaseException | None = exc
    depth = 0
    while cur is not None and depth < 6:
        assert SECRET not in str(cur), f"key leaked in str({type(cur).__name__})"
        assert SECRET not in repr(cur), f"key leaked in repr({type(cur).__name__})"
        cur = cur.__cause__ or cur.__context__
        depth += 1


def test_key_absent_from_problem_response_error() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/me").mock(
            return_value=httpx.Response(
                404,
                json={
                    "type": "https://errors.driftstack.dev/not-found",
                    "title": "Not Found",
                    "status": 404,
                },
            ),
        )
        with Driftstack(api_key=SECRET, base_url=BASE) as client:
            with pytest.raises(NotFoundError) as ei:
                client.account.me()
    _assert_no_key(ei.value)


def test_key_absent_from_network_failure_error() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/me").mock(side_effect=httpx.ConnectError("connection refused"))
        with Driftstack(api_key=SECRET, base_url=BASE, retry=RetryConfig(enabled=False)) as client:
            with pytest.raises(TransportError) as ei:
                client.account.me()
    _assert_no_key(ei.value)
