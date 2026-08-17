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


def _reachable_paths(obj: object, secret: str, seen: set[int] | None = None,
                     path: str = "err", depth: int = 0) -> list[str]:
    """Every attribute path from ``obj`` at which ``secret`` is reachable.

    The arms above check ``str()`` and ``repr()``. That is the wrong surface for
    this hazard: httpx attaches the full Request — headers included — to its
    transport exceptions, and the SDK chains those with ``raise ... from err``.
    The key was therefore reachable at
    ``err.__cause__.request.headers['authorization']`` while every string form
    stayed clean, so the existing tests passed with a live credential one
    attribute hop away.

    It matters for error reporters rather than logs: Sentry and similar capture
    exception chains and frame locals, so a transient connection failure could
    ship a customer's key to a third party.

    ``__cause__`` and ``__context__`` are walked explicitly — skipping
    dunders is what made the first version of this walk report "clean".
    """
    hits: list[str] = []
    if seen is None:
        seen = set()
    if depth > 8 or id(obj) in seen:
        return hits
    seen.add(id(obj))
    if isinstance(obj, str):
        return [path] if secret in obj else []
    if isinstance(obj, (bytes, bytearray)):
        return [f"{path} (bytes)"] if secret.encode() in obj else []
    if isinstance(obj, dict):
        for k, v in list(obj.items())[:80]:
            hits += _reachable_paths(v, secret, seen, f"{path}[{k!r}]", depth + 1)
        return hits
    if isinstance(obj, (list, tuple, set)):
        for i, v in enumerate(list(obj)[:80]):
            hits += _reachable_paths(v, secret, seen, f"{path}[{i}]", depth + 1)
        return hits
    for dunder in ("__cause__", "__context__"):
        nested = getattr(obj, dunder, None)
        if nested is not None:
            hits += _reachable_paths(nested, secret, seen, f"{path}.{dunder}", depth + 1)
    for attr in dir(obj):
        if attr.startswith("__"):
            continue
        try:
            value = getattr(obj, attr)
        except Exception:  # noqa: BLE001 - probing arbitrary objects
            continue
        if callable(value):
            continue
        hits += _reachable_paths(value, secret, seen, f"{path}.{attr}", depth + 1)
    return hits


def test_key_not_reachable_anywhere_on_a_transport_error() -> None:
    """Stronger than str()/repr(): the key must not be REACHABLE at all."""
    secret = "dsk_live_reachability_probe_9f3a"
    client = Driftstack(api_key=secret, base_url="http://127.0.0.1:9/unreachable")
    with pytest.raises(TransportError) as excinfo:
        client.sessions.list()
    paths = _reachable_paths(excinfo.value, secret)
    assert paths == [], f"api key reachable at: {paths}"


def test_the_reachability_walk_can_actually_find_a_key() -> None:
    """Without this, a walk that finds nothing anywhere would pass the arm above.

    Plants the secret behind a chained exception's attribute — the exact shape
    the httpx Request had — and requires the walk to see it.
    """
    secret = "dsk_live_reachability_probe_9f3a"

    class _Carrier:
        def __init__(self, value: str) -> None:
            self.headers = {"authorization": f"Bearer {value}"}

    inner = ValueError("inner")
    inner.request = _Carrier(secret)  # type: ignore[attr-defined]
    outer = TransportError("outer", status=0)
    outer.__cause__ = inner

    paths = _reachable_paths(outer, secret)
    assert paths, "the walk found nothing in an object that definitely carries the key"
