"""LangChain tool wrapper: expose Driftstack as a tool an agent can call.

This is a sketch — the LangChain API churns; refer to your installed
LangChain version's docs for the canonical Tool shape. The pattern
shown here (one tool per session-creation, one per navigation) is the
one we've seen work for AI-agent QA pipelines.

Install LangChain separately::

    pip install langchain-core

Then import + use the tool::

    from examples.langchain_tool import build_driftstack_tools
    tools = build_driftstack_tools(client)
"""

from __future__ import annotations

from typing import Any

from driftstack import Driftstack


def build_driftstack_tools(client: Driftstack) -> list[Any]:
    """Build a list of LangChain ``Tool`` objects backed by the SDK.

    Returns a plain ``list[Any]`` so this file imports without
    requiring ``langchain-core`` to be installed in the SDK's own
    environment. The runtime types are ``langchain_core.tools.Tool``.
    """
    try:
        from langchain_core.tools import Tool
    except ImportError as err:  # pragma: no cover — example-only
        raise RuntimeError(
            "Install langchain-core to use this helper: pip install langchain-core"
        ) from err

    def create_session(_input: str = "") -> str:
        s = client.sessions.create()
        return f"created session {s.id}"

    def navigate(payload: str) -> str:
        # LangChain tools are typically str-in str-out; agents pass
        # JSON-shaped strings. Customers can swap to ``StructuredTool``
        # for schema-typed inputs.
        import json as _json

        args = _json.loads(payload)
        result = client.sessions.navigate(args["session_id"], {"url": args["url"]})
        return f"navigated to {result.final_url} (status={result.status})"

    def destroy_session(session_id: str) -> str:
        client.sessions.destroy(session_id.strip())
        return f"destroyed {session_id}"

    return [
        Tool(
            name="driftstack_create_session",
            description="Create a Driftstack iPhone Safari session. Returns the session id.",
            func=create_session,
        ),
        Tool(
            name="driftstack_navigate",
            description=(
                "Navigate a Driftstack session to a URL. "
                'Pass JSON: {"session_id": "ses_…", "url": "https://…"}.'
            ),
            func=navigate,
        ),
        Tool(
            name="driftstack_destroy_session",
            description="Destroy a Driftstack session by id.",
            func=destroy_session,
        ),
    ]
