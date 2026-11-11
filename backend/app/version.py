"""The backend's version, read from backend/pyproject.toml.

The release pipeline keeps it equal to the app's version in package.json
(#94). The project isn't installed as a package (uv.lock marks it virtual), so
importlib.metadata has nothing to read. The Docker image copies pyproject.toml
next to `app/`, as the checkout has it.
"""
from __future__ import annotations

import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _read_version() -> str:
    try:
        with PYPROJECT.open("rb") as f:
            return str(tomllib.load(f)["project"]["version"])
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return "unknown"


__version__ = _read_version()
