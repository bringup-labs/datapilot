"""Evaluate a set of safety rules against session data."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "planner_failure_inspector"
NAME = "query_safety_rules"
DESCRIPTION = (
    "Evaluate five safety rules against the session: "
    "ESTOP_TRIGGERED, SENSOR_DROPOUT, OBSTACLE_PROXIMITY, "
    "PLANNER_FAILURE, RECOVERY_TRIGGERED. "
    "Returns a list of triggered rules with supporting evidence."
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

_RULES: list[tuple[str, str]] = [
    (
        "ESTOP_TRIGGERED",
        "(?i).*(e.?brake|emergency.?stop|e.?stop|safety.?stop|estop).*",
    ),
    (
        "SENSOR_DROPOUT",
        "(?i).*(dropout|no data for|sensor.lost|not receiving|stale.scan).*",
    ),
    (
        "OBSTACLE_PROXIMITY",
        "(?i).*(proximity.*exceed|obstacle.*detected|too.?close|collision.?risk).*",
    ),
    (
        "PLANNER_FAILURE",
        "(?i).*(planner.*abort|no.valid.path|goal.*abort|planner.*fail).*",
    ),
    (
        "RECOVERY_TRIGGERED",
        "(?i).*(recovery.*triggered|clear.?costmap|rotate.?recovery).*",
    ),
]

_EVIDENCE_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
WHERE l.msg =~ $pattern
RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
       l.severity AS severity, l.msg AS msg
ORDER BY l.ts
LIMIT 5
"""


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    session_id = args["session_id"]
    results = []

    for rule_name, pattern in _RULES:
        try:
            evidence = run_cypher(
                _EVIDENCE_CYPHER,
                {"session_id": session_id, "pattern": pattern},
            )
            results.append({
                "rule": rule_name,
                "triggered": len(evidence) > 0,
                "evidence": evidence,
            })
        except Exception as exc:
            results.append({
                "rule": rule_name,
                "triggered": False,
                "error": str(exc),
            })

    return {"ok": True, "result": results}
