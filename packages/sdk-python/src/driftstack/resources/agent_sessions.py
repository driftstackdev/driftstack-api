"""AgentSessions resource — /v1/agent-sessions/* (AI-D, planning 132 §"Phase 7").

Mirrors the TypeScript AgentSessionsResource (commit aadc3ffb). Server
registers the route surface as 503 ``FeatureUnavailable`` stubs until
the LLM key path is enabled on the deployment; SDK surface is stable so
consumers compile ahead of time.

Discriminated message response: branch on ``["kind"]`` —
``plan-executed`` (carries ``intents`` + ``results`` + ``ok``),
``clarify`` (``clarifying_question``), or ``refuse`` (``refuse_reason``).
"""

from __future__ import annotations

from typing import Any, TypedDict
from urllib.parse import quote

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class LiveKitInfo(TypedDict):
    """LK.3/LK.5 — 5-field LiveKit join info.

    Returned by :meth:`AgentSessionsResource.livekit_token` and also
    auto-populated on the ``livekit`` field of an agent-session create
    response when a Mac is available at create time. The 5 fields match
    the named ``LiveKitInfo`` component schema in openapi.json.

    Hand-defined here (not generated) because the same 5-field shape is
    used as a typed return across all three SDKs (TS ``LiveKitInfo``
    interface + Go ``LiveKitInfo`` struct + this Python TypedDict) and
    the codegen step can lag behind. The OpenAPI schema is the contract
    source; this class is the Python projection of that contract.
    """

    ws_url: str
    """WebSocket URL the client connects to (per-Mac unique hostname)."""

    room: str
    """LiveKit room name — always the agent_session id."""

    token: str
    """Short-lived HS256 JWT signed with the per-Mac api_secret."""

    participant_identity: str
    """Identity claim baked into the JWT — ``customer-<account-uuid>``."""

    expires_at: str
    """ISO-8601 timestamp at which the token expires."""


