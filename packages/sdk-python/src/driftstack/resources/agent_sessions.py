"""Typed access to /v1/agent-sessions and its control subresources.

Availability depends on the deployment's agent-runtime configuration.
Unsupported deployments return typed ``FeatureUnavailable`` errors.

Discriminated message response: branch on ``["kind"]`` —
``plan-executed`` (carries ``intents`` + ``results`` + ``ok``),
``clarify`` (``clarifying_question``), or ``refuse`` (``refuse_reason``).
"""

from __future__ import annotations

import builtins
from collections.abc import AsyncIterator, Iterator
from typing import Any, Literal, TypedDict
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body


def _encode_query(query: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        items.append((key, str(value)))
    return urlencode(items)


# Slice 6 cross-SDK lock 2026-05-20 — canonical modifier vocabulary
# mirrored from packages/api-types/src/agent-input-event.ts:
# CANONICAL_MODIFIER_NAMES. The 4 names map 1:1 onto Quartz
# CGEventFlags on the macOS harness side. Customers building their
# own input-event producer should reference these constants instead
# of hard-coding string literals.
CANONICAL_MODIFIER_NAMES: tuple[str, ...] = ("cmd", "ctrl", "shift", "option")
CanonicalModifier = Literal["cmd", "ctrl", "shift", "option"]


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
        "token_budget"?: int, "mode"?: "manual"|"ai"|"pair",
        "model"?: "claude-opus-4-8"|"claude-opus-4-7"|"claude-sonnet-4-6"|"claude-haiku-4-5",
        "profile_id"?: str, "proxy_id"?: str, "initial_url"?: str,
        "geolocation"?: {"latitude": float, "longitude": float,
        "accuracy"?: float}}``.
        ``model`` (6.c) picks the Claude 4.x model the AI agent runs;
        defaults server-side to ``"claude-opus-4-8"`` ("claude-opus-4-7" stays
        accepted for back-compat). ``profile_id`` attaches a
        saved profile (persistent browser identity) so the session resumes its
        stored state + saves back on end; must be an owned profile id (unknown
        or not-owned → 404). ``proxy_id`` routes the session through one of your
        account proxies (manage them at ``/v1/account/me/proxies``); must be an
        owned proxy id (unknown or not-owned → 404). ``initial_url`` sets the
        start URL the remote browser opens on launch (overrides the operator
        default); must be an absolute http(s) URL — ``file:``, ``javascript:``,
        ``data:`` schemes are rejected (400). ``geolocation`` explicitly
        overrides the device's reported location; by default it derives from
        the proxy exit IP (coherent with the session's apparent network
        location), so omit it for most sessions — coordinates diverging from
        the exit country make the fingerprint internally inconsistent.
        Latitude -90..90, longitude -180..180, ``accuracy`` in meters (omit
        for the device default).

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
        return self._http.request("GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """List the account's agent sessions, newest first. Cursor-paginated.

        Returns the standard ``{"data": [...], "has_more": bool,
        "next_cursor": str | None}`` envelope (was a non-paginated ``{"data"}``
        hard-capped at 100, leaving older sessions unreachable). Pass ``cursor``
        (the prior page's ``next_cursor``) to page, or use :meth:`iterate` to
        walk every page. Mirrors the TS + Go SDK list().
        """
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/agent-sessions" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Lazily walk every agent session across cursor pages (newest first).

        Replaces the old hard 100-cap — a busy account can now reach its full
        AI-session history.
        """

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            return self.list(limit=limit, cursor=cursor)

        return iterate_paginated(fetch_page)

    def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
        idempotency_key: str | None = None,
        approve_consequential_actions: builtins.list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Run one decompose→execute turn against the agent session.

        Returns a discriminated body keyed by ``kind``. Closed sessions
        return 409 Conflict — start a new session.

        ``byok_api_key`` (optional, BYOK Tier-3 LOCKED 2026-05-16) is
        forwarded as the ``x-byok-anthropic-api-key`` request header so
        callers don't have to construct it by hand. NEVER logged by
        the SDK; arrives over TLS to the control plane.

        ``idempotency_key`` (strongly recommended) identifies this logical
        turn. Reuse it after a lost/ambiguous stream so the server replays the
        durable terminal response instead of executing browser actions twice.
        Use a new key when the session, message, approvals, or BYOK key changes.
        """
        # Skip the header when byok_api_key is None OR empty. Empty
        # would send `x-byok-anthropic-api-key:` on the wire — the
        # server normalises that to absent (slice 105 fix), but skipping
        # client-side saves the round-trip header and matches the Go
        # SDK's `opts.ByokAPIKey != ""` shape.
        extra_headers: dict[str, str] = {}
        if byok_api_key:
            extra_headers["x-byok-anthropic-api-key"] = byok_api_key
        if idempotency_key is not None:
            extra_headers["Idempotency-Key"] = idempotency_key
        body: dict[str, Any] = {"user_message": user_message}
        # W443/W445 — re-send approved consequential actions (each
        # {"category", "matched_text"}) so the executor skips the confirmation
        # halt. Omitted when empty (matches the route's optional schema). Without
        # this, Python callers were permanently stuck on a confirmation turn.
        if approve_consequential_actions:
            body["approve_consequential_actions"] = [
                {"category": a["category"], "matched_text": a["matched_text"]}
                for a in approve_consequential_actions
            ]
        return self._http.request_event_stream(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body(body),
            extra_headers=extra_headers or None,
        )

    def close(self, agent_session_id: str) -> None:
        """Close the agent session (idempotent)."""
        self._http.request("DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    def set_mode(self, agent_session_id: str, mode: str) -> dict[str, Any]:
        """Slice 3 (Wave 29-NNN ARC 3) — set the session's operational mode.

        Atomic dual-column write of ``mode`` + ``pair_mode_state`` on
        the server. Transitioning INTO ``'pair'`` initializes
        ``pair_mode_state`` to ``{"kind": "ai-driving"}``; transitioning
        OUT clears it to ``None``. Idempotent — a no-op transition
        returns the existing row with ``pair_mode_state`` preserved.

        ``mode`` must be one of ``"manual"``, ``"ai"``, ``"pair"``.

        Raises ``ConflictError`` (409) if the session is not
        ``'active'`` (closed/paused sessions reject the transition).
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/mode",
            json_body=coerce_body({"mode": mode}),
        )

    def send_input_event(
        self,
        agent_session_id: str,
        event: dict[str, Any],
        *,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        """Slice 4 + Slice 5 (Wave 29-NNN ARC 3) — forward raw LK.6 InputEvent.

        ``event`` must be one of the 7 discriminated variants:

        - ``{"type": "mouseMove", "x": int, "y": int}``
        - ``{"type": "mouseDown", "x": int, "y": int, "button": 0|1|2}``
        - ``{"type": "mouseUp", "x": int, "y": int, "button": 0|1|2}``
        - ``{"type": "keyDown", "key": str, "modifiers": list[str] | None}``
        - ``{"type": "keyUp", "key": str, "modifiers": list[str] | None}``
        - ``{"type": "wheel", "x": int, "y": int, "deltaX": int, "deltaY": int}``
        - ``{"type": "ping", "timestamp": int}``

        Modifier vocabulary (Slice 6 cross-SDK lock 2026-05-20):
        ``keyDown`` / ``keyUp`` ``modifiers`` arrays MUST use the
        4-name set ``"cmd" | "ctrl" | "shift" | "option"`` (1:1 Quartz
        ``CGEventFlags``). DOM-standard names (``Shift / Control /
        Alt / Meta``) round-trip through the schema unchanged but the
        harness decoder drops them.

        ``client_id`` is REQUIRED when the session is in mode='pair'
        AND the current pair_mode_state.kind is ``ai-driving`` — the
        first input-event in this configuration fires the
        takeover-request transition (Slice 5); ``client_id``
        identifies which browser tab / window initiated. Optional
        in all other shapes.

        Response is a discriminated union — branch on ``["kind"]``:

        - ``pair-mode-takeover-fired`` (Slice 5 takeover-trigger) —
          ``pair_mode_state`` populated with the new state kind.
        - ``forwarded`` (Slice 4 forward-to-harness) — ``duration_ms``
          populated. No deployment forwards input events, so this
          variant is UNREACHABLE and every call returns 503.

        Raises ``ConflictError`` (409) if the session is not active OR
        is in mode='ai' (input-event requires manual or pair mode), OR
        the pair_mode_state is mid-transition.
        Raises ``ValidationError`` (400) when pair-mode ai-driving
        path is taken without ``client_id``.
        Raises ``FeatureUnavailableError`` (503) when input forwarding
        is unavailable on the selected deployment.
        """
        body: dict[str, Any] = {"event": event}
        if client_id is not None:
            body["client_id"] = client_id
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/input-event",
            json_body=coerce_body(body),
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

    def resume(
        self,
        agent_session_id: str,
        *,
        challenge_id: str | None = None,
    ) -> dict[str, Any]:
        """W474 — resume a session the harness auto-paused on a bot-challenge.

        Call after you've resolved the challenge (e.g. in the live view).
        Best-effort dispatch to the node running the session. Pass
        ``challenge_id`` (from the ``session.challenge_detected`` webhook) to
        target a specific active challenge; omit it for a manual override
        resume. Returns 202 ``{"status": "resume_requested", "session_id": ...}``.

        Raises ``NotFoundError`` (404) or ``ConflictError`` (409, session not
        active — terminal sessions can't be resumed).
        """
        body: dict[str, Any] = {}
        if challenge_id is not None:
            body["challenge_id"] = challenge_id
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/resume",
            json_body=coerce_body(body),
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

    async def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """Async counterpart to AgentSessionsResource.list. Cursor-paginated."""
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/agent-sessions" + (f"?{qs}" if qs else "")
        return await self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Async counterpart to AgentSessionsResource.iterate."""

        async def fetch_page(cursor: str | None) -> dict[str, Any]:
            return await self.list(limit=limit, cursor=cursor)

        return aiterate_paginated(fetch_page)

    async def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
        idempotency_key: str | None = None,
        approve_consequential_actions: builtins.list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Async counterpart to AgentSessionsResource.message.

        Returns a discriminated body keyed by ``kind``. Closed sessions
        return 409 Conflict — start a new session.

        ``byok_api_key`` (optional, BYOK Tier-3 LOCKED 2026-05-16) is
        forwarded as the ``x-byok-anthropic-api-key`` request header so
        callers don't have to construct it by hand. NEVER logged by
        the SDK; arrives over TLS to the control plane.

        ``idempotency_key`` has the same durable logical-turn retry semantics
        as the synchronous resource.
        """
        # Skip the header when byok_api_key is None OR empty. Empty
        # would send `x-byok-anthropic-api-key:` on the wire — the
        # server normalises that to absent (slice 105 fix), but skipping
        # client-side saves the round-trip header and matches the Go
        # SDK's `opts.ByokAPIKey != ""` shape.
        extra_headers: dict[str, str] = {}
        if byok_api_key:
            extra_headers["x-byok-anthropic-api-key"] = byok_api_key
        if idempotency_key is not None:
            extra_headers["Idempotency-Key"] = idempotency_key
        body: dict[str, Any] = {"user_message": user_message}
        # W443/W445 — re-send approved consequential actions (each
        # {"category", "matched_text"}) so the executor skips the confirmation
        # halt. Omitted when empty (matches the route's optional schema).
        if approve_consequential_actions:
            body["approve_consequential_actions"] = [
                {"category": a["category"], "matched_text": a["matched_text"]}
                for a in approve_consequential_actions
            ]
        return await self._http.request_event_stream(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body(body),
            extra_headers=extra_headers or None,
        )

    async def close(self, agent_session_id: str) -> None:
        await self._http.request("DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    async def set_mode(self, agent_session_id: str, mode: str) -> dict[str, Any]:
        """Async mirror — same Slice 3 set-mode semantics as sync."""
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/mode",
            json_body=coerce_body({"mode": mode}),
        )

    async def send_input_event(
        self,
        agent_session_id: str,
        event: dict[str, Any],
        *,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same Slice 4 + Slice 5 input-event semantics as sync."""
        body: dict[str, Any] = {"event": event}
        if client_id is not None:
            body["client_id"] = client_id
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/input-event",
            json_body=coerce_body(body),
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

    async def resume(
        self,
        agent_session_id: str,
        *,
        challenge_id: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same W474 resume semantics as sync.

        See :meth:`AgentSessionsResource.resume` for full semantics. Returns
        202 ``{"status": "resume_requested", "session_id": ...}``.
        """
        body: dict[str, Any] = {}
        if challenge_id is not None:
            body["challenge_id"] = challenge_id
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/resume",
            json_body=coerce_body(body),
        )
