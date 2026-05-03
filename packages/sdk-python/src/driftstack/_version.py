"""Single source of truth for the SDK's package version.

Kept in a tiny module so `__init__.py` can import it without pulling
in the full dependency graph (httpx, pydantic) before the version is
needed — useful for tools that scrape the version without installing.
"""

from __future__ import annotations

__version__ = "0.1.2"
