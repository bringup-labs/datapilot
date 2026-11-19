"""Detect statistically abnormal log events for a topic using inter-message timing gaps."""
from __future__ import annotations

import math
from typing import Any

from app.services.causal_rules import log_time_to_seconds
from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "anomaly_detector"
NAME = "find_statistical_outliers"
DESCRIPTION = (
    "Find statistically abnormal log events for a topic by computing z-scores on "
    "inter-message timing gaps. Returns logs whose gaps exceed the threshold."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "topic": {"type": "string"},
        "field": {"type": "string"},
        "method": {"type": "string", "enum": ["zscore", "iqr"], "default": "zscore"},
        "threshold": {"type": "number", "default": 3.0},
    },
    "required": ["session_id", "topic"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


def _zscore_outliers(values: list[float], threshold: float) -> list[int]:
    if len(values) < 3:
        return []
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    std = math.sqrt(variance) if variance > 0 else 0.0
    if std == 0:
        return []
    return [i for i, v in enumerate(values) if abs(v - mean) / std > threshold]


def _iqr_outliers(values: list[float], threshold: float) -> list[int]:
    if len(values) < 4:
        return []
    sorted_v = sorted(values)
    n = len(sorted_v)
    q1 = sorted_v[n // 4]
    q3 = sorted_v[(3 * n) // 4]
    iqr = q3 - q1
    if iqr == 0:
        return []
    fence = threshold * iqr
    return [i for i, v in enumerate(values) if v < q1 - fence or v > q3 + fence]


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.topic = $topic
    RETURN l.id AS log_id, l.ts AS ts, l.node AS node,
           l.severity AS severity, l.msg AS msg
    ORDER BY l.ts
    """
    rows = run_cypher(
        cypher,
        {"session_id": args["session_id"], "topic": args["topic"]},
    )

    if len(rows) < 2:
        return {"ok": True, "result": []}

    # Compute inter-message gaps in seconds.
    timestamps = [log_time_to_seconds(r["ts"]) for r in rows]
    gaps = [timestamps[i + 1] - timestamps[i] for i in range(len(timestamps) - 1)]

    method = args.get("method", "zscore")
    threshold = float(args.get("threshold", 3.0))

    if method == "iqr":
        outlier_indices = _iqr_outliers(gaps, threshold)
    else:
        outlier_indices = _zscore_outliers(gaps, threshold)

    # Each outlier index i refers to the gap between rows[i] and rows[i+1].
    # Return the later log (rows[i+1]) as the anomalous event.
    results = []
    seen = set()
    for i in outlier_indices:
        idx = i + 1
        if idx < len(rows) and idx not in seen:
            seen.add(idx)
            row = dict(rows[idx])
            row["gap_s"] = round(gaps[i], 4)
            results.append(row)

    return {"ok": True, "result": results}
