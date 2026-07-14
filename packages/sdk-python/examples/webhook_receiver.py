"""Webhook receiver: verify the signature, dispatch by event type.

Stdlib-only — no Flask / FastAPI / Django dependency. If you're already
running one of those, port the verify+dispatch shape; the
``verify_webhook_signature`` helper takes the raw request body, the
``X-Driftstack-Signature`` header, and your shared secret.

Run::

    DRIFTSTACK_WEBHOOK_SECRET=whsec_… python examples/webhook_receiver.py

Then point a Driftstack webhook at ``http://localhost:4242/webhook``.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from driftstack import verify_webhook_signature

SECRET = os.environ.get("DRIFTSTACK_WEBHOOK_SECRET", "")


def handle_session_completed(data: dict[str, Any]) -> None:
    print(f"session.completed: session_id={data.get('session_id')}")


def handle_session_failed(data: dict[str, Any]) -> None:
    print(f"session.failed: session_id={data.get('session_id')} error={data.get('error_kind')}")


def handle_api_key_revoked(data: dict[str, Any]) -> None:
    print(f"api_key.revoked: {data.get('api_key_id')}")


HANDLERS = {
    "session.completed": handle_session_completed,
    "session.failed": handle_session_failed,
    "api_key.revoked": handle_api_key_revoked,
}


class _Receiver(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — http.server convention
        if self.path != "/webhook":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        signature = self.headers.get("x-driftstack-signature")

        if not verify_webhook_signature(body=body, header=signature, secret=SECRET):
            self.send_response(401)
            self.end_headers()
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_response(400)
            self.end_headers()
            return

        event_type = payload.get("type")
        handler = HANDLERS.get(event_type)
        if handler is not None:
            handler(payload.get("data", {}))
        else:
            print(f"unrecognized event type: {event_type}")

        # 2xx confirms receipt. Driftstack expects this within 30s.
        self.send_response(204)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 — http.server signature
        # Quieter than the default access log. Comment out for verbose runs.
        return


def main() -> int:
    if not SECRET:
        print("DRIFTSTACK_WEBHOOK_SECRET required", file=sys.stderr)
        return 1
    server = HTTPServer(("0.0.0.0", 4242), _Receiver)
    print("webhook receiver listening on http://localhost:4242/webhook")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
