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
    signature_hex: str


def _parse_signature_header(header: str) -> _ParsedSignature | None:
    """Parse ``t=...,v1=...`` (order-independent). Return None on shape failure."""
    timestamp: int | None = None
    signature: str | None = None
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
        elif key == "v1":
            signature = value
    if timestamp is None or signature is None:
        return None
    return _ParsedSignature(timestamp_seconds=timestamp, signature_hex=signature)


def verify_webhook_signature(
    *,
    body: bytes | str,
    header: str | None,
    secret: str,
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
    """
    if not header or not isinstance(header, str):
        return False

    parsed = _parse_signature_header(header)
    if parsed is None:
        return False

    now = now_seconds if now_seconds is not None else time.time()
    if abs(now - parsed.timestamp_seconds) > tolerance_sec:
        return False

    body_bytes = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    payload = f"{parsed.timestamp_seconds}.".encode() + body_bytes

    expected = hmac.new(
        secret.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()

    # ``compare_digest`` is constant-time on equal-length strings.
    return hmac.compare_digest(expected, parsed.signature_hex)
