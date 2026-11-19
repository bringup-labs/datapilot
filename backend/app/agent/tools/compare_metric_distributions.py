"""Compare topic publish rates and message counts between two sessions."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "anomaly_detector"
NAME = "compare_metric_distributions"
DESCRIPTION = (
    "Compare topic publish rates (Hz) and message counts between two sessions. "
    "Returns per-topic stats side-by-side with a delta column."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id_a": {"type": "string"},
        "session_id_b": {"type": "string"},
        "metric": {"type": "string"},
    },
    "required": ["session_id_a", "session_id_b"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s1:Session {id: $session_id_a})-[:HAS_TOPIC]->(t1:Topic)
    OPTIONAL MATCH (s2:Session {id: $session_id_b})-[:HAS_TOPIC]->(t2:Topic {name: t1.name})
    RETURN t1.name      AS topic,
           t1.hz        AS hz_a,
           coalesce(t2.hz,   0.0) AS hz_b,
           t1.total_messages      AS msgs_a,
           coalesce(t2.total_messages, 0)   AS msgs_b,
           t1.type      AS msg_type
    ORDER BY topic
    """
    rows = run_cypher(
        cypher,
        {
            "session_id_a": args["session_id_a"],
            "session_id_b": args["session_id_b"],
        },
    )

    # Compute deltas in Python to avoid Cypher type-coercion issues.
    metric = args.get("metric", "hz").lower()
    results = []
    for r in rows:
        row = dict(r)
        if metric in ("hz", "rate"):
            a, b = float(r.get("hz_a") or 0), float(r.get("hz_b") or 0)
            row["delta"] = round(a - b, 3)
            row["delta_pct"] = round((a - b) / b * 100, 1) if b > 0 else None
        else:  # msgs / count
            a, b = int(r.get("msgs_a") or 0), int(r.get("msgs_b") or 0)
            row["delta"] = a - b
            row["delta_pct"] = round((a - b) / b * 100, 1) if b > 0 else None
        results.append(row)

    return {"ok": True, "result": results}
