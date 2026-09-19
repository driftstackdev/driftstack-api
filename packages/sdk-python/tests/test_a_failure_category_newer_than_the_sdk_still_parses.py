"""A failure category added after this SDK was released must not break parsing.

The server adds step-failure categories over time (``element_covered`` and
``target_unverified`` both arrived after the first release). While the
published spec declared the category as a closed enum, the generated
``Diagnosis.category`` was a closed ``Literal``: any category newer than the
installed SDK raised a pydantic ``ValidationError`` on the whole response, so a
customer who had not upgraded lost every turn that carried one.

The category is now "one of the known values, or any other string". These
tests pin both halves: an unknown category parses and is kept as-is, and the
known values are still listed on the type.
"""

from __future__ import annotations

import types
import typing

import pytest
from pydantic import BaseModel, ValidationError

from driftstack._generated import models

NEWER_CATEGORY = "a_category_added_after_this_sdk_was_released"

FAILED_TAP = {
    "kind": "failure",
    "intent": {"kind": "interact", "action": "tap", "selector": "#buy"},
    "reason": "the tap was not made",
    "diagnosis": {"category": NEWER_CATEGORY, "retryable": False},
}


def test_the_diagnosis_model_keeps_a_category_it_does_not_know() -> None:
    diagnosis = models.Diagnosis.model_validate({"category": NEWER_CATEGORY, "retryable": False})
    assert diagnosis.category == NEWER_CATEGORY
    assert diagnosis.retryable is False


def test_a_step_result_with_a_newer_category_parses() -> None:
    result = models.IntentResult.model_validate(FAILED_TAP).root
    assert result.kind == "failure"
    assert result.diagnosis is not None
    assert result.diagnosis.category == NEWER_CATEGORY


def test_a_conflict_problem_whose_settled_steps_carry_a_newer_category_parses() -> None:
    problem = models.AgentMessageConflictProblem.model_validate(
        {
            "type": "https://driftstack.dev/problems/conflict",
            "title": "Conflict",
            "status": 409,
            "partial_results": [FAILED_TAP],
        }
    )
    assert problem.partial_results is not None
    first = problem.partial_results[0]
    assert first.diagnosis is not None
    assert first.diagnosis.category == NEWER_CATEGORY


def test_every_generated_result_that_carries_a_diagnosis_uses_the_open_model() -> None:
    """Turn responses inline their own result classes; each must reuse Diagnosis."""
    carriers: list[str] = []
    for name in dir(models):
        cls = getattr(models, name)
        if not (isinstance(cls, type) and issubclass(cls, BaseModel)):
            continue
        field = cls.model_fields.get("diagnosis")
        if field is None:
            continue
        carriers.append(name)
        assert models.Diagnosis in typing.get_args(field.annotation), name
    # IntentResult, the two turn results that list steps, and the conflict
    # problem's settled steps. A finder that matches nothing proves nothing.
    assert len(carriers) >= 4, carriers


@pytest.mark.parametrize("known", ["element_not_found", "target_unverified", "unknown"])
def test_a_known_category_still_parses(known: str) -> None:
    diagnosis = models.Diagnosis.model_validate({"category": known, "retryable": True})
    assert diagnosis.category == known


def test_the_known_categories_are_still_listed_on_the_type() -> None:
    annotation = models.Diagnosis.model_fields["category"].annotation
    assert typing.get_origin(annotation) in (typing.Union, types.UnionType)
    arms = typing.get_args(annotation)
    assert str in arms
    literals = [arm for arm in arms if typing.get_origin(arm) is typing.Literal]
    assert len(literals) == 1
    known = set(typing.get_args(literals[0]))
    assert {"element_not_found", "element_covered", "target_unverified", "unknown"} <= known


def test_a_category_that_is_not_text_is_still_refused() -> None:
    with pytest.raises(ValidationError):
        models.Diagnosis.model_validate({"category": 42, "retryable": False})
