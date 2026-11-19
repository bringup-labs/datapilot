"""Return the TF frame parent/child relationships for the session."""
from __future__ import annotations

from typing import Any

from app.agent.tools._neo4j import neo4j_tool, run_cypher

WORKER = "rosbag_reader"
NAME = "read_tf_chain"
DESCRIPTION = "Return the TF frame hierarchy (parent → child relationships) for the session."

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"session_id": {"type": "string"}},
    "required": ["session_id"],
}

OUTPUT_SCHEMA: dict[str, Any] = {"type": "array"}


@neo4j_tool
def run(args: dict[str, Any]) -> dict[str, Any]:
    cypher = """
    MATCH (f:Frame {session_id: $session_id})-[:CHILD_OF]->(p:Frame {session_id: $session_id})
    RETURN f.name AS child, p.name AS parent
    """
    results = run_cypher(cypher, {"session_id": args["session_id"]})
    return {"ok": True, "result": results}
