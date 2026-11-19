"""
Traverse upstream causal edges (CAUSED, TRIGGERED) from a given log event,
returning the chain in time order. This is THE high-value RCA tool — it pulls
the structured causal graph the Phase 3 rules engine built at ingestion.
"""
from __future__ import annotations

from typing import Any

from app.services.causal_rules import log_time_to_seconds
from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "planner_failure_inspector"
NAME = "query_causal_chain"
DESCRIPTION = (
    "Walk CAUSED/TRIGGERED edges upstream from a given log_id to surface the "
    "full causal chain that led to it."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "event_log_id": {"type": "string"},
        "max_hops": {"type": "integer", "default": 6, "minimum": 1, "maximum": 10},
    },
    "required": ["session_id", "event_log_id"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    max_hops = int(args.get("max_hops", 6))
    cypher = f"""
    MATCH (s:Session {{id: $session_id}})-[:HAS_LOG]->(target:Log {{id: $event_log_id}})
    MATCH path = (source:Log)-[r:CAUSED|TRIGGERED*0..{max_hops}]->(target)
    UNWIND nodes(path) AS n
    UNWIND relationships(path) AS rel
    RETURN DISTINCT
      n.id AS log_id,
      n.ts AS ts,
      n.node AS node,
      n.severity AS severity,
      n.msg AS msg,
      type(rel) AS edge_type,
      rel.lag_ms AS lag_ms,
      rel.confidence AS confidence
    """
    results = run_cypher(
        cypher,
        {"session_id": args["session_id"], "event_log_id": args["event_log_id"]},
    )

    # Order by time (the Neo4j DISTINCT didn't preserve sort).
    results.sort(key=lambda x: log_time_to_seconds(x.get("ts", "0")))
    return {"ok": True, "result": results}
