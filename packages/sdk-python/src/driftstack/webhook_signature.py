"""Webhook signature verification helper.

Header format (Stripe-style): ``t=<unix-seconds>,v1=<hex hmac>``.
HMAC = HMAC-SHA256(``<unix-seconds>.<raw body>``, ``<secret>``).

Mirrors :func:`verifyWebhookSignature` from the TypeScript SDK so a
multi-language receiver fleet works against the same wire format.

Example::

    from driftstack import verify_webhook_signature

    @app.post("/driftstack-webhook")
    def receive():
        sig = request.headers["x-driftstack-signature"]
        ok = verify_webhook_signature(
            body=request.body,                      # bytes or str
            header=sig,
            secret=os.environ["DRIFTSTACK_WEBHOOK_SECRET"],
        )
        if not ok:
            return Response(status=401)
        # ... process event ...
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass

DEFAULT_TOLERANCE_SEC = 300


@dataclass
class _ParsedSignature:
    timestamp_seconds: int
    signature_hexes: list[str]


def _parse_signature_header(header: str) -> _ParsedSignature | None:
    """Parse ``t=...,v1=...`` (order-independent).

    Collects EVERY ``v1=`` (Stripe-style multi-signature) — during a
    secret-rotation grace window the server dual-signs into one header
    (``t=,v1=<new>,v1=<old>``). Return None on shape failure (no timestamp
    or zero signatures).
    """
    timestamp: int | None = None
    signatures: list[str] = []
    for part in header.split(","):
        eq_idx = part.find("=")
        if eq_idx < 0:
            continue
        key = part[:eq_idx].strip()
        value = part[eq_idx + 1 :].strip()
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                continue
        elif key == "v1" and value:
            signatures.append(value)
    if timestamp is None or not signatures:
        return None
    return _ParsedSignature(timestamp_seconds=timestamp, signature_hexes=signatures)


def _verify_single_header(
    header: str | None,
    body_bytes: bytes,
    secret: str,
    tolerance_sec: int,
    now: float,
) -> bool:
    if not header or not isinstance(header, str):
        return False

    parsed = _parse_signature_header(header)
    if parsed is None:
        return False

    if abs(now - parsed.timestamp_seconds) > tolerance_sec:
        return False

    payload = f"{parsed.timestamp_seconds}.".encode() + body_bytes
    expected = hmac.new(
        secret.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()
    # Accept if our computed HMAC matches ANY of the header's v1= signatures
    # (constant-time per candidate), so a verifier holding either the new or
    # old secret passes during a rotation dual-sign grace window.
    #
    # Compared as DECODED BYTES, not as hex text. Hex is case-insensitive by
    # definition, and sdk-typescript (hexToBytes + XOR) and sdk-go
    # (hex.DecodeString + hmac.Equal) both decode before comparing — a
    # string compare made this SDK the only one of the three to reject an
    # upper-case signature for the same body and secret. Decoding does not
    # weaken anything: the HMAC still has to match, byte for byte, in constant
    # time. A candidate that is not valid hex simply does not match.
    expected_bytes = bytes.fromhex(expected)
    for sig in parsed.signature_hexes:
        try:
            candidate = bytes.fromhex(sig)
        except ValueError:
            continue
        if hmac.compare_digest(expected_bytes, candidate):
            return True
    return False


def verify_webhook_signature(
    *,
    body: bytes | str,
    header: str | None,
    secret: str,
    header_prev: str | None = None,
    tolerance_sec: int = DEFAULT_TOLERANCE_SEC,
    now_seconds: float | None = None,
) -> bool:
    """Verify an inbound webhook signature header.

    Returns ``True`` iff the header is well-formed, the timestamp is
    within ``tolerance_sec`` of now, and the HMAC matches in
    constant time. Returns ``False`` on any failure mode — never
    raises.

    ``body`` must be the EXACT raw bytes the server signed. If your
    framework re-encodes JSON before passing it to your handler,
    you'll need to use a raw-body access path (Flask:
    ``request.get_data()``; FastAPI: ``await request.body()``;
    Django: ``request.body``).

    V-359 — ``header_prev`` is an OPTIONAL fallback for a
    separately-supplied previous-secret signature. Driftstack does
    NOT emit a separate header: during a rotation grace window the
    previous-secret HMAC is included as a second ``v1=`` inside the
    main ``x-driftstack-signature`` header (``t=,v1=<new>,v1=<old>``),
    which the verifier already checks. So passing ``header`` alone
    verifies rotation deliveries correctly and this input is rarely
    needed. When set, the verifier accepts EITHER ``header`` OR
    ``header_prev`` matching ``secret``.
    """
    # V-2010 — refuse before hashing when the signing secret is empty. ``hmac.new``
    # accepts a zero-length key and returns a perfectly good digest, so without
    # this an attacker who knows the body and timestamp computes
    # ``HMAC-SHA256(b"", f"{t}.{body}")`` and it verifies. Measured: that exact
    # input returned ``True``. The docstring above promises ``False`` on any
    # failure mode; an empty secret is one.
    if not secret:
        return False

    body_bytes = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    now = now_seconds if now_seconds is not None else time.time()

    if _verify_single_header(header, body_bytes, secret, tolerance_sec, now):
        return True
    if header_prev is not None and _verify_single_header(
        header_prev, body_bytes, secret, tolerance_sec, now
    ):
        return True
    return False
