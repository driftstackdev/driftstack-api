"""Quickstart: create a session, navigate, capture, destroy.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/quickstart.py

Set ``DRIFTSTACK_BASE_URL`` if you're not hitting production
(``https://api.driftstack.dev``).
"""

from __future__ import annotations

import os
import sys

from driftstack import Driftstack


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")

    with Driftstack(api_key=api_key, base_url=base_url) as client:
        # Create a session and navigate to a page.
        session = client.sessions.create({"label": "quickstart"})
        print(f"created session {session.id}")

        client.sessions.navigate(str(session.id), {"url": "https://example.com/"})
        print("navigated")

        # Capture a screenshot. The response carries the bytes inline
        # (base64) so this works without any external blob storage.
        capture = client.sessions.capture(str(session.id), {"kind": "screenshot"})
        print(f"captured screenshot ({capture.byte_size} bytes)")

        # Destroying a session is idempotent — safe to call twice.
        client.sessions.destroy(str(session.id))
        print(f"destroyed session {session.id}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
