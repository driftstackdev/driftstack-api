"""Webhook signature verification round-trip + tampering tests."""

from __future__ import annotations

import hashlib
import hmac as _hmac
import time

import pytest

from driftstack import verify_webhook_signature


def _sign(body: bytes, secret: str, timestamp_seconds: int) -> str:
    payload = f"{timestamp_seconds}.".encode() + body
    sig = _hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return f"t={timestamp_seconds},v1={sig}"


def test_round_trip_accepts_valid_signature() -> None:
    body = b'{"id":"evt-1","type":"session.completed","data":{}}'
    secret = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    now = int(time.time())
    header = _sign(body, secret, now)

    assert (
        verify_webhook_signature(body=body, header=header, secret=secret, now_seconds=now) is True
    )


def test_rejects_tampered_body() -> None:
    body = b'{"id":"evt-1"}'
    secret = "whsec_xx"
    now = int(time.time())
    header = _sign(body, secret, now)

    assert (
        verify_webhook_signature(
            body=b'{"id":"evt-tampered"}',
            header=header,
            secret=secret,
            now_seconds=now,
        )
        is False
    )


def test_rejects_wrong_secret() -> None:
    body = b"hello"
    now = int(time.time())
    header = _sign(body, "whsec_correct", now)

    assert (
        verify_webhook_signature(body=body, header=header, secret="whsec_wrong", now_seconds=now)
        is False
    )


def test_rejects_old_timestamp_outside_tolerance() -> None:
    body = b"x"
    secret = "whsec_xx"
    long_ago = int(time.time()) - 600  # 10 minutes ago
    header = _sign(body, secret, long_ago)

    # Default tolerance 300s — 600s is over the limit.
    assert (
        verify_webhook_signature(body=body, header=header, secret=secret, now_seconds=time.time())
        is False
    )


def test_rejects_future_timestamp_outside_tolerance() -> None:
    body = b"x"
    secret = "whsec_xx"
    far_future = int(time.time()) + 600
    header = _sign(body, secret, far_future)

    assert (
        verify_webhook_signature(body=body, header=header, secret=secret, now_seconds=time.time())
        is False
    )


def test_accepts_str_body_and_bytes_body_equivalently() -> None:
    body_bytes = b'{"k":"v"}'
    body_str = '{"k":"v"}'
    secret = "whsec_xx"
    now = int(time.time())
    header = _sign(body_bytes, secret, now)

    assert (
        verify_webhook_signature(body=body_bytes, header=header, secret=secret, now_seconds=now)
        is True
    )
    assert (
        verify_webhook_signature(body=body_str, header=header, secret=secret, now_seconds=now)
        is True
    )


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "garbage",
        "t=abc,v1=zzz",  # timestamp not numeric → returns None from parser
        "v1=onlysig",  # missing t
        "t=123",  # missing v1
    ],
)
def test_rejects_malformed_header(header: str | None) -> None:
    assert (
        verify_webhook_signature(body=b"x", header=header, secret="whsec_xx", now_seconds=0)
        is False
    )


def test_field_order_independent() -> None:
    """Header parser handles v1 before t and vice versa."""
    body = b"x"
    secret = "whsec_xx"
    now = int(time.time())
    sig = _hmac.new(secret.encode(), f"{now}.".encode() + body, hashlib.sha256).hexdigest()

    forward = f"t={now},v1={sig}"
    reverse = f"v1={sig},t={now}"
    assert (
        verify_webhook_signature(body=body, header=forward, secret=secret, now_seconds=now) is True
    )
    assert (
        verify_webhook_signature(body=body, header=reverse, secret=secret, now_seconds=now) is True
    )
