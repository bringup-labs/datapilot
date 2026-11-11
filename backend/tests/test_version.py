"""The backend reports the same version as the app (#94).

package.json drives the app's version and the image tags. The release
pipeline copies that version into backend/pyproject.toml and backend/uv.lock
(.github/scripts/sync_backend_version.py), and the backend reads it from
pyproject.toml.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

REPO = Path(__file__).resolve().parents[2]
SYNC_SCRIPT = REPO / ".github" / "scripts" / "sync_backend_version.py"


def _app_version(root: Path) -> str:
    return json.loads((root / "package.json").read_text())["version"]


def _pyproject_version(root: Path) -> str:
    return tomllib.loads((root / "backend" / "pyproject.toml").read_text())["project"]["version"]


def _lock_version(root: Path) -> str:
    lock = tomllib.loads((root / "backend" / "uv.lock").read_text())
    [backend] = [p for p in lock["package"] if p["name"] == "datapilot-backend"]
    return backend["version"]


def _changed_lines(before: str, after: str) -> list[tuple[str, str]]:
    old, new = before.splitlines(), after.splitlines()
    assert len(old) == len(new)
    return [(a, b) for a, b in zip(old, new) if a != b]


def test_backend_version_matches_the_app_version():
    assert _pyproject_version(REPO) == _app_version(REPO)
    assert _lock_version(REPO) == _app_version(REPO)


def test_backend_reports_its_version():
    expected = _pyproject_version(REPO)
    assert app.version == expected
    assert TestClient(app).get("/").json()["version"] == expected


def _load_sync_script():
    spec = importlib.util.spec_from_file_location("sync_backend_version", SYNC_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def release_checkout(tmp_path: Path) -> Path:
    """A copy of the files the sync script touches, as a release sees them
    right after package.json is bumped to 9.8.7."""
    (tmp_path / "backend").mkdir()
    for name in ("pyproject.toml", "uv.lock"):
        shutil.copy(REPO / "backend" / name, tmp_path / "backend" / name)
    (tmp_path / "package.json").write_text(json.dumps({"name": "datapilot", "version": "9.8.7"}))
    return tmp_path


def test_sync_script_copies_the_app_version_into_the_backend(release_checkout: Path):
    old = _pyproject_version(release_checkout)
    pyproject = release_checkout / "backend" / "pyproject.toml"
    lock = release_checkout / "backend" / "uv.lock"
    pyproject_before, lock_before = pyproject.read_text(), lock.read_text()

    _load_sync_script().sync(release_checkout)

    assert _pyproject_version(release_checkout) == "9.8.7"
    assert _lock_version(release_checkout) == "9.8.7"
    # Nothing but the backend's own version line changes in either file.
    expected = [(f'version = "{old}"', 'version = "9.8.7"')]
    assert _changed_lines(pyproject_before, pyproject.read_text()) == expected
    assert _changed_lines(lock_before, lock.read_text()) == expected


def test_sync_script_changes_nothing_when_a_version_line_is_missing(release_checkout: Path):
    pyproject = release_checkout / "backend" / "pyproject.toml"
    lock = release_checkout / "backend" / "uv.lock"
    pyproject.write_text('[project]\nname = "datapilot-backend"\n')
    lock_before = lock.read_text()

    with pytest.raises(SystemExit):
        _load_sync_script().sync(release_checkout)

    assert pyproject.read_text() == '[project]\nname = "datapilot-backend"\n'
    assert lock.read_text() == lock_before
