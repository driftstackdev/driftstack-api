# ⚠️ THIS EXAMPLE CANNOT RUN SUCCESSFULLY TODAY. The per-session attach step below
# hits POST /v1/sessions/:id/proxy, which throws FeatureUnavailableError (503) on
# EVERY deployment — routes/session-proxy.ts discards the injected service and both
# registration branches throw, so no configuration makes it succeed. Session
# creation itself also refuses first when egress is required. The reusable proxy
# CRUD steps (save / list / update / delete) DO work; the attach + read-back steps
# are declared-but-unshipped. Kept as the intended shape for when the backend lands.
#
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
import re
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

    # Annotated so the example type-checks: an unannotated literal widens to
    # dict[str, Collection[str]] and the nested assignments below become
    # invalid to mypy even though they are correct at runtime.
    openvpn_block: dict[str, str] = {"config_blob": config_blob}
    proxy_block: dict[str, object] = {"type": "openvpn", "openvpn": openvpn_block}

    # Optional auth-user-pass — read from env to keep credentials out of
    # the script.
    ovpn_user = os.environ.get("DRIFTSTACK_OVPN_USERNAME")
    ovpn_pass = os.environ.get("DRIFTSTACK_OVPN_PASSWORD")
    if ovpn_user:
        openvpn_block["username"] = ovpn_user
    if ovpn_pass:
        openvpn_block["password"] = ovpn_pass

    # The live account-proxies API stores the VPN endpoint as host:port, parsed
    # from the `remote <host> <port>` directive (defaults to 1194).
    remote_match = re.search(r"^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d+))?", config_blob, re.MULTILINE)
    ovpn_host = remote_match.group(1) if remote_match else "vpn.example.com"
    ovpn_port = int(remote_match.group(2)) if (remote_match and remote_match.group(2)) else 1194

    try:
        # 1. Save the OpenVPN config to the customer's reusable library (the live
        #    account-proxies API). The .ovpn config_blob is write-only.
        saved = client.egress.create_proxy(
            {
                "label": f"openvpn-{ovpn_path.stem}",
                "scheme": "openvpn",
                "host": ovpn_host,
                "port": ovpn_port,
                "openvpn": proxy_block["openvpn"],
            },
        )
        print(f"Saved OpenVPN id={saved['id']} label={saved['label']} scheme={saved['scheme']}")

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
            f"OpenVPN egress is unavailable on this deployment: {e}\n"
            "Use a deployment with OpenVPN support or choose another supported proxy scheme.",
            file=sys.stderr,
        )
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
