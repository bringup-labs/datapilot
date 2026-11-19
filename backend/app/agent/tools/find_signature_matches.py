"""Match a named anomaly signature against session logs and anomaly nodes."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "anomaly_detector"
NAME = "find_signature_matches"
DESCRIPTION = (
    "Match a named anomaly signature against the session. Built-in signatures: "
    "lidar_dropout, odom_drift, nav_abort, sensor_timeout, recovery_loop, estop, "
    "obstacle_proximity. Returns matching log + anomaly records."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "signature_id": {"type": "string"},
    },
    "required": ["session_id", "signature_id"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}

# Map signature_id → regex fragment applied to log.msg
_SIGNATURES: dict[str, str] = {
    "lidar_dropout":       "(?i).*(lidar|laser|scan|pointcloud|point_cloud).*dropout|dropout.*(lidar|laser|scan).*",
    "odom_drift":          "(?i).*(drift|odometry|odom.*diverge|wheel.?slip|transform.*exceed).*",
    "nav_abort":           "(?i).*(abort|aborted|planner.fail|no.valid.path|goal.*fail).*",
    "sensor_timeout":      "(?i).*(timeout|no data for|stale|not receiving|heartbeat).*",
    "recovery_loop":       "(?i).*(recovery|clear.?costmap|rotate.?recovery|oscillation).*",
    "estop":               "(?i).*(e.?brake|emergency.?stop|e.?stop|safety.?stop).*",
    "obstacle_proximity":  "(?i).*(proximity|obstacle.*detected|too.?close|0\\.[012][0-9]m).*",
}

_FALLBACK_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_ANOMALY]->(a:Anomaly)
RETURN a.id AS id, a.t AS t, a.kind AS kind,
       a.severity AS severity, a.label AS label, a.topic AS topic
ORDER BY a.t
"""

_LOG_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
WHERE l.msg =~ $pattern
RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
       l.severity AS severity, l.msg AS msg, l.topic AS topic
ORDER BY l.ts
LIMIT 100
"""


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    session_id = args["session_id"]
    sig_id = (args.get("signature_id") or "").lower().strip()

    pattern = _SIGNATURES.get(sig_id)
    if not pattern:
        # Unknown signature — return all anomaly nodes so the specialist still
        # has something to work with.
        results = run_cypher(_FALLBACK_CYPHER, {"session_id": session_id})
        return {"ok": True, "result": results, "note": f"Unknown signature '{sig_id}'; returned all anomalies."}

    results = run_cypher(_LOG_CYPHER, {"session_id": session_id, "pattern": pattern})
    return {"ok": True, "result": results}
