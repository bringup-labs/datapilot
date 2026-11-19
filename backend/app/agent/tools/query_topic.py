"""Sample values from a topic in a session, within an optional time window."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "trajectory_analyzer"
NAME = "query_topic"
DESCRIPTION = "List logs/messages on a specific topic in the session, ordered by timestamp."

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "topic": {"type": "string"},
        "t_from": {"type": "number"},
        "t_to": {"type": "number"},
        "limit": {"type": "integer", "default": 50, "minimum": 1, "maximum": 500},
    },
    "required": ["session_id", "topic"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.topic = $topic
    RETURN l.id AS log_id, l.ts AS ts, l.severity AS severity, l.node AS node, l.msg AS msg
    ORDER BY l.ts
    LIMIT $limit
    """
    results = run_cypher(
        cypher,
        {"session_id": args["session_id"], "topic": args["topic"], "limit": int(args.get("limit", 50))},
    )
    return {"ok": True, "result": results}
