"""An AI refusal carries what a program needs to react to it, as typed properties.

The API says which refusal this is in fields beside the sentence: why a closed
session ended, that a stop could not be confirmed, that the customer's own key
was the problem and how, how long to wait when too many AI turns are running. A
program should branch on those fields, never on the wording. Each arm sends the
answer the API gives through the real client, streamed the way ``message()``
receives it, and reads the property off the error class a program catches.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack._generated import models
from driftstack.errors import (
    ByokAnthropicRequiredError,
    ConcurrencyLimitError,
    ConflictError,
    FeatureUnavailableError,
    RateLimitError,
    is_retryable,
)

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"
SSE_HEADERS = {"content-type": "text/event-stream; charset=utf-8"}
MESSAGE_PATH = "/v1/agent-sessions/agt_1/message"
STOP_PATH = "/v1/agent-sessions/agt_1/stop"

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
    "model": "claude-sonnet-5",
    "stop_on_exit_ip_change": False,
    "pair_mode_state": None,
    "created_at": "2026-09-19T00:00:00Z",
    "updated_at": "2026-09-19T00:00:00Z",
}


def problem(status: int, type_: str, **ext: Any) -> dict[str, Any]:
    return {
        "type": f"https://errors.driftstack.dev/{type_}",
        "title": type_,
        "status": status,
        **ext,
    }


def streamed(status: int, body: Any) -> httpx.Response:
    """The one terminal frame a turn's stream ends with: ``{status, body}``."""
    payload = json.dumps({"status": status, "body": body}, separators=(",", ":"))
    return httpx.Response(200, headers=SSE_HEADERS, text=f"event: response\ndata: {payload}\n\n")


