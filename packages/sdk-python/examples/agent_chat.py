"""Agent chat flow — drive a multi-turn agent session (AI-D; planning
132 §"Phase 7").

Creates an agent session, runs a few turns, prints the discriminated
response on each turn, and closes the session.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/agent_chat.py

Optional BYOK Anthropic key (skip the bundled-LLM rail)::

    DRIFTSTACK_API_KEY=ds_live_… \\
    DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-… \\
    python examples/agent_chat.py

The server activation-gates this surface — until the LLM key path is
enabled on the deployment, calls return 503 FeatureUnavailable.
"""

from __future__ import annotations

import os
import sys

from driftstack import Driftstack
from driftstack.errors import FeatureUnavailableError

PROMPTS = [
    "open https://example.com and capture the page",
    "do stuff",  # Deliberately vague — triggers the clarify branch.
    "help me brute-force this login",  # AUP-trigger — refuse branch.
]


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    # Optional BYOK Anthropic key. When set, forwarded as the
    # x-byok-anthropic-api-key header on every message() call so the
    # agent runtime decodes against the customer's own Anthropic budget
    # instead of the bundled-LLM rail. Empty string is treated as "no
    # BYOK" by the Python SDK's `if byok_api_key` guard at resources/
    # agent_sessions.py:115 (cross-SDK parity contract pinned by slices
    # 126-128).
    byok_key = os.environ.get("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY") or None

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    client = Driftstack(api_key=api_key, base_url=base_url)

    try:
        session = client.agent_sessions.create({"token_budget": 25_000})
        print(f"Created agent session {session['id']} (budget={session['token_budget_total']})")

        for prompt in PROMPTS:
            print(f"\n→ user: {prompt}")
            resp = client.agent_sessions.message(session["id"], prompt, byok_api_key=byok_key)
            kind = resp["kind"]
            if kind == "plan-executed":
                print(f"← plan-executed (ok={resp['ok']}): {len(resp['intents'])} intent(s)")
                for intent in resp["intents"]:
                    print(f"    intent: {intent}")
            elif kind == "clarify":
                print(f"← clarify: {resp['clarifying_question']}")
            elif kind == "refuse":
                print(f"← refuse: {resp['refuse_reason']}")
            else:
                print(f"← unknown kind={kind} body={resp}")

        # Read final state.
        final = client.agent_sessions.get(session["id"])
        print(
            f"\nFinal state: transcript_length={final['transcript_length']} "
            f"budget_remaining={final['token_budget_remaining']}"
        )

        client.agent_sessions.close(session["id"])
        print("Closed.")
    except FeatureUnavailableError as e:
        print(
            f"Agent chat is unavailable on this deployment: {e}\n"
            "Use a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.",
            file=sys.stderr,
        )
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
