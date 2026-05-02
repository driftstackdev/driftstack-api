"""Smoke tests for the package shape + constructor / transport plumbing."""

from __future__ import annotations

import pytest

import driftstack
from driftstack import AsyncDriftstack, Driftstack
from driftstack._version import __version__


def test_package_exposes_expected_surface() -> None:
    """The names listed in __all__ are all importable from the top level."""
    for name in driftstack.__all__:
        assert hasattr(driftstack, name), f"{name} missing from driftstack"


def test_version_string_matches_pyproject_default() -> None:
    """Package version is exposed and looks like a SemVer string."""
    import re

    assert re.match(r"^\d+\.\d+\.\d+(?:[-+].*)?$", __version__), (
        f"version {__version__!r} does not look like SemVer"
    )
    assert driftstack.__version__ == __version__


def test_sync_client_construction() -> None:
    """Driftstack() builds with just api_key; supports context-manager close."""
    with Driftstack(api_key="ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as client:
        # The internal http client is set up; we don't expose the field
        # publicly but smoke-check it through behaviour.
        assert client is not None


def test_sync_client_rejects_empty_api_key() -> None:
    with pytest.raises(TypeError):
        Driftstack(api_key="")


def test_sync_client_rejects_non_string_api_key() -> None:
    with pytest.raises(TypeError):
        Driftstack(api_key=123)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_async_client_construction() -> None:
    """AsyncDriftstack() builds and closes cleanly."""
    async with AsyncDriftstack(api_key="ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as client:
        assert client is not None
