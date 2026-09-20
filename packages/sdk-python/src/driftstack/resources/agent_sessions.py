"""Typed access to /v1/agent-sessions and its control subresources.

An agent session is a browser that the AI drives for you: create one, send it a
task with :meth:`AgentSessionsResource.message`, read the outcome, and close it.

Availability depends on the deployment's agent-runtime configuration.
Unsupported deployments return typed ``FeatureUnavailable`` errors.

Discriminated message response: branch on ``["kind"]`` —
``plan-executed`` (carries ``intents`` + ``results`` + ``ok``, and ``answer`` or
``answer_unavailable``, and ``notice``, when present), ``clarify``
(``clarifying_question``), ``refuse``
(``refuse_reason``), or ``stopped`` (the turn was stopped with ``stop()``:
``results`` are the steps that ran and ``notice`` says how far it got). A
``manual``-mode session answers ``logged-manual``.
"""

from __future__ import annotations

import builtins
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from typing import Any, Literal, TypedDict
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, EventCallback, HttpClient, StepCallback
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body


def _encode_query(query: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        items.append((key, str(value)))
    return urlencode(items)


def _approval_payload(
    approvals: Sequence[Mapping[str, Any]],
) -> builtins.list[dict[str, Any]]:
    """Map approvals to the wire's ``{"category", "matched_text"}`` shape.

    Each entry may be ``{"category": ..., "matched_text": ...}`` or a
    ``confirmation_required`` step result as the API returned it (which spells
    the text ``matchedText``), so a result can be passed straight back.
    """
    payload: builtins.list[dict[str, Any]] = []
    for approval in approvals:
        category = approval.get("category")
        matched = approval.get("matched_text", approval.get("matchedText"))
        if not isinstance(category, str) or not isinstance(matched, str):
            raise ValueError(
                "each approval needs a 'category' and a 'matched_text' "
                "(or the 'matchedText' of a confirmation_required result)"
            )
        payload.append({"category": category, "matched_text": matched})
    return payload


def _message_request(
    user_message: str,
    byok_api_key: str | None,
    idempotency_key: str | None,
    approve_consequential_actions: Sequence[Mapping[str, Any]] | None,
) -> tuple[dict[str, Any], dict[str, str] | None]:
    """Body and extra headers for one message turn (shared by sync and async)."""
    # Skip the header when byok_api_key is None OR empty. Empty
    # would send `x-byok-anthropic-api-key:` on the wire — the
    # server normalises that to absent, but skipping
    # client-side saves the round-trip header and matches the Go
    # SDK's `opts.ByokAPIKey != ""` shape.
    extra_headers: dict[str, str] = {}
    if byok_api_key:
        extra_headers["x-byok-anthropic-api-key"] = byok_api_key
    if idempotency_key is not None:
        extra_headers["Idempotency-Key"] = idempotency_key
    body: dict[str, Any] = {"user_message": user_message}
    # Re-send approved consequential actions so the steps the previous turn
    # paused on can continue. Omitted when empty (matches the route's optional
    # schema).
    if approve_consequential_actions:
        body["approve_consequential_actions"] = _approval_payload(approve_consequential_actions)
    return body, extra_headers or None


def _create_headers(idempotency_key: str | None, byok_api_key: str | None) -> dict[str, str] | None:
    headers: dict[str, str] = {}
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    if byok_api_key:
        headers["x-byok-anthropic-api-key"] = byok_api_key
    return headers or None


# Canonical modifier vocabulary for input events, mirrored from the API's
# CANONICAL_MODIFIER_NAMES. Customers building their own input-event producer
# should reference these constants instead of hard-coding string literals.
CANONICAL_MODIFIER_NAMES: tuple[str, ...] = ("cmd", "ctrl", "shift", "option")
CanonicalModifier = Literal["cmd", "ctrl", "shift", "option"]


class LiveKitInfo(TypedDict):
    """Live-video join info (5 fields).

    Returned by :meth:`AgentSessionsResource.livekit_token` and also
    auto-populated on the ``livekit`` field of an agent-session create
    response when live video is available at create time. The 5 fields match
    the named ``LiveKitInfo`` component schema in openapi.json.

    Hand-defined here (not generated) because the same 5-field shape is
    used as a typed return across all three SDKs (TS ``LiveKitInfo``
    interface + Go ``LiveKitInfo`` struct + this Python TypedDict) and
    the codegen step can lag behind. The OpenAPI schema is the contract
    source; this class is the Python projection of that contract.
    """

    ws_url: str
    """WebSocket URL the client connects to."""

    room: str
    """Room name — always the agent_session id."""

    token: str
    """Short-lived JWT that admits this viewer to the room."""

    participant_identity: str
    """Identity claim baked into the JWT — ``customer-<account-uuid>``."""

    expires_at: str
    """ISO-8601 timestamp at which the token expires."""


class AgentCapture(TypedDict):
    """A screenshot fetched with :meth:`AgentSessionsResource.get_capture`."""

    content_type: str
    """``"image/png"`` or ``"image/jpeg"`` — which one this screenshot is."""

    bytes: bytes
    """The image itself. Write it to a file as-is."""


class AgentTranscriptEvent(TypedDict):
    """One item yielded by :meth:`AgentSessionsResource.transcript`."""

    index: int
    """The entry's 0-based position in the conversation. Pass the last one you
    saw as ``last_event_id`` to carry on from there."""

    entry: dict[str, Any]
    """``{"role": "user" | "agent" | "operator", "body": str, "at": str,
    "intents"?: [...]}``. ``body`` is always plain text, never JSON; ``intents``
    is present on an agent entry whose plan ran, with sensitive typed values
    withheld. Entries can carry other fields too; ignore any you do not
    recognise."""


def _transcript_headers(last_event_id: int | None) -> dict[str, str] | None:
    # `is not None`, not truthiness: 0 is an index, and "resume after entry 0"
    # is not the same request as "replay from the beginning".
    if last_event_id is None:
        return None
    return {"Last-Event-ID": str(last_event_id)}


def _transcript_event(name: str, data: Any) -> AgentTranscriptEvent | None:
    """A ``transcript.entry`` frame as an event; anything else is skipped.

    The set of event names is open, so a name this SDK does not know is never an
    error.
    """
    if name != "transcript.entry" or not isinstance(data, dict):
        return None
    index = data.get("index")
    entry = data.get("entry")
    if isinstance(index, bool) or not isinstance(index, int) or not isinstance(entry, dict):
        return None
    return {"index": index, "entry": entry}


class AgentSessionsResource:
    """Synchronous AI-chat agent-sessions resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new agent session.

        Body shape (all fields optional): ``{"mode"?: "ai"|"manual"|"pair",
        "model"?: "claude-opus-5"|"claude-sonnet-5"|"claude-opus-4-8"
        |"claude-opus-4-7"|"claude-sonnet-4-6"|"claude-haiku-4-5",
        "token_budget"?: int, "profile_id"?: str, "proxy_id"?: str,
        "skip_proxy_probe"?: bool, "stop_on_exit_ip_change"?: bool,
        "continue_from_agent_session_id"?: str, "initial_url"?: str,
        "geolocation"?: {"latitude": float, "longitude": float,
        "accuracy"?: float}, "driftstack_session_id"?: str}``.

        ``mode`` defaults to ``"ai"`` (the AI plans and runs each message);
        ``"manual"`` records messages for a person driving the browser;
        ``"pair"`` lets a person take over from the AI.
        ``model`` picks the Claude model the AI runs; defaults server-side to
        ``"claude-sonnet-5"`` (every earlier id stays accepted). Opus models run
        only on your own Anthropic key: when the session would run on
        Driftstack's included AI they are refused with a 403
        :class:`~driftstack.errors.ForbiddenError` whose ``requires_own_key`` is
        true. ``token_budget`` is the tokens the AI may spend over the whole
        session (default 100,000; at most 10,000,000); when it runs out the
        session closes with ``closed_reason`` ``"budget-exhausted"``.
        ``profile_id`` attaches a saved profile (persistent browser identity) so
        the session resumes its stored state + saves back on end; must be an
        owned profile id (unknown or not-owned → 404), and a profile can have
        one live session at a time (409 ``ProfileInUseError`` otherwise).
        ``proxy_id`` routes the session through one of your account proxies
        (manage them at ``/v1/account/me/proxies``); must be an owned proxy id
        (unknown or not-owned → 404). The proxy is tested before launch (422
        ``ProxyValidationFailedError`` when it fails); ``skip_proxy_probe``
        skips that test for this launch only. ``stop_on_exit_ip_change`` ends
        the session if its exit IP changes mid-run (``closed_reason``
        ``"exit_ip_changed"``). ``continue_from_agent_session_id`` carries a
        CLOSED session's conversation into the new one (unknown or not owned →
        404; not closed yet → 409). ``initial_url`` sets a start page (an
        absolute http(s) URL — ``file:``, ``javascript:``, ``data:`` schemes are
        rejected with 400); for an AI task, also put the URL in your message.
        ``geolocation`` explicitly overrides the device's reported location; by
        default it derives from the proxy exit IP (coherent with the session's
        apparent network location), so omit it for most sessions — coordinates
        diverging from the exit country make the fingerprint internally
        inconsistent. Latitude -90..90, longitude -180..180, ``accuracy`` in
        meters (omit for the device default).

        While the returned session's ``status`` is ``"provisioning"`` its
        browser is still starting: poll :meth:`get` until it reads ``"active"``
        before sending a message (``"closed"`` means it could not start — read
        ``closed_reason``).

        ``idempotency_key`` (optional) is forwarded as the
        ``Idempotency-Key`` request header — Stripe-pattern dedupe. The
        server enforces ``(account_id, idempotency_key)`` uniqueness via
        a partial unique index; retries with the same key replay the
        original 201 response instead of minting a duplicate row.

        ``byok_api_key`` (optional) is your own Anthropic API key, sent as the
        ``x-byok-anthropic-api-key`` header. Create uses it only to decide
        whether an Opus model is allowed; send it on every :meth:`message` too.
        NEVER logged by the SDK.

        Errors: 429 ``ConcurrencyLimitError`` (your plan's concurrent-session
        limit), 409 ``ProfileInUseError`` / ``StorageQuotaExceededError``, 422
        ``ProxyValidationFailedError``, 403 ``ForbiddenError`` (no AI on the
        plan, or an Opus model without your own key), 404 ``NotFoundError``.
        """
        return self._http.request(
            "POST",
            "/v1/agent-sessions",
            json_body=coerce_body(body or {}),
            extra_headers=_create_headers(idempotency_key, byok_api_key),
        )

    def get(self, agent_session_id: str) -> dict[str, Any]:
        """Read agent session state."""
        return self._http.request("GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """List the account's agent sessions, newest first. Cursor-paginated.

        Returns the standard ``{"data": [...], "has_more": bool,
        "next_cursor": str | None}`` envelope. Pass ``cursor`` (the prior page's
        ``next_cursor``) to page, or use :meth:`iterate` to walk every page.
        Mirrors the TS + Go SDK list().
        """
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/agent-sessions" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Lazily walk every agent session across cursor pages (newest first)."""

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
        approve_consequential_actions: Sequence[Mapping[str, Any]] | None = None,
        on_step: StepCallback | None = None,
        on_event: EventCallback | None = None,
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        """Send one message — a task or a question — and wait for the outcome.

        The call streams, so it can take several minutes; it returns when the
        turn ends. The result is a dict keyed by ``kind``:

        - ``plan-executed`` — the steps ran. ``answer`` is what you asked for,
          when you asked for information, and ``answer_unavailable`` says why
          there is none when one could not be produced (never both); ``intents``
          is every step the turn attempted, across every plan it made;
          ``results`` has each step's outcome (``success``, ``failure`` with a
          ``diagnosis``, or ``confirmation_required``); ``notice``, when
          present, says why the task is not finished yet (send ``"continue"``
          when it asks for that). ``ok`` is true when the last planned steps ran
          cleanly — it does not by itself mean the task is finished.
        - ``clarify`` — the agent needs more detail; reply with another message.
        - ``refuse`` — the agent will not do this, or the AI was briefly
          unavailable (the session stays active; send it again).
        - ``stopped`` — you called :meth:`stop`.
        - ``logged-manual`` — a ``manual``-mode session recorded the message.

        ``byok_api_key`` (optional) is your own Anthropic API key, forwarded as
        the ``x-byok-anthropic-api-key`` request header so callers don't have to
        construct it by hand. It takes precedence over a stored key and over
        Driftstack's included AI. NEVER logged by the SDK.

        ``approve_consequential_actions`` (optional) approves the actions the
        previous turn stopped on (a ``confirmation_required`` step result: the
        agent paused before a purchase, a payment or an account deletion). Pass
        the ``confirmation_required`` results themselves, or
        ``{"category": ..., "matched_text": ...}`` dicts. Send it as the very
        next message on the session: the paused steps then continue from where
        they stopped, without planning again. Any other message in between
        discards the paused steps, and the agent plans afresh.

        ``idempotency_key`` (strongly recommended) identifies this logical
        turn. Reuse it after a lost/ambiguous stream so the server replays the
        durable terminal response instead of executing browser actions twice.
        A refusal raised BEFORE the turn did any work gives the key back, so
        the same key runs the turn once the cause is gone: a ``ConflictError``
        whose ``turn_in_progress`` is true, a ``RateLimitError`` (the message
        rate, or too many AI turns running at once),
        ``BundledLlmConsentRequiredError``, ``BundledLlmBudgetExhaustedError``,
        a ``ForbiddenError`` about the plan's AI or the model
        (``requires_own_key``), and a ``ByokAnthropicRequiredError`` whose
        ``key_rejected`` is false. Fix the cause or wait, then send the same
        request again with the SAME key. So is a ``ConflictError`` whose
        ``idempotency_status`` is ``"in_progress"``: the first attempt is still
        being resolved, and the same key replays its result.

        Every other answer is final for that key and sending it again replays
        it — every completed turn, every failure after the turn started, a
        rejected own key (``key_rejected``), a 500, a ``"refuse"`` result, and
        the 409 for a session that is closed or paused. To send one of those
        again, fix the cause and use a NEW key. Use a new key too when the
        session, message or approvals change.

        ``on_step`` (optional) is called with each step as it lands:
        ``{"index": int, "result": {...}}``, where ``index`` is the step's
        position in the final ``results``. ``on_event`` (optional) is called as
        ``on_event(name, data)`` for every other progress event — today
        ``phase``, ``plan``, ``step_start``, ``answer`` and ``notice``. The set of
        names is open: ignore the ones you do not recognise. The final result is
        always the return value. If a callback raises, the exception propagates
        and the stream is closed; the turn keeps running on the server (send the
        same message with the same ``idempotency_key`` to get its result).

        ``timeout_s`` (optional) is the absolute limit for the whole call;
        defaults to 50 minutes. It is not an idle timeout — the stream's
        keep-alives hold the connection open while a long step runs.

        Errors you should expect: 409 ``ConflictError`` (``turn_in_progress``:
        another message is still running; ``session_status``: the session is
        not active — ``"closed"``, with ``closed_reason`` saying why, so start
        a new one, or ``"paused"``), 429 ``RateLimitError`` (the message rate,
        or too many AI turns running at once: across your sessions, or on
        Driftstack's included AI — no step ran; wait ``retry_after_seconds``,
        then send the same request again, the same idempotency key and all;
        ``is_retryable`` is true),
        403 ``ForbiddenError`` (no AI on the plan, or ``requires_own_key``),
        402 ``BundledLlmBudgetExhaustedError`` /
        ``BundledLlmConsentRequiredError`` (the included AI's budget is used up,
        or the account has not opted in), and 502
        ``ByokAnthropicRequiredError``: the turn has no AI key (a plan that runs
        AI only on its own key is answered this way too), or Anthropic refused
        your key (``key_rejected``; ``key_source`` and ``key_rejected_reason``
        say which key and why). No step ran, and it is not retryable: fix the
        key first.
        """
        body, extra_headers = _message_request(
            user_message, byok_api_key, idempotency_key, approve_consequential_actions
        )
        return self._http.request_event_stream(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body(body),
            extra_headers=extra_headers,
            stream_timeout_s=timeout_s,
            on_step=on_step,
            on_event=on_event,
        )

    def get_capture(self, agent_session_id: str, capture_id: str) -> AgentCapture:
        """Fetch a screenshot the agent took.

        A ``capture`` step's result carries a ``captureId``; this returns the
        image behind it as ``{"content_type": "image/png" | "image/jpeg",
        "bytes": b"..."}``.

        Screenshots are kept only briefly — at most the 20 most recent per
        session, and they can be removed once 30 minutes pass without a new one
        in that session — so fetch one as soon as its turn ends.

        Raises ``NotFoundError`` (404) when the session is unknown, or no
        screenshot with this id is kept for it any more.
        """
        content, media_type = self._http.request_bytes(
            "GET",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
            f"/captures/{quote(capture_id, safe='')}",
        )
        return {"content_type": media_type, "bytes": content}

    def transcript(
        self,
        agent_session_id: str,
        *,
        last_event_id: int | None = None,
        timeout_s: float | None = None,
    ) -> Iterator[AgentTranscriptEvent]:
        """Read a session's conversation, then follow it live.

        Yields ``{"index": int, "entry": {...}}`` for every entry already in the
        transcript, oldest first, and then for each new entry as it is written —
        so the loop does not end by itself while the session is open. Leave the
        loop (``break``) to stop; that closes the connection. To close it at a
        precise point, wrap the call in ``contextlib.closing``.

        To read only what is there now, read ``transcript_length`` with
        :meth:`get` first and leave the loop at ``index == transcript_length -
        1`` (skip the call when it is 0).

        ``last_event_id`` resumes: pass the last ``index`` you saw and the
        stream starts with the entry after it, so nothing is repeated. The
        stream ends when the server closes it (your key lost access, or the
        connection was recycled); call again with ``last_event_id`` to carry on.

        ``timeout_s`` is the absolute limit on how long one call may stay open
        (default 50 minutes, the same as :meth:`message`); past it the call
        raises ``TransportError``. It is not an idle timeout.

        Entries are returned as the session recorded them: ``body`` is free
        text, and may contain whatever was sent to the agent. Treat the
        transcript as sensitive.

        Raises ``NotFoundError`` (404), and ``RateLimitError`` (429) when the
        account already has 10 transcript streams open (wait
        ``retry_after_seconds``).
        """
        frames = self._http.iter_event_frames(
            "GET",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/transcript",
            extra_headers=_transcript_headers(last_event_id),
            stream_timeout_s=timeout_s,
        )
        # Closed explicitly: the connection must go when THIS iterator is
        # closed, not whenever the inner one happens to be collected.
        try:
            for name, data in frames:
                event = _transcript_event(name, data)
                if event is not None:
                    yield event
        finally:
            frames.close()

    def close(self, agent_session_id: str) -> None:
        """End the agent session and its browser (idempotent).

        Close every session you start — an open session keeps counting toward
        your plan's concurrent-session limit.
        """
        self._http.request("DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    def set_mode(self, agent_session_id: str, mode: str) -> dict[str, Any]:
        """Set the session's mode.

        Transitioning INTO ``'pair'`` initializes ``pair_mode_state`` to
        ``{"kind": "ai-driving"}``; transitioning OUT clears it to ``None``.
        Idempotent — a no-op transition returns the existing row with
        ``pair_mode_state`` preserved.

        ``mode`` must be one of ``"manual"``, ``"ai"``, ``"pair"``.

        Raises ``ConflictError`` (409) if the session is not
        ``'active'`` (closed/paused sessions reject the transition).
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/mode",
            json_body=coerce_body({"mode": mode}),
        )

    def set_egress(
        self,
        agent_session_id: str,
        proxy_id: str,
        apply_point: str | None = None,
    ) -> dict[str, Any]:
        """Move a RUNNING session onto a different egress.

        NOT AVAILABLE YET: no device can change egress on a running
        session, so this currently returns ``{"status": "unavailable"}``
        for every call — create a new session with the ``proxy_id`` you
        want instead. The shapes are stable and will not change when
        device support lands.

        The page keeps its tabs, cookies and scroll position; only the
        exit changes.

        ``proxy_id`` must be a proxy on your own account that has been
        tested at least once. The swap carries the exit's MEASURED
        identity — IP, country, timezone — to the device so the page
        keeps seeing a consistent origin. An untested proxy has no
        measured identity to carry, and the response is
        ``status='unavailable'`` rather than a guessed one.

        ``apply_point`` defaults to ``'next_navigation'``, which swaps
        on the next page load and leaves connections in flight alone.
        ``'immediate'`` swaps at once and may reset connections
        mid-page.

        Read ``status`` before assuming anything moved: only ``'ok'``
        means the egress changed. On ``'ok'``, ``apply_point`` says
        WHEN — and ``None`` there means the device accepted the swap
        without confirming the timing, which should be treated as
        possibly-immediate.
        """
        body: dict[str, Any] = {"proxy_id": proxy_id}
        if apply_point is not None:
            body["apply_point"] = apply_point
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/egress",
            json_body=coerce_body(body),
        )

    def send_input_event(
        self,
        agent_session_id: str,
        event: dict[str, Any],
        *,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        """Send one raw input event to a manual or pair-mode session.

        ``event`` is one of the input-event variants, for example:

        - ``{"type": "mouseMove", "x": int, "y": int}``
        - ``{"type": "mouseDown", "x": int, "y": int, "button": 0|1|2}``
        - ``{"type": "mouseUp", "x": int, "y": int, "button": 0|1|2}``
        - ``{"type": "keyDown", "key": str, "modifiers": list[str] | None}``
        - ``{"type": "keyUp", "key": str, "modifiers": list[str] | None}``
        - ``{"type": "wheel", "x": int, "y": int, "deltaX": int, "deltaY": int}``
        - ``{"type": "ping", "timestamp": int}``

        Modifier vocabulary: ``keyDown`` / ``keyUp`` ``modifiers`` arrays MUST
        use the 4-name set ``"cmd" | "ctrl" | "shift" | "option"``.
        DOM-standard names (``Shift / Control / Alt / Meta``) pass validation
        but are ignored.

        ``client_id`` is REQUIRED when the session is in mode='pair'
        AND the current pair_mode_state.kind is ``ai-driving`` — the
        first input-event in this configuration asks for a takeover;
        ``client_id`` identifies which browser tab / window initiated.
        Optional in all other shapes.

        Response is a discriminated union — branch on ``["kind"]``:

        - ``pair-mode-takeover-fired`` (200) — ``pair_mode_state`` populated
          with the new state kind. LIVE today on any deployment. It forwards
          nothing, which is why "no deployment forwards input events" stays
          true alongside it.
        - ``forwarded`` — ``duration_ms`` populated.
          No deployment forwards input events, and this variant is
          UNREACHABLE: it sits behind the ``human-driving`` state, which no
          request can reach today.
          Branching on it is dead code.

        Raises ``ConflictError`` (409) if the session is not active OR
        is in mode='ai' (input-event requires manual or pair mode), OR
        the pair_mode_state is mid-transition.
        Raises ``ValidationError`` (400) when pair-mode ai-driving
        path is taken without ``client_id``.
        Raises ``FeatureUnavailableError`` (503) for everything else —
        mode='manual' always, and mode='pair' once the state has left
        ``ai-driving``. It is not a blanket 503 — the takeover-fired
        arm above returns 200.
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
        """Request a human takeover on a pair-mode session.

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
        """Request a handback to the AI on a pair-mode session.

        State machine: ``human-driving → handback-pending`` (or
        ``handback-queued`` if the runtime is mid-decompose). Today no request
        can move a session into ``human-driving``, so this raises the 409 below.

        Raises ``PairModeStateInvalidTransitionError`` (409) if the
        session is not in ``human-driving``.
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/handback",
            json_body=coerce_body({}),
        )

    def livekit_token(self, agent_session_id: str) -> LiveKitInfo:
        """Mint a fresh live-video token for the session's video room.

        Use this when the ``livekit`` field on the created session is absent,
        OR after the 24-hour token TTL expires. Returns the same 5-field shape
        that ``AgentSession.livekit`` carries:

            {
              "ws_url": "wss://…",
              "room": "agt_<uuid>",
              "token": "<JWT>",
              "participant_identity": "customer-<account-uuid>",
              "expires_at": "<RFC 3339>"
            }

        Errors (raised as typed Driftstack errors):

        - 403 — session is closed; cannot mint
        - 404 — session unknown (or cross-account; existence not leaked)
        - 503 — live video is not available for this session right now; try
          again later, or contact support if it persists
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
        """Resume a session that paused on a detected bot check.

        Call after you've resolved the challenge (e.g. in the live view). The
        session's ``status`` stays ``"active"`` while it is paused; the
        ``session.challenge_detected`` webhook tells you it happened. Pass
        ``challenge_id`` (from that webhook) to target a specific challenge;
        omit it for a manual override resume. Returns 202
        ``{"status": "resume_requested", "session_id": ...}``.

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

    def stop(self, agent_session_id: str) -> dict[str, Any]:
        """Stop the session's running turn.

        Returns as soon as the stop is requested; it does not wait for the turn
        to wind down. The turn ends on its own ``message()`` call, which returns
        ``{"kind": "stopped", ...}`` (or, if it was already finishing, its
        ordinary result) — that response is the signal that the session will
        accept the next message. Because ``message()`` blocks, call this from
        another thread or task. A step that was already running when the stop
        arrived is given a short, bounded time to finish so its result is known;
        nothing is started after it.

        Returns 202 ``{"status": "stop_requested", "session_id": ...}`` when a
        turn was running, 200 ``{"status": "no_turn_running", ...}`` when none
        was. Safe to call again. Raises ``NotFoundError`` (404) for an unknown
        session (or one owned by another account), and
        ``FeatureUnavailableError`` (503): when its ``stop_unconfirmed`` is
        true, the stop could not be confirmed just now and the turn may still
        be running — call ``stop()`` again. (``is_retryable`` is false for this
        class, because the same 503 without the flag means AI is not enabled
        and calling again would not help; the SDK does not retry ``stop()`` by
        itself.)
        """
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/stop",
            json_body={},
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
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same body, idempotency_key and byok_api_key semantics as sync."""
        return await self._http.request(
            "POST",
            "/v1/agent-sessions",
            json_body=coerce_body(body or {}),
            extra_headers=_create_headers(idempotency_key, byok_api_key),
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
        approve_consequential_actions: Sequence[Mapping[str, Any]] | None = None,
        on_step: StepCallback | None = None,
        on_event: EventCallback | None = None,
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        """Async counterpart to AgentSessionsResource.message.

        Same result, approvals, idempotency and error semantics as the sync
        method. ``on_step`` and ``on_event`` may be plain functions or ``async``
        functions; an awaitable they return is awaited before the next event is
        read. ``byok_api_key`` is forwarded as the ``x-byok-anthropic-api-key``
        header and NEVER logged by the SDK.
        """
        body, extra_headers = _message_request(
            user_message, byok_api_key, idempotency_key, approve_consequential_actions
        )
        return await self._http.request_event_stream(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body(body),
            extra_headers=extra_headers,
            stream_timeout_s=timeout_s,
            on_step=on_step,
            on_event=on_event,
        )

    async def get_capture(self, agent_session_id: str, capture_id: str) -> AgentCapture:
        """Async mirror of :meth:`AgentSessionsResource.get_capture` — same result and errors."""
        content, media_type = await self._http.request_bytes(
            "GET",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
            f"/captures/{quote(capture_id, safe='')}",
        )
        return {"content_type": media_type, "bytes": content}

    async def transcript(
        self,
        agent_session_id: str,
        *,
        last_event_id: int | None = None,
        timeout_s: float | None = None,
    ) -> AsyncIterator[AgentTranscriptEvent]:
        """Async mirror of :meth:`AgentSessionsResource.transcript`.

        Use it with ``async for``. Same events, resume, limits and errors as the
        sync method. Leaving the loop closes the connection once the iterator is
        collected; to close it at a precise point, wrap the call in
        ``contextlib.aclosing``.
        """
        frames = self._http.iter_event_frames(
            "GET",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/transcript",
            extra_headers=_transcript_headers(last_event_id),
            stream_timeout_s=timeout_s,
        )
        # Closed explicitly. Closing an async generator does not close one it
        # was iterating: without this the connection stays open until the inner
        # generator is collected, and an account may hold only 10 of them.
        try:
            async for name, data in frames:
                event = _transcript_event(name, data)
                if event is not None:
                    yield event
        finally:
            await frames.aclose()

    async def close(self, agent_session_id: str) -> None:
        await self._http.request("DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}")

    async def set_mode(self, agent_session_id: str, mode: str) -> dict[str, Any]:
        """Async mirror — same set-mode semantics as sync."""
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/mode",
            json_body=coerce_body({"mode": mode}),
        )

    async def set_egress(
        self,
        agent_session_id: str,
        proxy_id: str,
        apply_point: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same egress-swap semantics as sync."""
        body: dict[str, Any] = {"proxy_id": proxy_id}
        if apply_point is not None:
            body["apply_point"] = apply_point
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/egress",
            json_body=coerce_body(body),
        )

    async def send_input_event(
        self,
        agent_session_id: str,
        event: dict[str, Any],
        *,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        """Async mirror — same input-event semantics as sync."""
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
        """Async mirror — same semantics as sync.

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
        """Async mirror — same resume semantics as sync.

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

    async def stop(self, agent_session_id: str) -> dict[str, Any]:
        """Async mirror of :meth:`AgentSessionsResource.stop` — same semantics.

        Returns 202 ``{"status": "stop_requested", ...}`` or 200
        ``{"status": "no_turn_running", ...}``.
        """
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/stop",
            json_body={},
        )
