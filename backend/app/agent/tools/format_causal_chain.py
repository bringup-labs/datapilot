"""Format the full session causal chain as a tree using box-drawing characters."""
from __future__ import annotations

from typing import Any

from app.services.causal_rules import log_time_to_seconds
from app.services.neo4j_client import neo4j_client

WORKER = "report_composer"
NAME = "format_causal_chain"
DESCRIPTION = (
    "Query all CAUSED/TRIGGERED edges for the session and format the causal chain "
    "as a tree using box-drawing characters (┌─, ├─, └─, │). "
    "Returns the formatted tree string plus the raw node list."
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

# Find all causal edges for a session — collect both endpoints so we can build
# a parent→children adjacency map and root nodes (no incoming edges).
_EDGE_CYPHER = """
MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(src:Log)
MATCH (src)-[r:CAUSED|TRIGGERED]->(dst:Log)
RETURN src.id AS src_id, src.ts AS src_ts, src.node AS src_node,
       src.severity AS src_sev, src.msg AS src_msg,
       dst.id AS dst_id, dst.ts AS dst_ts, dst.node AS dst_node,
       dst.severity AS dst_sev, dst.msg AS dst_msg,
       type(r) AS edge_type
ORDER BY src.ts
"""


def _truncate(msg: str | None, n: int = 60) -> str:
    if not msg:
        return ""
    return msg[:n] + "…" if len(msg) > n else msg


# CAUSED/TRIGGERED edges come from heuristics and are not guaranteed acyclic,
# and a long bag can chain thousands of logs. The renderer is iterative, marks
# a node that is already on the current path instead of following it again, and
# stops descending past this depth (#58).
_MAX_DEPTH = 64


def _render_tree(
    node_id: str,
    children: dict[str, list[str]],
    nodes: dict[str, dict[str, Any]],
    prefix: str = "",
    is_last: bool = True,
    ancestors: frozenset[str] = frozenset(),
    seen: set[str] | None = None,
) -> list[str]:
    lines: list[str] = []
    on_path: set[str] = set(ancestors)
    # ("enter" | "exit", node id, prefix, is_last, depth)
    stack: list[tuple[str, str, str, bool, int]] = [("enter", node_id, prefix, is_last, 1)]
    while stack:
        kind, nid, pfx, last, depth = stack.pop()
        if kind == "exit":
            on_path.discard(nid)
            continue

        n = nodes.get(nid)
        connector = "└─ " if last else "├─ "
        label = f"[{n['severity']}] {n['node']}: {_truncate(n['msg'])}" if n else nid
        if nid in on_path:
            lines.append(pfx + connector + label + " (cycle: already shown above)")
            continue
        lines.append(pfx + connector + label)
        if seen is not None:
            seen.add(nid)

        extension = "   " if last else "│  "
        kids = children.get(nid, [])
        if kids and depth >= _MAX_DEPTH:
            lines.append(pfx + extension + "└─ … (deeper levels not shown)")
            continue
        on_path.add(nid)
        stack.append(("exit", nid, "", True, depth))
        for i in range(len(kids) - 1, -1, -1):
            stack.append(("enter", kids[i], pfx + extension, i == len(kids) - 1, depth + 1))
    return lines


def run(args: dict[str, Any]) -> dict[str, Any]:
    session_id = args["session_id"]

    try:
        edges = neo4j_client.run_query(_EDGE_CYPHER, {"session_id": session_id})
    except Exception as exc:
        return {"ok": False, "error": {"code": "neo4j_failed", "message": str(exc), "retryable": True}}

    if not edges:
        return {"ok": True, "result": [{"tree": "(no causal relationships found)", "nodes": []}]}

    # Build adjacency map and node registry.
    children: dict[str, list[str]] = {}
    nodes: dict[str, dict[str, Any]] = {}
    all_dst: set[str] = set()

    for e in edges:
        src, dst = e["src_id"], e["dst_id"]
        nodes.setdefault(src, {"severity": e["src_sev"], "node": e["src_node"], "msg": e["src_msg"], "ts": e["src_ts"]})
        nodes.setdefault(dst, {"severity": e["dst_sev"], "node": e["dst_node"], "msg": e["dst_msg"], "ts": e["dst_ts"]})
        children.setdefault(src, [])
        if dst not in children[src]:
            children[src].append(dst)
        all_dst.add(dst)

    # Root nodes = nodes with no incoming edge (appear as src but not dst).
    roots = [nid for nid in nodes if nid not in all_dst]
    # Sort roots by timestamp.
    roots.sort(key=lambda nid: log_time_to_seconds(nodes[nid].get("ts", "0")))

    lines: list[str] = []
    seen: set[str] = set()

    def _render_root(root: str) -> None:
        if lines:
            lines.append("")
        root_node = nodes[root]
        lines.append(f"┌─ [{root_node['severity']}] {root_node['node']}: {_truncate(root_node['msg'])}")
        seen.add(root)
        kids = children.get(root, [])
        for j, kid in enumerate(kids):
            lines.extend(
                _render_tree(
                    kid, children, nodes,
                    prefix="",
                    is_last=(j == len(kids) - 1),
                    ancestors=frozenset({root}),
                    seen=seen,
                )
            )

    for root in roots:
        _render_root(root)
    # A group of logs that only cause each other has no root. Start it from its
    # earliest log so it is still shown.
    for nid in sorted(nodes, key=lambda nid: log_time_to_seconds(nodes[nid].get("ts", "0"))):
        if nid not in seen:
            _render_root(nid)

    tree_str = "\n".join(lines)
    raw_nodes = sorted(nodes.values(), key=lambda n: log_time_to_seconds(n.get("ts", "0")))
    return {"ok": True, "result": [{"tree": tree_str, "nodes": raw_nodes}]}
