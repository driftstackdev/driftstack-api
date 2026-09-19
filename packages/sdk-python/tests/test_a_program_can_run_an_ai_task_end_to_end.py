"""A program can run an AI task end to end with the Python SDK.

Create a session (with its own Anthropic key when it has one), send a task,
watch it progress, read the answer and why it stopped, approve an action the
agent paused on, and tell the AI-specific refusals apart. Every arm drives the
real client through respx, so the wire shape and the typed error mapping are
both exercised, on the sync and the async client.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack.errors import ConflictError, ForbiddenError, TransportError

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"
SSE_HEADERS = {"content-type": "text/event-stream; charset=utf-8"}
MESSAGE_PATH = "/v1/agent-sessions/agt_1/message"

SESSION = {
    "id": "agt_1",
    "account_id": "acc_1",
    "driftstack_session_id": None,
    "status": "active",
    "closed_reason": None,
    "token_budget_total": 100_000,
    "token_budget_remaining": 99_000,
    "transcript_length": 2,
    "closed_at": None,
    "created_by_user_id": None,
    "mode": "ai",
    "created_at": "2026-09-19T00:00:00Z",
    "updated_at": "2026-09-19T00:00:00Z",
}

STEP_RESULT = {
    "kind": "success",
    "intent": {"kind": "navigate", "url": "https://example.com"},
    "summary": "Opened example.com",
}
NOTICE = "I did the steps above, but this was taking too long for one message."
FINAL = {
    "kind": "plan-executed",
    "session": SESSION,
    "intents": [STEP_RESULT["intent"]],
    "results": [STEP_RESULT],
    "ok": True,
    "answer": "Example Domain",
    "notice": NOTICE,
}


def frame(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def terminal(status: int, body: Any) -> str:
    return frame("response", {"status": status, "body": body})


PROGRESS_STREAM = "".join(
    [
        ": stream open\n\n",
        frame("phase", {"phase": "planning"}),
        frame("plan", {"total": 1, "intents": [STEP_RESULT["intent"]], "labels": ["Open"]}),
        frame("step_start", {"index": 0, "total": 1, "label": "Open"}),
        frame("step", {"index": 0, "result": STEP_RESULT}),
        "event: phase\ndata: {not json\n\n",
        frame("a_future_event", {"anything": True}),
        frame("answer", {"answer": "Example Domain"}),
        frame("notice", {"notice": NOTICE}),
        terminal(200, FINAL),
    ]
)

EXPECTED_ORDER = [
    "phase",
    "plan",
    "step_start",
    "step:0:success",
    "a_future_event",
    "answer",
    "notice",
]


def chunked(text: str, size: int) -> Iterator[bytes]:
    """Split a stream at arbitrary byte offsets, mid-frame included."""
    raw = text.encode()
    for i in range(0, len(raw), size):
        yield raw[i : i + size]


async def achunked(text: str, size: int) -> AsyncIterator[bytes]:
    for chunk in chunked(text, size):
        yield chunk


def problem(status: int, type_: str, **ext: Any) -> dict[str, Any]:
    return {
        "type": f"https://errors.driftstack.dev/{type_}",
        "title": type_,
        "status": status,
        **ext,
    }


def sse(body_text: str) -> httpx.Response:
    return httpx.Response(200, headers=SSE_HEADERS, text=body_text)


# ── create ────────────────────────────────────────────────────────────────


def test_create_sends_your_anthropic_key_beside_the_idempotency_key() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(return_value=httpx.Response(201, json=SESSION))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.create(
                {"mode": "ai", "model": "claude-opus-5", "skip_proxy_probe": True},
                idempotency_key="create-1",
                byok_api_key="sk-ant-test",
            )
        request = route.calls.last.request
        assert request.headers["x-byok-anthropic-api-key"] == "sk-ant-test"
        assert request.headers["idempotency-key"] == "create-1"
        assert json.loads(request.content) == {
            "mode": "ai",
            "model": "claude-opus-5",
            "skip_proxy_probe": True,
        }


def test_create_omits_the_key_header_when_the_key_is_empty_or_absent() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(return_value=httpx.Response(201, json=SESSION))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.create({}, byok_api_key="")
            client.agent_sessions.create({})
        for call in route.calls:
            assert "x-byok-anthropic-api-key" not in call.request.headers


@pytest.mark.asyncio
async def test_async_create_sends_your_anthropic_key() -> None:
    async with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(return_value=httpx.Response(201, json=SESSION))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.agent_sessions.create({}, byok_api_key="sk-ant-test")
        assert route.calls.last.request.headers["x-byok-anthropic-api-key"] == "sk-ant-test"


# ── live progress ─────────────────────────────────────────────────────────


def test_sync_message_reports_progress_in_stream_order_and_returns_answer_and_notice() -> None:
    seen: list[str] = []

    def on_step(step: dict[str, Any]) -> None:
        seen.append(f"step:{step['index']}:{step['result']['kind']}")

    def on_event(name: str, data: Any) -> None:
        seen.append(name)

    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(
            return_value=httpx.Response(
                200, headers=SSE_HEADERS, content=chunked(PROGRESS_STREAM, 17)
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.message(
                "agt_1",
                "Open example.com and tell me the heading",
                on_step=on_step,
                on_event=on_event,
            )

    # The malformed `phase` frame is skipped; the unknown name still arrives.
    assert seen == EXPECTED_ORDER
    assert out["kind"] == "plan-executed"
    assert out["answer"] == "Example Domain"
    assert out["notice"] == NOTICE


@pytest.mark.asyncio
async def test_async_message_awaits_async_callbacks_and_accepts_plain_ones() -> None:
    seen: list[str] = []

    async def on_step(step: dict[str, Any]) -> None:
        seen.append(f"step:{step['index']}:{step['result']['kind']}")

    def on_event(name: str, data: Any) -> None:
        seen.append(name)

    async with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(
            return_value=httpx.Response(
                200, headers=SSE_HEADERS, content=achunked(PROGRESS_STREAM, 23)
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.message(
                "agt_1", "go", on_step=on_step, on_event=on_event
            )

    assert seen == EXPECTED_ORDER
    assert out["answer"] == "Example Domain"


def test_without_callbacks_the_same_stream_still_returns_the_final_result() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(PROGRESS_STREAM))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.message("agt_1", "go")
    assert out == FINAL


def test_a_callback_that_raises_stops_reading_and_the_exception_reaches_the_caller() -> None:
    class Boom(Exception):
        pass

    def on_step(step: dict[str, Any]) -> None:
        raise Boom

    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(PROGRESS_STREAM))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client, pytest.raises(Boom):
            client.agent_sessions.message("agt_1", "go", on_step=on_step)


def test_the_live_reader_keeps_the_single_terminal_rule() -> None:
    two_terminals = terminal(200, FINAL) + terminal(200, FINAL)
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(two_terminals))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="multiple terminal"):
                client.agent_sessions.message("agt_1", "go", on_event=lambda n, d: None)

    no_terminal = frame("phase", {"phase": "planning"})
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(no_terminal))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="without a terminal"):
                client.agent_sessions.message("agt_1", "go", on_event=lambda n, d: None)


def test_the_live_reader_keeps_the_byte_ceiling() -> None:
    def huge() -> Iterator[bytes]:
        yield b": stream open\n\n"
        for _ in range(9):
            yield b":" + b"x" * (1024 * 1024) + b"\n\n"

    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=huge())
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="byte limit"):
                client.agent_sessions.message("agt_1", "go", on_event=lambda n, d: None)


def endless_heartbeats() -> Iterator[bytes]:
    yield b": stream open\n\n"
    while True:
        yield b": heartbeat\n\n"


@pytest.mark.parametrize("with_callbacks", [False, True])
def test_timeout_s_bounds_the_whole_call(with_callbacks: bool) -> None:
    callbacks: dict[str, Any] = {"on_event": lambda n, d: None} if with_callbacks else {}
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=endless_heartbeats())
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="absolute timeout"):
                client.agent_sessions.message("agt_1", "go", timeout_s=0.05, **callbacks)


# ── approvals ─────────────────────────────────────────────────────────────


def test_a_confirmation_required_result_can_be_passed_straight_back_as_the_approval() -> None:
    paused = {
        "kind": "confirmation_required",
        "intent": {"kind": "interact", "action": "tap", "selector": "#pay"},
        "category": "payment",
        "matchedText": "Pay now",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(MESSAGE_PATH).mock(return_value=sse(terminal(200, FINAL)))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.message(
                "agt_1",
                "Pay the invoice",
                idempotency_key="turn-2",
                approve_consequential_actions=[
                    paused,
                    {"category": "purchase", "matched_text": "Buy"},
                ],
            )
        request = route.calls.last.request
        assert json.loads(request.content) == {
            "user_message": "Pay the invoice",
            "approve_consequential_actions": [
                {"category": "payment", "matched_text": "Pay now"},
                {"category": "purchase", "matched_text": "Buy"},
            ],
        }
        assert request.headers["idempotency-key"] == "turn-2"


def test_an_approval_without_its_text_is_refused_before_anything_is_sent() -> None:
    with respx.mock(base_url=BASE, assert_all_called=False) as mock:
        route = mock.post(MESSAGE_PATH).mock(return_value=sse(terminal(200, FINAL)))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ValueError, match="matched_text"):
                client.agent_sessions.message(
                    "agt_1", "go", approve_consequential_actions=[{"category": "payment"}]
                )
        assert not route.called


# ── typed refusals ────────────────────────────────────────────────────────


def test_another_turn_still_running_arrives_in_the_stream_as_turn_in_progress() -> None:
    body = problem(409, "conflict", turn_in_progress=True)
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(terminal(409, body)))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ConflictError) as excinfo:
                client.agent_sessions.message("agt_1", "go")
    assert excinfo.value.turn_in_progress is True
    assert excinfo.value.session_status is None


def test_a_turn_that_ended_the_session_carries_its_status_spend_and_partial_steps() -> None:
    body = problem(
        409,
        "conflict",
        session_status="closed",
        tokens_consumed=1234,
        usage={"decomposer_kind": "claude", "cost_usd_cents": 3},
        partial_results=[STEP_RESULT],
    )
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=sse(terminal(409, body)))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ConflictError) as excinfo:
                client.agent_sessions.message("agt_1", "go", on_event=lambda n, d: None)
    err = excinfo.value
    assert err.session_status == "closed"
    assert err.turn_in_progress is False
    assert err.tokens_consumed == 1234
    assert err.usage == {"decomposer_kind": "claude", "cost_usd_cents": 3}
    assert err.partial_results == [STEP_RESULT]


def test_an_opus_model_on_the_included_ai_is_a_forbidden_error_that_requires_your_own_key() -> None:
    body = problem(403, "forbidden", requires_own_key=True, model="claude-opus-5")
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions").mock(return_value=httpx.Response(403, json=body))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ForbiddenError) as excinfo:
                client.agent_sessions.create({"model": "claude-opus-5"})
    assert excinfo.value.requires_own_key is True
    assert excinfo.value.model == "claude-opus-5"


def test_control_an_ordinary_403_is_not_mistaken_for_the_own_key_refusal() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/agent-sessions/agt_1").mock(
            return_value=httpx.Response(403, json=problem(403, "forbidden"))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ForbiddenError) as excinfo:
                client.agent_sessions.get("agt_1")
    assert excinfo.value.requires_own_key is False
    assert excinfo.value.model is None


def test_idempotency_and_ai_control_conflicts_differ_and_malformed_fields_read_as_absent() -> None:
    in_progress = ConflictError("x", problem={"idempotency_status": "in_progress"})
    assert in_progress.idempotency_status == "in_progress"
    assert in_progress.ai_control_unavailable is False

    control = ConflictError(
        "x",
        problem={
            "ai_control_unavailable": True,
            "phase": "executing",
            "tokens_consumed": "12",
            "usage": "not a dict",
            "partial_results": {},
        },
    )
    assert control.ai_control_unavailable is True
    assert control.phase == "executing"
    assert control.tokens_consumed is None
    assert control.usage is None
    assert control.partial_results is None
