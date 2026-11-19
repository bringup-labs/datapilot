"""Compare log severity distributions and anomaly counts between two sessions."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "anomaly_detector"
NAME = "compare_log_signatures"
DESCRIPTION = (
    "Compare log severity distributions (DEBUG/INFO/WARN/ERROR/FATAL counts) "
    "and anomaly counts between two sessions."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id_a": {"type": "string"},
        "session_id_b": {"type": "string"},
    },
    "required": ["session_id_a", "session_id_b"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}

_SEVERITY_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
RETURN l.severity AS severity, count(l) AS count
ORDER BY severity
"""

_ANOMALY_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_ANOMALY]->(a:Anomaly)
RETURN a.severity AS severity, count(a) AS count
ORDER BY severity
"""


def _collect(session_id: str) -> dict[str, Any]:
    sev_rows = run_cypher(_SEVERITY_CYPHER, {"session_id": session_id})
    anom_rows = run_cypher(_ANOMALY_CYPHER, {"session_id": session_id})
    return {
        "log_severity": {r["severity"] or "UNKNOWN": r["count"] for r in sev_rows},
        "anomaly_severity": {r["severity"] or "UNKNOWN": r["count"] for r in anom_rows},
        "total_logs": sum(r["count"] for r in sev_rows),
        "total_anomalies": sum(r["count"] for r in anom_rows),
    }


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    stats_a = _collect(args["session_id_a"])
    stats_b = _collect(args["session_id_b"])

    # Build comparison rows — one per severity level.
    all_sevs = sorted(
        set(stats_a["log_severity"]) | set(stats_b["log_severity"])
    )
    rows = []
    for sev in all_sevs:
        a = stats_a["log_severity"].get(sev, 0)
        b = stats_b["log_severity"].get(sev, 0)
        rows.append({
            "severity": sev,
            "count_a": a,
            "count_b": b,
            "delta": a - b,
        })

    summary = {
        "session_a": {
            "id": args["session_id_a"],
            "total_logs": stats_a["total_logs"],
            "total_anomalies": stats_a["total_anomalies"],
        },
        "session_b": {
            "id": args["session_id_b"],
            "total_logs": stats_b["total_logs"],
            "total_anomalies": stats_b["total_anomalies"],
        },
        "severity_comparison": rows,
    }
    return {"ok": True, "result": [summary]}
