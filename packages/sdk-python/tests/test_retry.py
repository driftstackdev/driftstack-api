"""Retry policy unit tests.

Mostly sync — the async path (`with_retry_async`) shares the same
`_backoff_delay_ms` computation, so most cases only need sync coverage.
A couple of cases (e.g. negative Retry-After) get an explicit async
counterpart too: `time.sleep(-N)` and `asyncio.sleep(-N)` differ in
behaviour (the former raises, the latter silently no-ops), so a fix that
only touches the shared delay computation is worth locking in on both
call sites.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from driftstack.errors import (
    DriftstackError,
    InternalError,
    InvalidKeyError,
    RateLimitError,
    TransportError,
)
from driftstack.retry import RetryConfig, with_retry, with_retry_async


def test_returns_immediately_when_fn_succeeds() -> None:
    calls = {"n": 0}

    def fn() -> str:
        calls["n"] += 1
        return "ok"

    assert with_retry(fn) == "ok"
    assert calls["n"] == 1


def test_retries_on_transport_error_then_succeeds() -> None:
    attempts: list[int] = []

    def fn() -> str:
        attempts.append(len(attempts))
        if len(attempts) < 3:
            raise TransportError("blip", status=0)
        return "recovered"

    cfg = RetryConfig(max_retries=3, initial_delay_ms=1, backoff_multiplier=1.0, max_delay_ms=2)
    with patch("time.sleep"):  # don't actually wait in tests
        assert with_retry(fn, cfg) == "recovered"
    assert len(attempts) == 3


def test_retries_on_internal_error_then_succeeds() -> None:
    # 5xx (InternalError) MUST be retried, matching the TS SDK + is_retryable — the
    # default retryable_errors had omitted it (cross-SDK retry drift, audit we0i8bkgm).
    attempts: list[int] = []

    def fn() -> str:
        attempts.append(len(attempts))
        if len(attempts) < 3:
            raise InternalError("boom", status=500)
        return "recovered"

    cfg = RetryConfig(max_retries=3, initial_delay_ms=1, backoff_multiplier=1.0, max_delay_ms=2)
    with patch("time.sleep"):
        assert with_retry(fn, cfg) == "recovered"
    assert len(attempts) == 3


def test_gives_up_after_max_retries() -> None:
    def fn() -> None:
        raise TransportError("persistent", status=0)

    cfg = RetryConfig(max_retries=2, initial_delay_ms=1, max_delay_ms=2)
    with patch("time.sleep"), pytest.raises(TransportError):
        with_retry(fn, cfg)


def test_does_not_retry_non_retryable_error() -> None:
    """InvalidKeyError → AuthError → don't retry; surface immediately."""
    calls = {"n": 0}

    def fn() -> None:
        calls["n"] += 1
        raise InvalidKeyError("bad", status=401)

    with pytest.raises(InvalidKeyError):
        with_retry(fn)
    assert calls["n"] == 1


def test_does_not_retry_when_disabled() -> None:
    calls = {"n": 0}

    def fn() -> None:
        calls["n"] += 1
        raise TransportError("retryable but disabled", status=0)

    cfg = RetryConfig(enabled=False)
    with pytest.raises(TransportError):
        with_retry(fn, cfg)
    assert calls["n"] == 1


def test_rate_limit_honours_retry_after_header() -> None:
    """RateLimitError carries retry_after_seconds; the loop sleeps that long."""
    sleeps: list[float] = []

    def fn() -> str:
        if len(sleeps) == 0:
            raise RateLimitError("slow", retry_after_seconds=2, status=429)
        return "ok"

    def fake_sleep(secs: float) -> None:
        sleeps.append(secs)

    with patch("time.sleep", side_effect=fake_sleep):
        assert with_retry(fn, RetryConfig(max_retries=2)) == "ok"
    # The sleep was 2 seconds (per Retry-After), not exponential math.
    assert sleeps == [2.0]


def test_rate_limit_negative_retry_after_does_not_crash_sync_loop() -> None:
    """A malformed/negative Retry-After (bad server header, or a
    problem-body `retry_after_seconds` that slipped through negative)
    must be floored at 0, not passed straight to `time.sleep()` — a
    negative sleep duration raises `ValueError`, which would crash the
    retry loop with an unrelated error instead of just retrying sooner."""
    sleeps: list[float] = []

    def fn() -> str:
        if len(sleeps) == 0:
            raise RateLimitError("slow", retry_after_seconds=-5, status=429)
        return "ok"

    def fake_sleep(secs: float) -> None:
        sleeps.append(secs)

    with patch("time.sleep", side_effect=fake_sleep):
        assert with_retry(fn, RetryConfig(max_retries=2)) == "ok"
    # Never a negative sleep — `time.sleep(-N)` raises ValueError.
    #
    # The exact value is NOT pinned any more. A non-positive Retry-After
    # carries no information, so it falls through to the exponential path
    # (jittered, in [0, initial_delay_ms]) rather than being clamped to a bare
    # 0. Pinning 0.0 pinned a jitter-free immediate retry: every client answered
    # the same non-positive hint would wake in lockstep, which is the thundering
    # herd full jitter exists to prevent. sdk-typescript and sdk-go gate their
    # hint path on `> 0` for the same reason.
    assert len(sleeps) == 1
    assert sleeps[0] >= 0.0
    assert sleeps[0] <= RetryConfig().initial_delay_ms / 1000


@pytest.mark.asyncio
async def test_rate_limit_negative_retry_after_does_not_crash_async_loop() -> None:
    """Async mirror of the sync test above. Before the fix, negative
    `retry_after_seconds` silently no-op'd `asyncio.sleep()` instead of
    raising — this test locks in the SAME floor-at-0 behaviour on both
    paths (rather than one path masking the bug the other would crash on)."""
    sleeps: list[float] = []

    async def fn() -> str:
        if len(sleeps) == 0:
            raise RateLimitError("slow", retry_after_seconds=-5, status=429)
        return "ok"

    async def fake_sleep(secs: float) -> None:
        sleeps.append(secs)

    with patch("asyncio.sleep", side_effect=fake_sleep):
        assert await with_retry_async(fn, RetryConfig(max_retries=2)) == "ok"
    # Same contract as the sync path — non-negative, and bounded by the
    # exponential path's first step rather than pinned to a bare 0.
    assert len(sleeps) == 1
    assert sleeps[0] >= 0.0
    assert sleeps[0] <= RetryConfig().initial_delay_ms / 1000


def test_propagates_unexpected_exceptions_unchanged() -> None:
    """Non-Driftstack exceptions are not caught — they bubble up untouched."""

    class CustomError(Exception):
        pass

    def fn() -> None:
        raise CustomError("not ours")

    with pytest.raises(CustomError):
        with_retry(fn)


def test_does_not_swallow_driftstack_subclass_that_isnt_retryable() -> None:
    """A non-retryable DriftstackError raises with no retry attempts."""
    calls = {"n": 0}

    def fn() -> None:
        calls["n"] += 1
        raise DriftstackError("generic", status=400)

    cfg = RetryConfig(max_retries=5)
    with pytest.raises(DriftstackError):
        with_retry(fn, cfg)
    assert calls["n"] == 1
