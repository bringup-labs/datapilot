#!/usr/bin/env python3
"""Copy package.json's version into backend/pyproject.toml and backend/uv.lock.

The release pipeline runs this right after bumping package.json, so the
backend reports the same version as the app and its images (#94). It rewrites
only the backend's own version line in each file, and changes neither file
unless it finds both lines.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The `version` key of pyproject.toml's [project] table, before any other table.
_PYPROJECT_VERSION = re.compile(
    r'^(\[project\]\n(?:[^\[\n][^\n]*\n|\n)*?version = )"[^"\n]*"', re.MULTILINE
)
# The backend's own entry in uv.lock, where its version is the line after its name.
_LOCK_VERSION = re.compile(r'^(name = "datapilot-backend"\nversion = )"[^"\n]*"', re.MULTILINE)


def sync(root: Path = ROOT) -> str:
    """Set the backend's version to package.json's, and return it."""
    version = json.loads((root / "package.json").read_text())["version"]
    updated: dict[Path, str] = {}
    for rel, pattern in (
        ("backend/pyproject.toml", _PYPROJECT_VERSION),
        ("backend/uv.lock", _LOCK_VERSION),
    ):
        path = root / rel
        text, count = pattern.subn(lambda m: f'{m.group(1)}"{version}"', path.read_text(), count=1)
        if count != 1:
            sys.exit(f"{rel}: couldn't find the backend's version line")
        updated[path] = text
    for path, text in updated.items():
        path.write_text(text)
    return version


if __name__ == "__main__":
    print(f"Backend version set to {sync()}")
