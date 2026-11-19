"""Retrieve diagnostics and performance log entries for a specific ROS node."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "anomaly_detector"
NAME = "compute_node_cpu"
DESCRIPTION = (
    "Retrieve /diagnostics and performance-related log entries "
    "(CPU, latency, Hz, memory, throttling) for a specific ROS node."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "node": {"type": "string"},
    },
    "required": ["session_id", "node"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.node = $node
      AND (l.msg =~ '(?i).*(cpu|latency|hz|overhead|memory|throttl|perf|load|usage).*'
           OR l.topic = '/diagnostics'
           OR l.severity IN ['ERROR', 'FATAL'])
    RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
           l.severity AS severity, l.msg AS msg, l.topic AS topic
    ORDER BY l.ts
    LIMIT 200
    """
    results = run_cypher(
        cypher,
        {"session_id": args["session_id"], "node": args["node"]},
    )
    return {"ok": True, "result": results}
