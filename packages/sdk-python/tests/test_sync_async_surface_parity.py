"""The async client exposes exactly the surface the sync client does.

The Python SDK ships two clients, ``Driftstack`` and ``AsyncDriftstack``, and a
method added to one is trivially forgotten on the other. That failure is silent
for everyone on the sync client and total for everyone on the async one: the
attribute simply is not there, and nothing in the suite notices, because every
existing test drives whichever client it was written against.

Measured before this was written: 19 resources, identical method sets on both
sides, zero divergence. So this closes no live gap — it makes the next addition
a matched pair rather than a coin flip.

Introspects the real classes rather than scanning source text. A regex over the
resource files would pass on a method that is defined but never attached to the
client, which is the same "guards the expression, not the behaviour" trap that
source-text pins fall into elsewhere in this repo.
"""

from __future__ import annotations

import inspect

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


def _resources(client: object) -> dict[str, object]:
    """Public resource attributes hanging off a client instance."""
    return {
        name: value
        for name, value in vars(client).items()
        if not name.startswith("_") and hasattr(value, "__class__")
    }


def _public_methods(resource: object) -> set[str]:
    return {
        name
        for name, _ in inspect.getmembers(resource, predicate=callable)
        if not name.startswith("_")
    }


def test_scan_finds_a_real_surface() -> None:
    """Non-vacuity. An empty scan would make every check below trivially true,
    and the failure being guarded is itself an absence."""
    with Driftstack(api_key=API_KEY, base_url=BASE) as sync_client:
        resources = _resources(sync_client)
        assert len(resources) >= 15, f"expected the full resource surface, got {len(resources)}"
        assert "sessions" in resources
        assert len(_public_methods(resources["sessions"])) >= 5


def test_async_client_exposes_the_same_resources() -> None:
    """A resource present on one client and missing on the other is a whole
    feature that does not exist for half the userbase."""
    with Driftstack(api_key=API_KEY, base_url=BASE) as sync_client:
        sync_names = set(_resources(sync_client))
    async_client = AsyncDriftstack(api_key=API_KEY, base_url=BASE)
    async_names = set(_resources(async_client))

    assert sync_names == async_names, (
        "resource surfaces diverged — "
        f"sync-only={sorted(sync_names - async_names)} "
        f"async-only={sorted(async_names - sync_names)}"
    )


def test_each_resource_exposes_the_same_methods_on_both_clients() -> None:
    """The likelier divergence: the resource exists on both, but a method was
    added to one. Silent for sync users, an AttributeError for async ones."""
    with Driftstack(api_key=API_KEY, base_url=BASE) as sync_client:
        sync_resources = _resources(sync_client)
        async_resources = _resources(AsyncDriftstack(api_key=API_KEY, base_url=BASE))

        divergent: dict[str, tuple[list[str], list[str]]] = {}
        for name, sync_resource in sync_resources.items():
            async_resource = async_resources.get(name)
            if async_resource is None:
                continue  # covered by the resource-level test above
            sync_methods = _public_methods(sync_resource)
            async_methods = _public_methods(async_resource)
            if sync_methods != async_methods:
                divergent[name] = (
                    sorted(sync_methods - async_methods),
                    sorted(async_methods - sync_methods),
                )

        assert not divergent, f"method sets diverged per resource: {divergent}"


def test_async_methods_are_actually_awaitable() -> None:
    """Parity of NAMES is not parity of behaviour.

    An async resource whose methods are plain functions would satisfy every
    check above while handing async callers a value they cannot await.

    Paginator methods are the legitimate exception: ``iterate`` returns an
    ``AsyncIterator`` for ``async for``, so it is deliberately not a coroutine.
    The exemption is derived from the declared RETURN TYPE rather than from a
    name allowlist, so a new paginator is handled automatically while a method
    that ought to be awaitable and is not still fails. Hardcoding "iterate"
    would have quietly exempted the next one too.
    """
    async_resources = _resources(AsyncDriftstack(api_key=API_KEY, base_url=BASE))

    offenders: dict[str, list[str]] = {}
    for resource_name, resource in async_resources.items():
        bad = []
        for name in _public_methods(resource):
            method = getattr(resource, name)
            if inspect.iscoroutinefunction(method) or inspect.isasyncgenfunction(method):
                continue
            annotation = str(inspect.signature(method).return_annotation)
            if "AsyncIterator" in annotation or "AsyncIterable" in annotation:
                continue  # paginator: consumed with `async for`, not awaited
            bad.append(f"{name} -> {annotation}")
        if bad:
            offenders[resource_name] = sorted(bad)

    assert not offenders, f"async methods that can be neither awaited nor iterated: {offenders}"
