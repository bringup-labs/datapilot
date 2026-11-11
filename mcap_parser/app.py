"""
mcap-parser FastAPI service.

Endpoints
---------
GET  /health  → {"status": "ok"}
POST /parse   → {"filepath": "/host/..."} → parsed session dict

A failed /parse returns {"ok": false, "error": {"code", "message", "retryable"}}
with HTTP 400 (code "invalid_path") or 422 (code "parse_error").
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mcap_parser.parser import parse_bag

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="datapilot-mcap-parser", version="1.0.0")

# Allowed rosbag extensions (case-insensitive). Kept in sync with the backend
# parser's _validate_bag_path. See issue #80.
_ALLOWED_BAG_SUFFIXES = frozenset({".mcap", ".db3"})


def _is_within(child: str, parent: str) -> bool:
    """True when realpath `child` is inside realpath `parent`.

    Uses os.path.commonpath (not str.startswith) so that e.g. ``/bags-evil`` is
    NOT treated as living under ``/bags``.
    """
    # normcase folds case + separators on case-insensitive platforms (Windows),
    # so a valid path isn't rejected over casing differences; it's a no-op on POSIX.
    parent_real = os.path.normcase(os.path.realpath(parent))
    child_real = os.path.normcase(os.path.realpath(child))
    try:
        return os.path.normcase(os.path.commonpath([parent_real, child_real])) == parent_real
    except ValueError:
        # Different drives / mix of absolute+relative → not contained.
        return False


def _validate_bag_path(filepath: str) -> str:
    """Validate and contain an untrusted bag path before it is opened (issue #80).

    `filepath` arrives over HTTP/IPC and is otherwise untrusted. Returns the
    canonical realpath on success; raises ValueError on rejection.

    Rules (kept consistent with backend ``app.services.parser._validate_bag_path``):
    - Canonicalize with os.path.realpath (defeats ``..`` and symlink escapes).
    - The path must exist and be a *regular* file (rejects dirs, devices, FIFOs).
    - The extension must be one of _ALLOWED_BAG_SUFFIXES (case-insensitive).
    - If DATAPILOT_BAG_ROOT is set, the realpath must be contained within it.
      If unset, no root is imposed (a /host-mounted absolute path is still
      accepted) but the realpath/regular-file/extension checks always apply.
    """
    if not isinstance(filepath, str) or not filepath:
        raise ValueError("invalid bag path")

    real = os.path.realpath(filepath)

    if Path(real).suffix.lower() not in _ALLOWED_BAG_SUFFIXES:
        raise ValueError("invalid bag path: unsupported file extension")

    if not os.path.isfile(real):
        # isfile() follows symlinks and is False for dirs/FIFOs/devices/missing.
        raise ValueError("invalid bag path: not a regular file")

    bag_root = os.environ.get("DATAPILOT_BAG_ROOT")
    if bag_root and not _is_within(real, bag_root):
        raise ValueError("invalid bag path: outside the allowed bag root")

    return real


class ParseRequest(BaseModel):
    filepath: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    """A failed /parse: the typed error envelope, with a non-2xx status (#86).

    Neither failure is retryable: the same request gets the same result.
    """
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error": {"code": code, "message": message, "retryable": False}},
    )


@app.post("/parse", response_model=None)
def parse(req: ParseRequest) -> dict[str, Any] | JSONResponse:
    logger.info("parse request: %s", req.filepath)
    # Containment check (issue #80): validate the untrusted path before opening
    # it. Use a stable, generic error message — do not echo the raw path back in
    # a way that aids traversal probing.
    try:
        safe_path = _validate_bag_path(req.filepath)
    except ValueError:
        logger.warning("rejected invalid bag path: %r", req.filepath)
        return _error(400, "invalid_path", "invalid bag path")
    try:
        result = parse_bag(safe_path)
        return result
    except Exception as exc:
        logger.exception("parse failed for validated path")
        return _error(422, "parse_error", str(exc))
