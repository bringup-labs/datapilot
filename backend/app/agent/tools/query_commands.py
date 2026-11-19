"""Retrieve commanded velocity and navigation goal events in a time window."""
from __future__ import annotations

from typing import Any

from app.services.causal_rules import log_time_to_seconds
from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "planner_failure_inspector"
NAME = "query_commands"
DESCRIPTION = (
    "Retrieve commanded velocities (/cmd_vel) and navigation goal events "
    "(/move_base/goal, /move_base/result) within an optional time window."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "t_from": {"type": "number"},
        "t_to": {"type": "number"},
    },
    "required": ["session_id"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}

_COMMAND_TOPICS = [
    "/cmd_vel",
    "/move_base/goal",
    "/move_base/result",
    "/move_base/cancel",
    "/move_base/feedback",
]


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.topic IN $topics
       OR l.msg =~ '(?i).*(cmd_vel|velocity.command|goal.received|nav.goal|move.base.goal).*'
    RETURN l.id AS log_id, l.ts AS ts, l.topic AS topic,
           l.node AS node, l.msg AS msg, l.severity AS severity
    ORDER BY l.ts
    """
    results = run_cypher(
        cypher,
        {"session_id": args["session_id"], "topics": _COMMAND_TOPICS},
    )

    # Apply optional time window filter in Python (log timestamps are strings).
    t_from = args.get("t_from")
    t_to = args.get("t_to")
    if t_from is not None or t_to is not None:
        filtered = []
        for r in results:
            t = log_time_to_seconds(r.get("ts", "0"))
            if t_from is not None and t < t_from:
                continue
            if t_to is not None and t > t_to:
                continue
            filtered.append(r)
        results = filtered

    return {"ok": True, "result": results}
