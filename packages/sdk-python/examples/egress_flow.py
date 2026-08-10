# ⚠️ THIS EXAMPLE CANNOT RUN SUCCESSFULLY TODAY. The per-session attach step below
# hits POST /v1/sessions/:id/proxy, which throws FeatureUnavailableError (503) on
# EVERY deployment — routes/session-proxy.ts discards the injected service and both
# registration branches throw, so no configuration makes it succeed. Session
# creation itself also refuses first when egress is required. The reusable proxy
# CRUD steps (save / list / update / delete) DO work; the attach + read-back steps
# are declared-but-unshipped. Kept as the intended shape for when the backend lands.
#
"""Customer-configurable egress flow — attach a SOCKS5 proxy to a
session, manage saved proxy configs (planning 133 Phase 1+).

Demonstrates the full egress lifecycle for a single session:
  - Save a reusable SOCKS5 config to the customer's library.
  - Create a session (here we assume it already exists; pass via env).
  - Attach the proxy to the session.
  - Read the session's proxy summary back (verifies safeguards).

Run::

    DRIFTSTACK_API_KEY=ds_live_… \\
      DRIFTSTACK_PROXY_HOST=proxy.example.com \\
      DRIFTSTACK_PROXY_PORT=1080 \\
      DRIFTSTACK_SESSION_ID=ses_xxx \\
      python examples/egress_flow.py

The server activation-gates this surface — until the SOCKS5 backend
is wired on the deployment, calls return 503 FeatureUnavailable
(machine-readable; the SDK maps to ``FeatureUnavailableError``).
"""

from __future__ import annotations

import os
import sys

from driftstack import Driftstack
from driftstack.errors import FeatureUnavailableError


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    proxy_host = os.environ.get("DRIFTSTACK_PROXY_HOST")
    proxy_port_env = os.environ.get("DRIFTSTACK_PROXY_PORT")
    session_id = os.environ.get("DRIFTSTACK_SESSION_ID")
    if not (api_key and proxy_host and proxy_port_env and session_id):
        print(
            "DRIFTSTACK_API_KEY + DRIFTSTACK_PROXY_HOST + DRIFTSTACK_PROXY_PORT + "
            "DRIFTSTACK_SESSION_ID environment variables are required",
            file=sys.stderr,
        )
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    proxy_port = int(proxy_port_env)
    client = Driftstack(api_key=api_key, base_url=base_url)

    proxy_block = {
        "type": "socks5",
        "socks5": {
            "host": proxy_host,
            "port": proxy_port,
            "udp_associate": True,  # Required for WebRTC routing per planning 133.
            # EG-WK-1.9 (2026-05-17) — leave DNS resolution local-side (default).
            # Set True to route DNS through the proxy via SOCKS5 ATYP DOMAINNAME (0x03).
            "require_remote_dns": False,
        },
    }

    try:
        # 1. Save the proxy config to the customer's reusable library (the live
        #    account-proxies API — flat body, password write-only). Then probe it.
        saved = client.egress.create_proxy(
            {
                "label": f"example {proxy_host}",
                "scheme": "socks5",
                "host": proxy_host,
                "port": proxy_port,
            }
        )
        print(f"Saved proxy id={saved['id']} label={saved['label']} scheme={saved['scheme']}")
        probe = client.egress.test_proxy(saved["id"])
        print(f"Reachability: {probe}")

        # 2. Attach the proxy to the existing session.
        attached = client.egress.attach_to_session(
            session_id,
            {
                "session_id": session_id,
                "proxy": proxy_block,
                "egress_safeguard": {
                    "block_direct_internet": True,
                    "block_unproxied_dns": True,
                    "block_webrtc_stun_leakage": True,
                },
            },
        )
        print(f"Attached proxy type={attached['type']}; safeguards={attached['safeguards']}")

        # 3. Read it back to verify.
        read = client.egress.get_session_proxy(session_id)
        print(f"Session proxy summary: {read}")
    except FeatureUnavailableError as e:
        print(
            f"SOCKS5 egress is unavailable on this deployment: {e}\n"
            "Use a deployment with SOCKS5 egress support or choose another supported proxy scheme.",
            file=sys.stderr,
        )
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
