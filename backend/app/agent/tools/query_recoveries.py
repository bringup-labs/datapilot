"""Find all recovery behavior invocations recorded in session logs."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "planner_failure_inspector"
NAME = "query_recoveries"
DESCRIPTION = (
    "List all recovery behavior invocations in the session "
    "(clear_costmap, rotate_recovery, oscillation recovery, backup, etc.)."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
    },
    "required": ["session_id"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.msg =~ '(?i).*(recovery|clear.?costmap|rotate.?recovery|'
                        + 'oscillation.?recovery|backup.?recovery|'
                        + 'recovery.?behavior|recovery.?triggered).*'
    RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
           l.severity AS severity, l.msg AS msg, l.topic AS topic
    ORDER BY l.ts
    """
    results = run_cypher(cypher, {"session_id": args["session_id"]})
    return {"ok": True, "result": results}
