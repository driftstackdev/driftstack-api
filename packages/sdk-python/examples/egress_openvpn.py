"""Customer-configurable egress — OpenVPN variant (Phase 2 priority
per planning 133 + ORCHESTRATOR-STATE 2026-05-16).

Demonstrates the OpenVPN attach flow:
  1. Save a reusable OpenVPN config blob to the customer's library.
  2. Attach the proxy to an existing session.

The .ovpn `config_blob` is the FULL contents of the file. Server-side
validation (api-types ``OpenVpnProxyConfigSchema``) rejects blobs
missing the ``client`` or ``remote <host> <port>`` directives with a
clear-shape 400 — surfacing as :class:`driftstack.errors.ValidationError`
in the SDK.

Run::

    DRIFTSTACK_API_KEY=ds_live_... \\
      DRIFTSTACK_OVPN_CONFIG_PATH=/path/to/my.ovpn \\
      DRIFTSTACK_SESSION_ID=ses_xxx \\
      python examples/egress_openvpn.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from driftstack import Driftstack
from driftstack.errors import FeatureUnavailableError, ValidationError


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    ovpn_path_str = os.environ.get("DRIFTSTACK_OVPN_CONFIG_PATH")
    session_id = os.environ.get("DRIFTSTACK_SESSION_ID")
    if not (api_key and ovpn_path_str and session_id):
        print(
            "DRIFTSTACK_API_KEY + DRIFTSTACK_OVPN_CONFIG_PATH + "
            "DRIFTSTACK_SESSION_ID environment variables are required",
            file=sys.stderr,
        )
        return 1

    ovpn_path = Path(ovpn_path_str)
    if not ovpn_path.is_file():
        print(f"OpenVPN config not found at {ovpn_path}", file=sys.stderr)
        return 1
    config_blob = ovpn_path.read_text()
    if len(config_blob) > 256 * 1024:
        print(
            f"OpenVPN config {ovpn_path} is {len(config_blob)} bytes; max 256 KB.",
            file=sys.stderr,
        )
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    client = Driftstack(api_key=api_key, base_url=base_url)

    proxy_block = {"type": "openvpn", "openvpn": {"config_blob": config_blob}}

    # Optional auth-user-pass — read from env to keep credentials out of
    # the script.
    ovpn_user = os.environ.get("DRIFTSTACK_OVPN_USERNAME")
    ovpn_pass = os.environ.get("DRIFTSTACK_OVPN_PASSWORD")
    if ovpn_user:
        proxy_block["openvpn"]["username"] = ovpn_user
    if ovpn_pass:
        proxy_block["openvpn"]["password"] = ovpn_pass

    try:
        # 1. Save the OpenVPN config to the customer's reusable library.
        saved = client.egress.save_proxy(
            {"label": f"openvpn-{ovpn_path.stem}", "proxy": proxy_block},
        )
        print(f"Saved OpenVPN config id={saved['id']} label={saved['label']} type={saved['type']}")

        # 2. Attach to the session.
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
        print(f"Attached OpenVPN proxy; safeguards={attached['safeguards']}")
    except ValidationError as e:
        # Server-side .ovpn directive validation rejected the config —
        # missing `client` or `remote <host> <port>` directives, or
        # blob over 256 KB.
        print(
            f"OpenVPN config rejected by server validation: {e}\n"
            "Check that the config has `client` + `remote <host> <port>` directives.",
            file=sys.stderr,
        )
        return 3
    except FeatureUnavailableError as e:
        print(
            f"Egress not yet enabled on this deployment: {e}\n"
            "Pre-launch posture; comes online when the OpenVPN VM harness ships.",
            file=sys.stderr,
        )
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
