"""
Shared Neo4j plumbing for the tool modules (#59).

Every Neo4j-backed tool used to carry its own copy of

    try:
        rows = neo4j_client.run_query(...)
    except Exception as exc:
        return {"ok": False, "error": {"code": "neo4j_failed", ...}}

and the copies had drifted: some tools wrapped every query, some only the
first, one none. Tools now call `run_cypher` and decorate `run` with
`neo4j_tool`, so a failed query always produces the same error envelope and
nothing else is mislabelled as a Neo4j failure.
"""
from __future__ import annotations

import functools
import logging
from typing import Any, Callable

from app.services.neo4j_client import neo4j_client

logger = logging.getLogger(__name__)

ToolRun = Callable[[dict[str, Any]], dict[str, Any]]


class Neo4jToolError(RuntimeError):
    """A Cypher query made by a tool failed."""


def run_cypher(query: Any, parameters: dict[str, Any] | None = None) -> list:
    """Run a query for a tool. Raises `Neo4jToolError` if Neo4j fails."""
    try:
        return neo4j_client.run_query(query, parameters)
    except Exception as exc:
        raise Neo4jToolError(str(exc)) from exc


def neo4j_failed(message: str) -> dict[str, Any]:
    """The error envelope for a failed Neo4j query. Retryable: the usual causes
    (connection reset, timeout, restart) are transient."""
    return {"ok": False, "error": {"code": "neo4j_failed", "message": message, "retryable": True}}


def neo4j_tool(run: ToolRun) -> ToolRun:
    """Turn a `Neo4jToolError` raised anywhere in a tool's `run` into the
    `neo4j_failed` envelope. Other exceptions are not caught here."""

    @functools.wraps(run)
    def wrapper(args: dict[str, Any]) -> dict[str, Any]:
        try:
            return run(args)
        except Neo4jToolError as exc:
            logger.warning("tool %s: neo4j query failed: %s", run.__module__.rsplit(".", 1)[-1], exc)
            return neo4j_failed(str(exc))

    return wrapper
