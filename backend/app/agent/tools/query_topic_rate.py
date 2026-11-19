"""Return the stored publish rate (Hz) and message count for a topic in a session."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "trajectory_analyzer"
NAME = "query_topic_rate"
DESCRIPTION = (
    "Return the average publish rate (Hz) and total message count for a topic "
    "in this session, as recorded during bag ingestion."
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "session_id": {"type": "string"},
        "topic": {"type": "string"},
        "bucket_s": {"type": "number", "default": 1.0},
    },
    "required": ["session_id", "topic"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_TOPIC]->(t:Topic {name: $topic})
    RETURN t.name AS topic, t.hz AS hz, t.total_messages AS msgs, t.type AS msg_type
    """
    results = run_cypher(
        cypher,
        {"session_id": args["session_id"], "topic": args["topic"]},
    )
    return {"ok": True, "result": results}
