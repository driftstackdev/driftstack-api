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
        "tier": "builder",
        "status": "active",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    account = models.Account.model_validate(payload)
    assert account.tier == "builder"
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
        "tier": "builder",
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
