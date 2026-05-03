"""Wire-shape lock tests for InteractAction + WaitCondition + NavigateRequest.

Built into the contract audit pass (V-037) after Go's ``time_ms`` vs
``time`` bug shipped silently in 0.1.0–0.1.1 — the kind of typo that
corrupts every wait call without ever throwing. Pinning the exact
Pydantic-emitted JSON shape here means the next time the schema
shifts, this test breaks before customers do.

The codegen names variants ``Action``, ``Action1``, ... and
``Condition``, ``Condition1``, ... in declaration order. We import
the union (``InteractRequest.action``) rather than the suffixed
classes so the test survives reorderings.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from driftstack._generated.models import (
    InteractRequest,
    NavigateRequest,
    WaitRequest,
)


# ─── InteractAction wire shape ────────────────────────────────────


def test_interact_tap_round_trip() -> None:
    req = InteractRequest.model_validate(
        {"action": {"kind": "tap", "selector": "#go"}}
    )
    assert req.action.kind == "tap"
    # Round-trip: serialised JSON has the canonical keys.
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {"action": {"kind": "tap", "selector": "#go"}}


def test_interact_type_round_trip() -> None:
    req = InteractRequest.model_validate(
        {"action": {"kind": "type", "selector": "input", "text": "hi"}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {
        "action": {"kind": "type", "selector": "input", "text": "hi"}
    }


def test_interact_scroll_uses_delta_x_delta_y() -> None:
    """The scroll variant uses delta_x / delta_y, not x / y.

    Pinning this catches the regression Go shipped in 0.1.0 where
    NewScrollAction was emitting `{x, y}` — silently no-op'd by the
    server's `delta_x: 0, delta_y: 0` defaults.
    """
    req = InteractRequest.model_validate(
        {"action": {"kind": "scroll", "delta_x": 0, "delta_y": 200}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload["action"] == {"kind": "scroll", "delta_x": 0, "delta_y": 200}


def test_interact_press_round_trip() -> None:
    req = InteractRequest.model_validate(
        {"action": {"kind": "press", "key": "Enter"}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {"action": {"kind": "press", "key": "Enter"}}


def test_interact_rejects_coordinate_primitives() -> None:
    """L-001 — tap_at / type_focused are NOT on the customer-facing surface."""
    with pytest.raises(ValidationError):
        InteractRequest.model_validate(
            {"action": {"kind": "tap_at", "x": 100, "y": 100}}
        )
    with pytest.raises(ValidationError):
        InteractRequest.model_validate(
            {"action": {"kind": "type_focused", "text": "x"}}
        )


# ─── WaitCondition wire shape ─────────────────────────────────────


def test_wait_selector_round_trip() -> None:
    req = WaitRequest.model_validate(
        {"condition": {"kind": "selector", "selector": "#ready"}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {"condition": {"kind": "selector", "selector": "#ready"}}


def test_wait_time_uses_kind_time_not_time_ms() -> None:
    """The canonical name is ``time``, not ``time_ms``.

    Go SDK 0.1.0–0.1.1 hardcoded ``time_ms`` and silently broke every
    wait call. Pin the canonical name here.
    """
    req = WaitRequest.model_validate(
        {"condition": {"kind": "time", "ms": 5000}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {"condition": {"kind": "time", "ms": 5000}}

    with pytest.raises(ValidationError):
        WaitRequest.model_validate(
            {"condition": {"kind": "time_ms", "ms": 5000}}
        )


def test_wait_url_matches_round_trip() -> None:
    req = WaitRequest.model_validate(
        {"condition": {"kind": "url_matches", "pattern": "https://.*"}}
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {
        "condition": {"kind": "url_matches", "pattern": "https://.*"}
    }


# ─── NavigateRequest wire shape ───────────────────────────────────


def test_navigate_request_round_trip() -> None:
    req = NavigateRequest.model_validate(
        {
            "url": "https://example.com",
            "wait_until": "load",
            "timeout_ms": 15_000,
        }
    )
    payload = json.loads(req.model_dump_json(exclude_none=True))
    assert payload == {
        "url": "https://example.com/",
        "wait_until": "load",
        "timeout_ms": 15_000,
    }


def test_navigate_timeout_ms_bounds() -> None:
    """Spec: 1000 ≤ timeout_ms ≤ 120000."""
    with pytest.raises(ValidationError):
        NavigateRequest.model_validate(
            {"url": "https://example.com", "timeout_ms": 999}
        )
    with pytest.raises(ValidationError):
        NavigateRequest.model_validate(
            {"url": "https://example.com", "timeout_ms": 120_001}
        )
    # Inside the bounds is fine.
    NavigateRequest.model_validate(
        {"url": "https://example.com", "timeout_ms": 1000}
    )
    NavigateRequest.model_validate(
        {"url": "https://example.com", "timeout_ms": 120_000}
    )
