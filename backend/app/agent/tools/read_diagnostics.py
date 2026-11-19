"""Retrieve /diagnostics log entries for a session in an optional time window."""
from __future__ import annotations

from typing import Any

from app.services.causal_rules import log_time_to_seconds
from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "rosbag_reader"
NAME = "read_diagnostics"
DESCRIPTION = (
    "Retrieve /diagnostics topic log entries and diagnostic-related messages "
    "(hardware alerts, sensor faults) within an optional time window."
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


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.topic = '/diagnostics'
       OR l.msg =~ '(?i).*(diagnostic|hardware.alert|sensor.fault|hardware.error).*'
    RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
           l.severity AS severity, l.msg AS msg, l.topic AS topic
    ORDER BY l.ts
    """
    results = run_cypher(cypher, {"session_id": args["session_id"]})

    # Apply optional time window.
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
