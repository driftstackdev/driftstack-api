"""Smoke tests for the codegen output.

These tests pin a small subset of the generated surface so a future
spec change that breaks the public schema is caught before customers
get a model that disagrees with reality.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import ValidationError

from driftstack._generated import models


def test_account_validates_a_well_formed_payload() -> None:
    """Round-trip a minimal Account dict through the model."""
    payload = {
        "id": "acc_00000000-0000-4000-8000-000000000001",
        "email": "tester@driftstack.dev",
        "name": "Tester",
        "tier": "api_builder",
        "status": "active",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    account = models.Account.model_validate(payload)
    assert account.tier == "api_builder"
    assert account.status == "active"
    assert account.created_at == datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_account_rejects_unknown_tier() -> None:
    """The closed enum from the spec rejects out-of-range values."""
    bad = {
        "id": "acc_00000000-0000-4000-8000-000000000001",
        "email": "x@example.com",
        "name": None,
        "tier": "platinum",  # not in the enum
        "status": "active",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    try:
        models.Account.model_validate(bad)
    except ValidationError:
        return
    raise AssertionError("expected ValidationError on unknown tier")


def test_account_rejects_malformed_id() -> None:
    """The ``acc_<uuid>`` pattern is enforced."""
    bad = {
        "id": "not-a-prefixed-id",
        "email": "x@example.com",
        "name": None,
        "tier": "api_builder",
        "status": "active",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    try:
        models.Account.model_validate(bad)
    except ValidationError:
        return
    raise AssertionError("expected ValidationError on malformed id")


def test_models_module_has_expected_classes() -> None:
    """Sanity: the spec produced the schemas we expect to see."""
    expected = {"Account", "ApiKey", "Session", "Problem"}
    actual = {name for name in dir(models) if not name.startswith("_")}
    missing = expected - actual
    assert not missing, f"missing models: {missing}"


def test_agent_session_capability_report_preserves_degraded_states() -> None:
    """The generated SDK must not flatten view-only/blank/dead-proxy signals."""
    report = models.CapabilityReport.model_validate(
        {
            "timestamp": "2026-07-13T06:00:00Z",
            "manual_input_available": False,
            "streaming_state": "blank",
            "egress_state": "dead_proxy",
            "proxy_kind": "socks5",
            "proxy_udp_supported": False,
            "transport_mode_requested": "h2-and-h3",
            "transport_mode_active": "h2-only",
            "safeguards_passed": True,
        }
    )
    assert report.manual_input_available is False
    assert report.streaming_state == "blank"
    assert report.egress_state == "dead_proxy"


def test_agent_session_error_event_preserves_customer_safe_diagnostics() -> None:
    """The generated SDK exposes stable error metadata without requiring it."""
    event = models.ErrorEvent.model_validate(
        {
            "timestamp": "2026-07-13T06:30:00Z",
            "code": "launch_timeout",
            "severity": "error",
            "summary": "The browser did not become ready in time.",
            "detail": None,
            "customer_actionable": False,
            "retryable": True,
        }
    )
    assert event.code == "launch_timeout"
    assert event.severity == "error"
    assert event.retryable is True
    assert models.AgentSession.model_fields["error_event"].default is None


def test_agent_session_error_event_rejects_unknown_severity() -> None:
    """The public severity is a closed enum, matching the fleet protocol."""
    try:
        models.ErrorEvent.model_validate(
            {
                "timestamp": "2026-07-13T06:30:00Z",
                "code": "launch_timeout",
                "severity": "critical",
                "summary": "The browser did not become ready in time.",
                "detail": None,
                "customer_actionable": False,
                "retryable": True,
            }
        )
    except ValidationError:
        return
    raise AssertionError("expected ValidationError on unknown error severity")
