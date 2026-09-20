"""Run an AI task from code: start an agent session, send it a task, read the
outcome, and close the session.

The flow:

1. create the session (mode ``ai``) and wait until its browser is ready;
2. send the task with a fresh idempotency key, printing live progress;
3. branch on the result's ``kind`` — and, if the agent stopped before a
   purchase, a payment or an account deletion, approve it by sending the next
   message with the approvals;
4. close the session in ``finally``, whatever happened.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/agent_chat.py

Optional::

    DRIFTSTACK_BYOK_ANTHROPIC_API_KEY=sk-ant-…   run the AI on your own Anthropic key
    DRIFTSTACK_TASK='Open https://example.com and tell me the main heading.'
    DRIFTSTACK_APPROVE_ACTIONS=yes               approve a purchase / payment /
                                                 account deletion the agent stops on

Deployments without an AI provider reject these calls with
``FeatureUnavailableError`` (exit code 2).
"""

from __future__ import annotations

import os
import sys
import threading
import time
import uuid
from typing import Any

from driftstack import Driftstack
from driftstack.errors import (
    BundledLlmBudgetExhaustedError,
    BundledLlmConsentRequiredError,
    ByokAnthropicRequiredError,
    ConcurrencyLimitError,
    ConflictError,
    FeatureUnavailableError,
    ForbiddenError,
    RateLimitError,
)

DEFAULT_TASK = "Open https://example.com and tell me the main heading on the page."


def wait_until_ready(client: Driftstack, session: dict[str, Any]) -> dict[str, Any]:
    """Poll until the session's browser is ready (or two minutes pass)."""
    deadline = time.monotonic() + 120
    while session["status"] == "provisioning" and time.monotonic() < deadline:
        time.sleep(2)
        session = client.agent_sessions.get(session["id"])
    return session


def on_step(step: dict[str, Any]) -> None:
    print(f"  step {step['index'] + 1}: {step['result']['kind']}")


def on_event(name: str, data: Any) -> None:
    # The set of event names is open: ignore the ones you do not use.
    if name == "step_start" and isinstance(data, dict):
        print(f"  … {data.get('label', 'working')}")


def print_outcome(resp: dict[str, Any]) -> None:
    kind = resp["kind"]
    if kind == "plan-executed":
        for r in resp["results"]:
            if r["kind"] == "success":
                print(f"  ✓ {r['summary']}")
            elif r["kind"] == "failure":
                # Treat a category you do not recognise as "unknown". Never
                # replay a step whose `retryable` is false without checking first.
                category = (r.get("diagnosis") or {}).get("category", "unknown")
                print(f"  ✗ {r['reason']} ({category})")
            else:
                print(f"  ⏸ waiting for approval: {r['category']} ({r['matchedText']!r})")
        if "answer" in resp:
            print(f"Answer: {resp['answer']}")
        elif "answer_unavailable" in resp:
            # The task asked for information and none could be produced. The two
            # never arrive together, and a task that only acts has neither. Open
            # text: show it, do not match on it.
            print(f"No answer: {resp['answer_unavailable']}")
        # `ok` alone does not mean finished: a `notice` says why the task is not
        # done yet (send "continue" as the next message when it asks for that).
        if "notice" in resp:
            # `notice_reason` says the same thing in one word, so an unattended
            # job can decide without reading English. The list is open: treat a
            # value you do not recognise the way you treat "question" — show the
            # sentence and ask a person rather than replying automatically.
            reason = resp.get("notice_reason", "no reason given")
            print(f"Not finished ({reason}): {resp['notice']}")
        print("Done." if resp["ok"] and "notice" not in resp else "The task did not finish.")
    elif kind == "clarify":
        print(f"The agent asks: {resp['clarifying_question']} (reply with another message)")
    elif kind == "refuse":
        print(f"Refused: {resp['refuse_reason']}")
    elif kind == "stopped":
        print(f"Stopped: {resp['notice']}")
    elif kind == "logged-manual":
        print("Recorded without running (manual mode).")
    else:
        # A kind newer than this example: log it rather than fail.
        print(f"Unrecognised result: {resp}")


