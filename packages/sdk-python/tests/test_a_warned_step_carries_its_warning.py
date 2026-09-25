"""A step that succeeded with something worth knowing carries a ``warning``.

A navigation the site answered with an HTTP status of 400 or above is a
SUCCESS: the page that loaded may be an error page, a page asking to sign in or
to complete a verification step, or the whole page served under that status.
The result says so in ``summary`` and carries ``warning`` —
``{"kind": "http_error_status", "status": 404}`` — for a program to branch on.

These tests pin that the generated models keep the field on every success
step, keep it absent on a clean one, and accept a warning kind newer than the
installed SDK (the kind is "one of the known values, or any other string", for
the reason the failure category is).
"""

from __future__ import annotations

import types
import typing

import pytest
from pydantic import BaseModel, ValidationError

from driftstack._generated import models

WARNED = {
    "kind": "success",
    "intent": {"kind": "navigate", "url": "https://example.test/account"},
    "summary": (
        "navigated to https://example.test/account"
        " — the site answered 404 (this address may not exist)"
    ),
    "warning": {"kind": "http_error_status", "status": 404},
}

CLEAN = {
    "kind": "success",
    "intent": {"kind": "navigate", "url": "https://example.test/"},
    "summary": "navigated to https://example.test/",
}

NEWER_KIND = "a_warning_added_after_this_sdk_was_released"


def test_a_warned_step_keeps_its_warning() -> None:
    result = models.IntentResult.model_validate(WARNED).root
    assert result.kind == "success"
    assert result.warning is not None
    assert result.warning.kind == "http_error_status"
    assert result.warning.status == 404


def test_a_clean_step_has_no_warning() -> None:
    result = models.IntentResult.model_validate(CLEAN).root
    assert result.kind == "success"
    assert result.warning is None


def test_a_warning_kind_newer_than_the_sdk_parses_and_is_kept() -> None:
    result = models.IntentResult.model_validate({**CLEAN, "warning": {"kind": NEWER_KIND}}).root
    assert result.warning is not None
    assert result.warning.kind == NEWER_KIND
    assert result.warning.status is None


def test_a_warning_kind_that_is_not_text_is_refused() -> None:
    with pytest.raises(ValidationError):
        models.IntentResult.model_validate({**CLEAN, "warning": {"kind": 42}})


def test_every_generated_success_step_carries_the_warning() -> None:
    """Turn responses inline their own result classes; each success must have it."""
    carriers: list[str] = []
    for name in dir(models):
        cls = getattr(models, name)
        if not (isinstance(cls, type) and issubclass(cls, BaseModel)):
            continue
        fields = cls.model_fields
        if "summary" not in fields or "captureId" not in fields:
            continue
        carriers.append(name)
        field = fields.get("warning")
        assert field is not None, name
        assert not field.is_required(), name
    # IntentResult, the two turn results that list steps, and the conflict
    # problem's settled steps. A finder that matches nothing proves nothing.
    assert len(carriers) >= 4, carriers


def test_the_known_kind_is_still_listed_on_the_type() -> None:
    result = models.IntentResult.model_validate(WARNED).root
    assert result.warning is not None
    annotation = type(result.warning).model_fields["kind"].annotation
    assert typing.get_origin(annotation) in (typing.Union, types.UnionType)
    arms = typing.get_args(annotation)
    assert str in arms
    literals = [arm for arm in arms if typing.get_origin(arm) is typing.Literal]
    assert len(literals) == 1
    assert "http_error_status" in typing.get_args(literals[0])
