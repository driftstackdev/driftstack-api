"""Smoke tests for the codegen output.

These tests pin a small subset of the generated surface so a future
spec change that breaks the public schema is caught before customers
get a model that disagrees with reality.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
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


def test_search_response_preserves_both_strict_outcome_branches() -> None:
    completed = models.SearchResponse.model_validate(
        {
            "submitted": False,
            "query_truncated": False,
            "results_visible": False,
            "duration_ms": 8_420,
        }
    ).root
    assert completed.submitted is False
    assert completed.query_truncated is False
    assert completed.results_visible is False

    truncated = models.SearchResponse.model_validate(
        {
            "submitted": False,
            "query_truncated": True,
            "duration_ms": 600_000,
        }
    ).root
    assert truncated.submitted is False
    assert truncated.query_truncated is True
    assert not hasattr(truncated, "results_visible")


@pytest.mark.parametrize(
    "payload",
    [
        {"submitted": True, "query_truncated": True, "duration_ms": 1},
        {
            "submitted": False,
            "query_truncated": True,
            "results_visible": False,
            "duration_ms": 1,
        },
        {"submitted": True, "query_truncated": False, "duration_ms": 600_001},
        {
            "submitted": True,
            "query_truncated": False,
            "duration_ms": 1,
            "unexpected": True,
        },
        {"query_truncated": False, "duration_ms": 1},
    ],
)
def test_search_response_rejects_contradictory_or_extra_payloads(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        models.SearchResponse.model_validate(payload)


def test_session_login_response_preserves_both_strict_outcome_branches() -> None:
    """Generated OpenAPI models retain safe-refusal discrimination and bounds."""
    submitted = models.SessionLoginResponse.model_validate(
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": False,
            "post_login_url": "https://example.test/challenge",
            "duration_ms": 12_450,
        }
    ).root
    assert submitted.submitted is True
    assert submitted.credentials_truncated is False
    assert submitted.logged_in is False
    assert submitted.post_login_url == "https://example.test/challenge"

    truncated = models.SessionLoginResponse.model_validate(
        {
            "submitted": False,
            "credentials_truncated": True,
            "logged_in": False,
            "duration_ms": 600_000,
        }
    ).root
    assert truncated.submitted is False
    assert truncated.credentials_truncated is True
    assert truncated.logged_in is False
    assert not hasattr(truncated, "post_login_url")


@pytest.mark.parametrize(
    "payload",
    [
        {
            "submitted": True,
            "credentials_truncated": True,
            "logged_in": False,
            "duration_ms": 1,
        },
        {
            "submitted": False,
            "credentials_truncated": True,
            "logged_in": True,
            "duration_ms": 1,
        },
        {
            "submitted": False,
            "credentials_truncated": True,
            "logged_in": False,
            "post_login_url": "https://example.test/leak",
            "duration_ms": 1,
        },
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": True,
            "duration_ms": 600_001,
        },
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": True,
            "duration_ms": 1,
            "unexpected": True,
        },
    ],
)
def test_session_login_response_rejects_contradictory_or_extra_payloads(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        models.SessionLoginResponse.model_validate(payload)


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