def report_error(e: Exception) -> int:
    """Map the AI-specific errors to a message and an exit code."""
    if isinstance(e, FeatureUnavailableError):
        print(
            f"AI tasks are unavailable on this deployment: {e}\n"
            "Use a deployment with bundled Anthropic access or provide a valid BYOK Anthropic key.",
            file=sys.stderr,
        )
        return 2
    if isinstance(e, ForbiddenError) and e.requires_own_key:
        print(
            f"{e.model or 'This model'} runs only on your own Anthropic key: set "
            "DRIFTSTACK_BYOK_ANTHROPIC_API_KEY or pick another model.",
            file=sys.stderr,
        )
    elif isinstance(
        e,
        (
            ByokAnthropicRequiredError,
            BundledLlmConsentRequiredError,
            BundledLlmBudgetExhaustedError,
        ),
    ):
        print(f"No AI key or budget is available: {e}", file=sys.stderr)
    elif isinstance(e, RateLimitError):
        print(
            f"Too many requests or AI tasks at once. Wait {e.retry_after_seconds or 1}s, "
            "then send again with a new idempotency key.",
            file=sys.stderr,
        )
    elif isinstance(e, ConcurrencyLimitError):
        print(f"Concurrency limit reached: {e}", file=sys.stderr)
    elif isinstance(e, ConflictError) and e.turn_in_progress:
        print("Another message is still running on this session.", file=sys.stderr)
    elif isinstance(e, ConflictError) and e.session_status is not None:
        print(f"The session is {e.session_status}; start a new one.", file=sys.stderr)
    else:
        print(f"Request failed: {e!r}", file=sys.stderr)
    return 1


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    # Your own Anthropic key, optional. An empty value means "none": the SDK
    # sends the x-byok-anthropic-api-key header only for a non-empty key.
    byok_key = os.environ.get("DRIFTSTACK_BYOK_ANTHROPIC_API_KEY") or None
    # Ask for what you want back ("…and tell me …"): a task that asks for
    # information comes back with an `answer`. Put the start URL in the task.
    task = os.environ.get("DRIFTSTACK_TASK") or DEFAULT_TASK
    approve_actions = os.environ.get("DRIFTSTACK_APPROVE_ACTIONS") == "yes"

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    with Driftstack(api_key=api_key, base_url=base_url) as client:
        try:
            session = client.agent_sessions.create(
                {"mode": "ai", "token_budget": 100_000},
                idempotency_key=str(uuid.uuid4()),
                byok_api_key=byok_key,
            )
        except Exception as e:  # noqa: BLE001 - every failure is reported below
            return report_error(e)
        print(f"Created agent session {session['id']}")

        def send(text: str, approvals: list[dict[str, Any]] | None = None) -> dict[str, Any]:
            # One idempotency key per logical turn. Reuse a key only to retry the
            # same turn after the connection dropped with no response.
            return client.agent_sessions.message(
                session["id"],
                text,
                byok_api_key=byok_key,
                idempotency_key=str(uuid.uuid4()),
                approve_consequential_actions=approvals,
                on_step=on_step,
                on_event=on_event,
            )

        # A runaway task is stopped after ten minutes; message() then returns
        # kind "stopped".
        stop_timer = threading.Timer(600, client.agent_sessions.stop, args=(session["id"],))
        stop_timer.start()
        try:
            session = wait_until_ready(client, session)
            if session["status"] != "active":
                print(
                    f"The session did not start: status={session['status']} "
                    f"closed_reason={session.get('closed_reason')}",
                    file=sys.stderr,
                )
                return 1

            print(f"→ {task}")
            resp = send(task)

            # The agent stops BEFORE a purchase, a payment or an account deletion
            # and waits for approval. Approve by sending the very next message
            # with the approvals (the results can be passed as they are).
            pending = [r for r in resp.get("results", []) if r["kind"] == "confirmation_required"]
            if resp["kind"] == "plan-executed" and pending and approve_actions:
                print("Approving and continuing…")
                resp = send(task, approvals=pending)
            print_outcome(resp)
            return 0
        except Exception as e:  # noqa: BLE001 - every failure is reported below
            return report_error(e)
        finally:
            stop_timer.cancel()
            # Always close: an open session keeps counting toward your plan's limit.
            try:
                client.agent_sessions.close(session["id"])
                print("Closed.")
            except Exception as e:  # noqa: BLE001 - closing is best effort here
                print(f"Could not close the session: {e!r}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