def refused(response: httpx.Response) -> tuple[Exception, int]:
    """Send one message and return what was raised, and how many requests it took."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(MESSAGE_PATH).mock(return_value=response)
        # Retries are ON (the default): "one request" is a fact about message().
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(Exception) as caught:  # noqa: PT011 - the class is asserted by callers
                client.agent_sessions.message("agt_1", "hello", idempotency_key="turn-1")
        return caught.value, route.call_count


def test_a_question_that_could_not_be_answered_says_why_and_carries_no_answer() -> None:
    why = "The page could not be read back, so there is no answer to give."
    step = {"kind": "navigate", "url": "https://example.test/"}
    body = {
        "kind": "plan-executed",
        "session": SESSION,
        "intents": [step],
        "results": [{"kind": "success", "intent": step, "summary": ""}],
        "ok": True,
        "answer_unavailable": why,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post(MESSAGE_PATH).mock(return_value=streamed(200, body))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            turn = client.agent_sessions.message("agt_1", "What is the total?")
    assert turn["answer_unavailable"] == why
    assert "answer" not in turn
    # And the published model a caller may validate a turn against declares it,
    # so validating does not drop the reason.
    parsed = models.AgentMessageResponse.model_validate(turn).root
    assert getattr(parsed, "answer_unavailable", None) == why


def test_a_closed_session_says_closed_and_why_so_no_second_call_is_needed() -> None:
    err, requests = refused(
        streamed(
            409,
            problem(409, "conflict", session_status="closed", closed_reason="budget-exhausted"),
        )
    )
    assert isinstance(err, ConflictError)
    assert err.session_status == "closed"
    assert err.closed_reason == "budget-exhausted"
    assert err.turn_in_progress is False
    assert is_retryable(err) is False
    assert requests == 1


def test_a_paused_session_has_no_closed_reason_and_a_busy_one_has_neither() -> None:
    paused, _ = refused(streamed(409, problem(409, "conflict", session_status="paused")))
    assert isinstance(paused, ConflictError)
    assert (paused.session_status, paused.closed_reason) == ("paused", None)

    busy, _ = refused(streamed(409, problem(409, "conflict", turn_in_progress=True)))
    assert isinstance(busy, ConflictError)
    assert busy.turn_in_progress is True
    assert (busy.session_status, busy.closed_reason) == (None, None)


def test_a_closed_reason_that_is_not_a_string_is_ignored() -> None:
    err, _ = refused(
        streamed(
            409, problem(409, "conflict", session_status="closed", closed_reason={"nested": True})
        )
    )
    assert isinstance(err, ConflictError)
    assert err.closed_reason is None


def test_too_many_ai_turns_running_is_a_rate_limit_error_worth_retrying_sent_once() -> None:
    err, requests = refused(
        streamed(
            429,
            problem(
                429,
                "rate-limited",
                detail="Your account already has 3 AI turns running on Driftstack’s "
                "included AI (limit 3). Wait for one to finish, then try again.",
                retry_after_seconds=5,
            ),
        )
    )
    assert isinstance(err, RateLimitError)
    assert not isinstance(err, ConcurrencyLimitError)
    # Read from the BODY: a stream has no Retry-After header left to carry it.
    assert err.retry_after_seconds == 5
    assert is_retryable(err) is True
    # "Retryable" is advice to the caller's loop. The SDK never resends a turn,
    # even with an Idempotency-Key on the request and retries enabled.
    assert requests == 1


def test_a_stop_that_could_not_be_confirmed_is_tellable_from_ai_not_being_enabled() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(STOP_PATH).mock(
            return_value=httpx.Response(
                503, json=problem(503, "feature-unavailable", stop_unconfirmed=True)
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(FeatureUnavailableError) as unconfirmed:
                client.agent_sessions.stop("agt_1")
        # stop() is a POST without a key: the SDK does not retry it by itself.
        assert route.call_count == 1
    assert unconfirmed.value.stop_unconfirmed is True

    with respx.mock(base_url=BASE) as mock:
        mock.post(STOP_PATH).mock(
            return_value=httpx.Response(503, json=problem(503, "feature-unavailable"))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(FeatureUnavailableError) as not_enabled:
                client.agent_sessions.stop("agt_1")
    assert not_enabled.value.stop_unconfirmed is False
    assert is_retryable(not_enabled.value) is False


def test_a_rejected_own_key_says_which_key_and_why_and_is_not_worth_retrying() -> None:
    key = "sk-ant-api03-this-must-never-come-back"
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(MESSAGE_PATH).mock(
            return_value=streamed(
                502,
                problem(
                    502,
                    "byok-anthropic-required",
                    detail="Anthropic rejected the API key sent with this request. "
                    "No step was run.",
                    key_rejected=True,
                    key_source="header",
                    key_rejected_reason="invalid_or_unauthorized",
                ),
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ByokAnthropicRequiredError) as caught:
                client.agent_sessions.message("agt_1", "hello", byok_api_key=key)
        assert route.call_count == 1
    err = caught.value
    assert err.status == 502
    assert (err.key_rejected, err.key_source, err.key_rejected_reason) == (
        True,
        "header",
        "invalid_or_unauthorized",
    )
    assert is_retryable(err) is False
    assert key not in str(err)
    assert key not in repr(err)
    assert key not in json.dumps(err.problem)


def test_billing_a_newer_reason_and_no_key_at_all_are_each_told_apart() -> None:
    billing, _ = refused(
        streamed(
            502,
            problem(
                502,
                "byok-anthropic-required",
                key_rejected=True,
                key_source="stored",
                key_rejected_reason="billing",
            ),
        )
    )
    assert isinstance(billing, ByokAnthropicRequiredError)
    assert (billing.key_source, billing.key_rejected_reason) == ("stored", "billing")

    newer_reason = "a_reason_added_after_this_sdk_was_released"
    newer_body = problem(
        502,
        "byok-anthropic-required",
        key_rejected=True,
        key_source="workspace",
        key_rejected_reason=newer_reason,
    )
    newer, _ = refused(streamed(502, newer_body))
    assert isinstance(newer, ByokAnthropicRequiredError)
    assert (newer.key_source, newer.key_rejected_reason) == ("workspace", newer_reason)
    # The generated model keeps a value newer than itself too, rather than
    # rejecting the whole problem.
    parsed = models.AgentAiKeyProblem.model_validate(newer_body)
    assert (parsed.key_source, parsed.key_rejected_reason) == ("workspace", newer_reason)

    no_key, _ = refused(streamed(502, problem(502, "byok-anthropic-required")))
    assert isinstance(no_key, ByokAnthropicRequiredError)
    assert (no_key.key_rejected, no_key.key_source, no_key.key_rejected_reason) == (
        False,
        None,
        None,
    )


@pytest.mark.asyncio
async def test_the_async_client_raises_the_same_classes_with_the_same_properties() -> None:
    async with respx.mock(base_url=BASE) as mock:
        route = mock.post(MESSAGE_PATH).mock(
            return_value=streamed(
                409,
                problem(409, "conflict", session_status="closed", closed_reason="customer-closed"),
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(ConflictError) as closed:
                await client.agent_sessions.message("agt_1", "hello", idempotency_key="k")
        assert route.call_count == 1
    assert (closed.value.session_status, closed.value.closed_reason) == (
        "closed",
        "customer-closed",
    )

    async with respx.mock(base_url=BASE) as mock:
        mock.post(STOP_PATH).mock(
            return_value=httpx.Response(
                503, json=problem(503, "feature-unavailable", stop_unconfirmed=True)
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(FeatureUnavailableError) as stop:
                await client.agent_sessions.stop("agt_1")
    assert stop.value.stop_unconfirmed is True
