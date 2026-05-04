"""Pagination: walk every session, profile, and DLQ delivery using
the SDK's iterators.

V-126 added ``iterate()`` / ``iterate_deliveries()`` helpers on the
Sessions / Profiles / Webhooks resources for both the sync
``Driftstack`` client and the async ``AsyncDriftstack`` client. The
iterators handle cursor handoff automatically — consumer code reads
as a normal ``for`` / ``async for`` loop.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/pagination.py

Set ``DRIFTSTACK_BASE_URL`` if you're not hitting production
(``https://api.driftstack.dev``).
"""

from __future__ import annotations

import asyncio
import os
import sys

from driftstack import AsyncDriftstack, Driftstack


def list_all_sessions(client: Driftstack) -> None:
    """Sync iterator pattern."""
    print("\n— sessions (sync) —")
    count = 0
    for session in client.sessions.iterate(limit=50):
        count += 1
        if count <= 5:
            print(f"  {session.id}  {session.status}  {session.archetype}")
    print(f"  → {count} session(s) total")


def list_profiles(client: Driftstack) -> None:
    """Profiles still return raw dict (untyped pending codegen pass);
    the iterator handles both attribute-style + dict-style page
    shapes via duck typing.
    """
    print("\n— profiles (sync) —")
    names: list[str] = []
    for profile in client.profiles.iterate():
        # `profile` is a dict[str, Any] today.
        name = profile.get("name", "<unnamed>")
        names.append(name)
    if names:
        print(f"  → {', '.join(names)}")
    else:
        print("  → (none)")


def dlq_deliveries_for_first_webhook(client: Driftstack) -> None:
    """Filter through the iterator — `status='dlq'` threads through
    every page so you walk just the DLQ.
    """
    print("\n— webhook DLQ deliveries (sync) —")
    endpoints = client.webhooks.list()
    if not endpoints.data:
        print("  → no webhook endpoints configured; skipping delivery walk")
        return

    first = endpoints.data[0]
    print(f"  endpoint: {first.id}")

    dlq_count = 0
    for delivery in client.webhooks.iterate_deliveries(str(first.id), limit=100, status="dlq"):
        dlq_count += 1
        if dlq_count <= 3:
            print(f"  {delivery.id}  {delivery.event_type}  attempts={delivery.attempts}")
    print(f"  → {dlq_count} DLQ delivery/deliveries total")


async def list_all_sessions_async(aclient: AsyncDriftstack) -> None:
    """Async iterator pattern. Same shape, async generator."""
    print("\n— sessions (async) —")
    count = 0
    async for session in aclient.sessions.iterate(limit=50):
        count += 1
        if count <= 5:
            print(f"  {session.id}  {session.status}  {session.archetype}")
    print(f"  → {count} session(s) total (async)")


async def main_async(api_key: str, base_url: str) -> None:
    async with AsyncDriftstack(api_key=api_key, base_url=base_url) as aclient:
        await list_all_sessions_async(aclient)


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")

    with Driftstack(api_key=api_key, base_url=base_url) as client:
        list_all_sessions(client)
        list_profiles(client)
        dlq_deliveries_for_first_webhook(client)

    asyncio.run(main_async(api_key, base_url))
    return 0


if __name__ == "__main__":
    sys.exit(main())
