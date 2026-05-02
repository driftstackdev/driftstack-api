"""Resource accessors mounted on the top-level Driftstack clients.

Each module exposes two classes — a sync resource and an async one —
that share the same method signatures but back onto :class:`HttpClient`
or :class:`AsyncHttpClient` respectively.

Customers don't import these directly; they reach them through the
client::

    client = Driftstack(api_key="…")
    client.sessions.create()       # sync
    await async_client.sessions.create()   # async (separate client)
"""

from driftstack.resources.api_keys import ApiKeysResource, AsyncApiKeysResource
from driftstack.resources.sessions import AsyncSessionsResource, SessionsResource
from driftstack.resources.usage import AsyncUsageResource, UsageResource
from driftstack.resources.webhooks import AsyncWebhooksResource, WebhooksResource

__all__ = [
    "ApiKeysResource",
    "AsyncApiKeysResource",
    "SessionsResource",
    "AsyncSessionsResource",
    "UsageResource",
    "AsyncUsageResource",
    "WebhooksResource",
    "AsyncWebhooksResource",
]
