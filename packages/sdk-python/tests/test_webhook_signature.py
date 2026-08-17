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


def _sig_hex(body: bytes, secret: str, timestamp_seconds: int) -> str:
    payload = f"{timestamp_seconds}.".encode() + body
    return _hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def test_dual_v1_single_header_rotation() -> None:
    """During a secret-rotation grace window the server dual-signs into one
    header (t=,v1=<new>,v1=<old>); a verifier holding EITHER secret must pass."""
    body = b'{"event":"x"}'
    now = int(time.time())
    new_secret = "whsec_new_rotated"
    old_secret = "whsec_old_pre_rotation"
    header = f"t={now},v1={_sig_hex(body, new_secret, now)},v1={_sig_hex(body, old_secret, now)}"

    # new-secret holder verifies against the FIRST v1= (previously discarded)
    assert (
        verify_webhook_signature(body=body, header=header, secret=new_secret, now_seconds=now)
        is True
    )
    # old-secret holder verifies against the LAST v1=
    assert (
        verify_webhook_signature(body=body, header=header, secret=old_secret, now_seconds=now)
        is True
    )
    # unrelated secret matches neither
    assert (
        verify_webhook_signature(
            body=body, header=header, secret="whsec_unrelated", now_seconds=now
        )
        is False
    )


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


# V-359 — rotation-grace tests for header_prev.
# When the customer hasn't rolled the new secret to their verifier
# yet, they pass `header_prev` (read from x-driftstack-signature-prev
# on the inbound request) and the verifier accepts EITHER header
# matching the supplied secret.

NEW_SECRET = "whsec_new_rotated"
OLD_SECRET = "whsec_old_pre_rotation"


def _sign_v359(body: bytes, t: int, secret: str) -> str:
    sig = _hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},v1={sig}"


def test_v359_accepts_when_only_prev_matches_old_secret() -> None:
    body = b'{"event":"x"}'
    t = int(time.time())
    ok = verify_webhook_signature(
        body=body,
        header=_sign_v359(body, t, NEW_SECRET),
        header_prev=_sign_v359(body, t, OLD_SECRET),
        secret=OLD_SECRET,
        now_seconds=t,
    )
    assert ok is True


def test_v359_accepts_when_only_current_matches_new_secret() -> None:
    body = b'{"event":"x"}'
    t = int(time.time())
    ok = verify_webhook_signature(
        body=body,
        header=_sign_v359(body, t, NEW_SECRET),
        header_prev=_sign_v359(body, t, OLD_SECRET),
        secret=NEW_SECRET,
        now_seconds=t,
    )
    assert ok is True


def test_v359_rejects_when_neither_header_matches() -> None:
    body = b"x"
    t = int(time.time())
    ok = verify_webhook_signature(
        body=body,
        header=_sign_v359(body, t, NEW_SECRET),
        header_prev=_sign_v359(body, t, OLD_SECRET),
        secret="whsec_unrelated",
        now_seconds=t,
    )
    assert ok is False


def test_v359_header_prev_none_keeps_single_header_behavior() -> None:
    body = b"x"
    t = int(time.time())
    ok = verify_webhook_signature(
        body=body,
        header=_sign_v359(body, t, NEW_SECRET),
        secret=NEW_SECRET,
        now_seconds=t,
    )
    assert ok is True


def test_uppercase_hex_signature_is_accepted() -> None:
    """Hex is case-insensitive, so the verifier must be too.

    The comparison decodes both sides before checking, which is what makes
    casing irrelevant. It used to compare the hex TEXT with compare_digest,
    which made this SDK the only one of the three to reject an upper-case
    signature for the same body, secret and timestamp — a webhook a customer
    verified with sdk-go was one their Python service refused.

    Nothing is weakened by accepting it: the HMAC still has to match byte for
    byte, still in constant time. This API signs with lowercase hex, so the
    case only arrives from a proxy or a hand-built request.
    """
    body = b'{"event":"x"}'
    secret = "whsec_case"
    ts = int(time.time())
    header = f"t={ts},v1={_sig_hex(body, secret, ts).upper()}"
    assert verify_webhook_signature(body=body, header=header, secret=secret)


def test_mixed_case_hex_signature_is_accepted() -> None:
    """Not a second lookup table — any casing of the same bytes verifies."""
    body = b'{"event":"x"}'
    secret = "whsec_case"
    ts = int(time.time())
    hexsig = _sig_hex(body, secret, ts)
    mixed = "".join(c.upper() if i % 2 == 0 else c for i, c in enumerate(hexsig))
    header = f"t={ts},v1={mixed}"
    assert verify_webhook_signature(body=body, header=header, secret=secret)


def test_case_insensitivity_does_not_weaken_verification() -> None:
    """Without this, accepting everything would satisfy the two arms above."""
    body = b'{"event":"x"}'
    secret = "whsec_case"
    ts = int(time.time())
    # Wrong secret, upper-cased: still refused.
    wrong = f"t={ts},v1={_sig_hex(body, 'whsec_other', ts).upper()}"
    assert not verify_webhook_signature(body=body, header=wrong, secret=secret)
    # Not hex at all: refused, not crashed.
    assert not verify_webhook_signature(
        body=body, header=f"t={ts},v1={'z' * 64}", secret=secret
    )
    # Odd-length hex: refused, not crashed.
    odd = _sig_hex(body, secret, ts)[:-1]
    assert not verify_webhook_signature(body=body, header=f"t={ts},v1={odd}", secret=secret)