class AgentSessionsResource:
    """Synchronous AI-chat agent-sessions resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new agent chat session.

        Body shape (all fields optional): ``{"driftstack_session_id"?: ...,
        "token_budget"?: int}``.

        ``idempotency_key`` (optional, v2-#19) is forwarded as the
        ``Idempotency-Key`` request header — Stripe-pattern dedupe. The
        server enforces ``(account_id, idempotency_key)`` uniqueness via
        a partial unique index; retries with the same key replay the
        original 201 response instead of minting a duplicate row.
        """
        extra_headers = (
            {"Idempotency-Key": idempotency_key} if idempotency_key is not None else None
        )
        return self._http.request(
            "POST",
            "/v1/agent-sessions",
            json_body=coerce_body(body or {}),
            extra_headers=extra_headers,
        )

    def get(self, agent_session_id: str) -> dict[str, Any]:
        """Read agent session state."""
        return self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        """Run one decompose→execute turn against the agent session.

        Returns a discriminated body keyed by ``kind``. Closed sessions
        return 409 Conflict — start a new session.

        ``byok_api_key`` (optional, BYOK Tier-3 LOCKED 2026-05-16) is
        forwarded as the ``x-byok-anthropic-api-key`` request header so
        callers don't have to construct it by hand. NEVER logged by
        the SDK; arrives over TLS to the control plane.
        """
        # Skip the header when byok_api_key is None OR empty. Empty
        # would send `x-byok-anthropic-api-key:` on the wire — the
        # server normalises that to absent (slice 105 fix), but skipping
        # client-side saves the round-trip header and matches the Go
        # SDK's `opts.ByokAPIKey != ""` shape.
        extra_headers = (
            {"x-byok-anthropic-api-key": byok_api_key} if byok_api_key else None
        )
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body({"user_message": user_message}),
            extra_headers=extra_headers,
        )

    def close(self, agent_session_id: str) -> None:
        """Close the agent session (idempotent)."""
        self._http.request(
            "DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    def takeover(self, agent_session_id: str, client_id: str) -> dict[str, Any]:
        """Arc 2 sub-slice 8.9 (v2-#8) — request human takeover on a pair-mode session.

        State machine: ``ai-driving → takeover-pending`` (or
        ``takeover-queued`` if the runtime is mid-decompose). Returns
        ``{"pair_mode_state": {"kind": ...}}`` so the caller can branch
        on the queue discriminator without a separate GET round-trip.

        Raises ``PairModeStateInvalidTransitionError`` (409) if the
        session is not in a state that permits takeover. Raises
        ``ConflictError`` (409) if the session is not mode='pair'.
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/takeover",
            json_body=coerce_body({"client_id": client_id}),
        )

    def handback(self, agent_session_id: str) -> dict[str, Any]:
        """Arc 2 sub-slice 8.9 (v2-#8) — request handback to AI on a pair-mode session.

        State machine: ``human-driving → handback-pending`` (or
        ``handback-queued`` if the runtime is mid-decompose).

        Raises ``PairModeStateInvalidTransitionError`` (409) if the
        session is not in ``human-driving``.
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/handback",
            json_body=coerce_body({}),
        )

    def livekit_token(self, agent_session_id: str) -> LiveKitInfo:
        """LK.3 — mint a fresh LiveKit JWT for the session's video room.

        Use this when the auto-populated ``livekit`` field on
        session-create is absent (pre-LK deployment) OR after the 24-hour
        token TTL expires. Returns the same 5-field shape that
        ``AgentSession.livekit`` carries:

            {
              "ws_url": "wss://mac-NNN.driftstack.dev:8443",
              "room": "agt_<uuid>",
              "token": "<HS256 JWT>",
              "participant_identity": "customer-<account-uuid>",
              "expires_at": "<RFC 3339>"
            }

        Errors (raised as typed Driftstack errors):

        - 403 — session is closed; cannot mint
        - 404 — session unknown (or cross-account; existence not leaked)
        - 503 — no Mac in the fleet has registered LiveKit yet, OR the
          stored Mac secret can't be decrypted (operator action: re-run
          POST /v1/mac-nodes/register)
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/livekit-token",
        )


class AsyncAgentSessionsResource:
    """Async AI-chat agent-sessions resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(
        self,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same v2-#19 idempotency_key semantics as sync."""
        extra_headers = (
            {"Idempotency-Key": idempotency_key} if idempotency_key is not None else None
        )
        return await self._http.request(
            "POST",
            "/v1/agent-sessions",
            json_body=coerce_body(body or {}),
            extra_headers=extra_headers,
        )

    async def get(self, agent_session_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    async def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        """Async counterpart to AgentSessionsResource.message.

        Returns a discriminated body keyed by ``kind``. Closed sessions
        return 409 Conflict — start a new session.

        ``byok_api_key`` (optional, BYOK Tier-3 LOCKED 2026-05-16) is
        forwarded as the ``x-byok-anthropic-api-key`` request header so
        callers don't have to construct it by hand. NEVER logged by
        the SDK; arrives over TLS to the control plane.
        """
        # Skip the header when byok_api_key is None OR empty. Empty
        # would send `x-byok-anthropic-api-key:` on the wire — the
        # server normalises that to absent (slice 105 fix), but skipping
        # client-side saves the round-trip header and matches the Go
        # SDK's `opts.ByokAPIKey != ""` shape.
        extra_headers = (
            {"x-byok-anthropic-api-key": byok_api_key} if byok_api_key else None
        )
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body({"user_message": user_message}),
            extra_headers=extra_headers,
        )

    async def close(self, agent_session_id: str) -> None:
        await self._http.request(
            "DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    async def takeover(self, agent_session_id: str, client_id: str) -> dict[str, Any]:
        """Async mirror — same pair-mode takeover semantics as sync."""
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/takeover",
            json_body=coerce_body({"client_id": client_id}),
        )

    async def handback(self, agent_session_id: str) -> dict[str, Any]:
        """Async mirror — same pair-mode handback semantics as sync."""
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/handback",
            json_body=coerce_body({}),
        )

    async def livekit_token(self, agent_session_id: str) -> LiveKitInfo:
        """Async mirror — same LK.3 semantics as sync.

        Returns the 5-field :class:`LiveKitInfo` dict (ws_url + room +
        token + participant_identity + expires_at). See the sync
        :meth:`AgentSessionsResource.livekit_token` for full error
        semantics.
        """
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/livekit-token",
        )
