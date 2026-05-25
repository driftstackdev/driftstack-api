"""Exponential-backoff retry policy with full jitter.

Mirrors `packages/sdk-typescript/src/retry.ts`. Honours `Retry-After`
when the server set one (the SDK's HTTP layer maps it onto the
RateLimitError before retry decides). Idempotent or read-shaped
methods are retried; mutating methods that lack server-side idempotency
keys are NOT retried by default — callers can opt in via the
``retry`` argument on the HTTP client.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TypeVar

from driftstack.errors import (
    DriftstackError,
    RateLimitError,
    TransportError,
)

T = TypeVar("T")


@dataclass
class RetryConfig:
    """Tuning knobs for the retry loop. Defaults match the TypeScript SDK."""

    max_retries: int = 3
    initial_delay_ms: int = 200
    max_delay_ms: int = 10_000
    backoff_multiplier: float = 2.0
    enabled: bool = True
    """If True, retry on TransportError + RateLimitError. If False, never retry."""
    retryable_errors: tuple[type[BaseException], ...] = field(
        default_factory=lambda: (TransportError, RateLimitError)
    )
    """Errors that ARE retryable when retries are enabled."""


def _backoff_delay_ms(attempt: int, cfg: RetryConfig, retry_after_seconds: int | None) -> int:
    """Compute the next sleep with full jitter; cap at ``max_delay_ms``.

    If the server set a ``Retry-After`` (rate-limit case), it wins —
    we never retry sooner than the server asks. Otherwise it's
    exponential-backoff with full jitter (random uniform between 0
    and the next exponential value).
    """
    if retry_after_seconds is not None:
        return min(retry_after_seconds * 1000, cfg.max_delay_ms)
    capped = min(cfg.initial_delay_ms * (cfg.backoff_multiplier**attempt), cfg.max_delay_ms)
    return int(random.uniform(0, capped))


def with_retry(fn: Callable[[], T], cfg: RetryConfig | None = None) -> T:
    """Run ``fn`` with retries per ``cfg``. Synchronous variant."""
    config = cfg or RetryConfig()
    if not config.enabled:
        return fn()

    attempt = 0
    while True:
        try:
            return fn()
        except config.retryable_errors as err:
            if attempt >= config.max_retries:
                raise
            retry_after = err.retry_after_seconds if isinstance(err, RateLimitError) else None
            time.sleep(_backoff_delay_ms(attempt, config, retry_after) / 1000)
            attempt += 1
        except DriftstackError:
            # Non-retryable typed error — propagate immediately.
            raise


async def with_retry_async(
    fn: Callable[[], _Awaitable[T]],
    cfg: RetryConfig | None = None,
) -> T:
    """Run an async ``fn`` with retries. Mirrors :func:`with_retry`."""
    import asyncio

    config = cfg or RetryConfig()
    if not config.enabled:
        return await fn()

    attempt = 0
    while True:
        try:
            return await fn()
        except config.retryable_errors as err:
            if attempt >= config.max_retries:
                raise
            retry_after = err.retry_after_seconds if isinstance(err, RateLimitError) else None
            await asyncio.sleep(_backoff_delay_ms(attempt, config, retry_after) / 1000)
            attempt += 1
        except DriftstackError:
            raise


# Forward-declare for the async type hint above.
from collections.abc import Awaitable as _Awaitable  # noqa: E402
