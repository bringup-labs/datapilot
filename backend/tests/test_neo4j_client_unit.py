"""Unit coverage for app.services.neo4j_client.Neo4jClient.

All tests use a MOCKED driver — no real Neo4j connection, no network. We build a
fresh Neo4jClient instance (not the patched global singleton) so the real method
bodies run, then assert the Cypher text and params handed to session.run(), plus
the write-routing/short-circuit logic.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services.neo4j_client import Neo4jClient


@pytest.fixture
def client_and_session():
    """A real Neo4jClient with its driver/session fully mocked.

    Returns (client, session_mock). The session mock is what `with
    self.driver.session() as session:` yields, so session_mock.run captures
    every Cypher call.
    """
    # Patch GraphDatabase.driver so __init__ does not open a real connection.
    with patch("app.services.neo4j_client.GraphDatabase.driver") as drv_factory:
        drv_factory.return_value = MagicMock(name="driver")
        client = Neo4jClient()

    session_mock = MagicMock(name="session")
    # `with driver.session() as session:` → __enter__ returns session_mock.
    cm = MagicMock()
    cm.__enter__.return_value = session_mock
    cm.__exit__.return_value = False
    client.driver = MagicMock(name="driver")
    client.driver.session.return_value = cm
    return client, session_mock


# ---------------------------------------------------------------------------
# run_query
# ---------------------------------------------------------------------------

class TestRunQuery:
    def test_passes_query_and_params_and_maps_records(self, client_and_session):
        client, session = client_and_session
        rec1, rec2 = MagicMock(), MagicMock()
        rec1.data.return_value = {"a": 1}
        rec2.data.return_value = {"a": 2}
        session.run.return_value = [rec1, rec2]

        out = client.run_query("MATCH (n) RETURN n", {"x": 5})

        session.run.assert_called_once_with("MATCH (n) RETURN n", {"x": 5})
        assert out == [{"a": 1}, {"a": 2}]

    def test_none_params_become_empty_dict(self, client_and_session):
        client, session = client_and_session
        session.run.return_value = []
        client.run_query("RETURN 1")
        # Second positional arg must be {} not None.
        args, _ = session.run.call_args
        assert args[0] == "RETURN 1"
        assert args[1] == {}


# ---------------------------------------------------------------------------
# close
# ---------------------------------------------------------------------------

class TestClose:
    def test_close_delegates_to_driver(self, client_and_session):
        client, _ = client_and_session
        client.close()
        client.driver.close.assert_called_once_with()


# ---------------------------------------------------------------------------
# create_session_node
# ---------------------------------------------------------------------------

class TestCreateSessionNode:
    def test_cypher_and_params(self, client_and_session):
        client, session = client_and_session
        client.create_session_node("sess-1", "run.mcap", "ARES-04", 128.0, "2026-01-01T00:00:00")
        query, params = session.run.call_args[0]
        assert "CREATE (s:Session" in query
        assert params == {
            "session_id": "sess-1",
            "filename": "run.mcap",
            "robot_id": "ARES-04",
            "duration_s": 128.0,
            "started_at": "2026-01-01T00:00:00",
        }


# ---------------------------------------------------------------------------
# write_logs / write_topics
# ---------------------------------------------------------------------------

class TestWriteLogs:
    def test_maps_parser_fields_in_params(self, client_and_session):
        client, session = client_and_session
        logs = [{"id": "l_1", "t": "00:00:01.0", "sev": "ERROR",
                 "node": "/move_base", "text": "boom", "topic": "/rosout"}]
        client.write_logs("sess-1", logs)
        query, params = session.run.call_args[0]
        assert "CREATE (l:Log" in query
        # Cypher maps mock fields (t/sev/text) to schema fields (ts/severity/msg).
        assert "ts: log_data.t" in query
        assert "severity: log_data.sev" in query
        assert "msg: log_data.text" in query
        # Numeric sort key (issue #70) and session ownership (issue #68) are
        # persisted on every Log node.
        assert "t_sec: log_data.t_sec" in query
        assert "session_id: $session_id" in query
        assert params == {"session_id": "sess-1", "logs_list": logs}

    def test_empty_logs_still_runs_unwind(self, client_and_session):
        # write_logs has no early return — an empty list is passed through.
        client, session = client_and_session
        client.write_logs("sess-1", [])
        _, params = session.run.call_args[0]
        assert params == {"session_id": "sess-1", "logs_list": []}


class TestWriteTopics:
    def test_cypher_and_params(self, client_and_session):
        client, session = client_and_session
        topics = [{"name": "/scan", "type": "sensor_msgs/LaserScan", "hz": 10.0, "msgs": 100}]
        client.write_topics("sess-1", topics)
        query, params = session.run.call_args[0]
        assert "CREATE (t:Topic" in query
        assert "total_messages: topic_data.msgs" in query
        assert params == {"session_id": "sess-1", "topics_list": topics}


# ---------------------------------------------------------------------------
# write_sensors / write_diagnostics short-circuits
# ---------------------------------------------------------------------------

class TestWriteSensors:
    def test_empty_short_circuits_no_session(self, client_and_session):
        client, session = client_and_session
        client.write_sensors("sess-1", [])
        session.run.assert_not_called()
        client.driver.session.assert_not_called()

    def test_writes_sensor_payload(self, client_and_session):
        client, session = client_and_session
        sensors = [{"id": "s_1", "name": "lidar_a", "topic": "/sensors/lidar_a",
                    "type": "LiDAR", "msg_type": "sensor_msgs/LaserScan"}]
        client.write_sensors("sess-1", sensors)
        query, params = session.run.call_args[0]
        assert "CREATE (sen:Sensor" in query
        assert "[:HAS_SENSOR]" in query
        assert params == {"session_id": "sess-1", "sensors_list": sensors}


class TestWriteDiagnostics:
    def test_empty_short_circuits(self, client_and_session):
        client, session = client_and_session
        client.write_diagnostics("sess-1", [])
        session.run.assert_not_called()

    def test_links_to_sensor_in_cypher(self, client_and_session):
        client, session = client_and_session
        diags = [{"id": "d_1", "t": "0", "level": "ERROR", "name": "lidar",
                  "message": "down", "hardware_id": "hw", "values_json": "{}",
                  "topic": "/diagnostics"}]
        client.write_diagnostics("sess-1", diags)
        # #75: write_diagnostics now issues TWO statements — first create all
        # DiagnosticStatus nodes, then a separate MATCH/MERGE for REPORTS_ON.
        assert session.run.call_count == 2
        create_query, create_params = session.run.call_args_list[0][0]
        link_query, link_params = session.run.call_args_list[1][0]
        # Statement 1: create the nodes (no relationship linking yet).
        assert "CREATE (d:DiagnosticStatus" in create_query
        assert "[:REPORTS_ON]" not in create_query
        # Statement 2: link to sensors via MERGE (idempotent, separate MATCH).
        assert "[:REPORTS_ON]" in link_query
        assert "MERGE (d)-[:REPORTS_ON]->(sen)" in link_query
        # The DiagnosticStatus node is reached by traversing HAS_DIAGNOSTIC from
        # the already-bound Session, NOT by a global label scan on its id —
        # there is no index on DiagnosticStatus(id|session_id), so a bare
        # `MATCH (d:DiagnosticStatus {id: ...})` would scan every diagnostic.
        assert "(s)-[:HAS_DIAGNOSTIC]->(d:DiagnosticStatus {id: diag_data.id})" in link_query
        assert "MATCH (d:DiagnosticStatus {id: diag_data.id, session_id: $session_id})" not in link_query
        # #75: the loose CONTAINS over-matched (sensor `imu` ⊂ `minimum_voltage`).
        # The corrected query must NOT use CONTAINS — matching is exact now.
        assert "CONTAINS" not in create_query
        assert "CONTAINS" not in link_query
        # Both statements carry the same params.
        assert create_params == {"session_id": "sess-1", "diagnostics_list": diags}
        assert link_params == {"session_id": "sess-1", "diagnostics_list": diags}


# ---------------------------------------------------------------------------
# write_anomalies short-circuit + DERIVED_FROM
# ---------------------------------------------------------------------------

class TestWriteAnomalies:
    def test_empty_short_circuits(self, client_and_session):
        client, session = client_and_session
        client.write_anomalies("sess-1", [])
        session.run.assert_not_called()

    def test_derived_from_edge_in_cypher(self, client_and_session):
        client, session = client_and_session
        anomalies = [{"id": "a_1", "t": 1.0, "kind": "dropout", "severity": "critical",
                      "source_log_id": "l_1", "confidence": 1.0, "topic": "/x", "label": "boom"}]
        client.write_anomalies("sess-1", anomalies)
        query, params = session.run.call_args[0]
        assert "CREATE (anomaly:Anomaly" in query
        assert "[:DERIVED_FROM]" in query
        assert params == {"session_id": "sess-1", "anomalies_list": anomalies}


# ---------------------------------------------------------------------------
# write_frames
# ---------------------------------------------------------------------------

class TestWriteFrames:
    def test_merge_child_of_cypher(self, client_and_session):
        client, session = client_and_session
        frames = [{"name": "base_link", "parent": "odom"}]
        client.write_frames("sess-1", frames)
        query, params = session.run.call_args[0]
        assert "MERGE (f:Frame" in query
        assert "[:CHILD_OF]" in query
        assert params == {"session_id": "sess-1", "frames_list": frames}


# ---------------------------------------------------------------------------
# write_edges routing by type
# ---------------------------------------------------------------------------

class TestWriteEdges:
    def _edge(self, etype, src="l_1", tgt="l_2"):
        return {
            "source_id": src,
            "target_id": tgt,
            "type": etype,
            "properties": {"rule_id": "r", "confidence": 0.9, "lag_ms": 100},
        }

    def test_routes_each_type_to_its_own_query(self, client_and_session):
        client, session = client_and_session
        edges = [
            self._edge("CAUSED"),
            self._edge("TRIGGERED"),
            self._edge("CONCURRENT_WITH"),
        ]
        client.write_edges(edges)
        # Three separate session.run calls, one per non-empty type bucket.
        assert session.run.call_count == 3
        queries = [c[0][0] for c in session.run.call_args_list]
        assert any("r:CAUSED" in q for q in queries)
        assert any("r:TRIGGERED" in q for q in queries)
        assert any("r:CONCURRENT_WITH" in q for q in queries)

    def test_only_present_types_issue_queries(self, client_and_session):
        client, session = client_and_session
        client.write_edges([self._edge("CAUSED"), self._edge("CAUSED")])
        # Only the CAUSED bucket is non-empty → single run call.
        assert session.run.call_count == 1
        query, params = session.run.call_args[0]
        assert "r:CAUSED" in query
        assert len(params["edges_list"]) == 2

    def test_empty_edges_issues_no_queries(self, client_and_session):
        client, session = client_and_session
        client.write_edges([])
        session.run.assert_not_called()

    def test_concurrent_only_payload(self, client_and_session):
        client, session = client_and_session
        client.write_edges([self._edge("CONCURRENT_WITH")])
        assert session.run.call_count == 1
        query, _ = session.run.call_args[0]
        assert "r:CONCURRENT_WITH" in query
        # CONCURRENT_WITH query carries only lag_ms, not rule_id/confidence.
        assert "rule_id" not in query


# ---------------------------------------------------------------------------
# init_indexes
# ---------------------------------------------------------------------------

class TestInitIndexes:
    def test_creates_indexes_and_vector_with_dimension(self, client_and_session):
        client, session = client_and_session
        # SHOW INDEXES returns no existing vector index.
        session.run.return_value = []
        client.init_indexes(embedding_dim=384)
        all_cypher = " || ".join(c[0][0] for c in session.run.call_args_list)
        assert "CREATE INDEX log_ts_idx" in all_cypher
        assert "CREATE FULLTEXT INDEX log_msg_fulltext" in all_cypher
        assert "CREATE VECTOR INDEX log_embedding_idx" in all_cypher
        # The requested dimension is interpolated into the vector index config.
        assert "`vector.dimensions`: 384" in all_cypher
        # Globally-unique Log identity (issue #68): a uniqueness constraint on
        # Log.id stops cross-session id collisions from ever recurring.
        assert "CONSTRAINT" in all_cypher
        assert "(n:Log) REQUIRE n.id IS UNIQUE" in all_cypher

    def test_drops_vector_index_when_dimension_changed(self, client_and_session):
        client, session = client_and_session
        existing = MagicMock()
        existing.__getitem__.side_effect = lambda k: {"name": "log_embedding_idx"}[k]
        existing.get.return_value = {"indexConfig": {"vector.dimensions": 1536}}

        # init_indexes calls session.run several times; only the SHOW INDEXES
        # result needs to be iterable with our fake record. Return the record
        # list for SHOW INDEXES and an empty list for everything else.
        def run_side_effect(query, *a, **k):
            if "SHOW INDEXES" in query:
                return [existing]
            return []

        session.run.side_effect = run_side_effect
        client.init_indexes(embedding_dim=384)  # 384 != existing 1536 → drop
        issued = [c[0][0] for c in session.run.call_args_list]
        assert any("DROP INDEX log_embedding_idx" in q for q in issued)

    def test_no_drop_when_dimension_matches(self, client_and_session):
        client, session = client_and_session
        existing = MagicMock()
        existing.__getitem__.side_effect = lambda k: {"name": "log_embedding_idx"}[k]
        existing.get.return_value = {"indexConfig": {"vector.dimensions": 384}}

        def run_side_effect(query, *a, **k):
            if "SHOW INDEXES" in query:
                return [existing]
            return []

        session.run.side_effect = run_side_effect
        client.init_indexes(embedding_dim=384)  # matches → no drop
        issued = [c[0][0] for c in session.run.call_args_list]
        assert not any("DROP INDEX" in q for q in issued)


# ---------------------------------------------------------------------------
# clear_session
# ---------------------------------------------------------------------------

class TestClearSession:
    def test_detach_delete_cypher_and_param(self, client_and_session):
        client, session = client_and_session
        client.clear_session("sess-1")
        query, params = session.run.call_args[0]
        assert "DETACH DELETE" in query
        assert "MATCH (s:Session {id: $session_id})" in query
        assert params == {"session_id": "sess-1"}

    def test_deletes_orphaned_fact_nodes(self, client_and_session):
        # #72: re-ingesting a session must not orphan its Fact nodes. The query
        # must OPTIONAL MATCH the HAS_FACT->(:Fact) chain and DETACH DELETE it.
        client, session = client_and_session
        client.clear_session("sess-1")
        query, _ = session.run.call_args[0]
        assert "(s)-[:HAS_FACT]->(fact:Fact)" in query
        # The Fact binding must be included in the DETACH DELETE clause.
        detach_clause = query.split("DETACH DELETE", 1)[1]
        assert "fact" in detach_clause


# ---------------------------------------------------------------------------
# write_facts (dedup/prep logic)
# ---------------------------------------------------------------------------

class TestWriteFacts:
    def test_empty_short_circuits(self, client_and_session):
        client, session = client_and_session
        client.write_facts("sess-1", [])
        session.run.assert_not_called()

    def test_blank_text_facts_are_dropped(self, client_and_session):
        client, session = client_and_session
        # All facts have empty/whitespace text → prepared list empty → no run.
        client.write_facts("sess-1", [{"text": "  "}, {"text": ""}])
        session.run.assert_not_called()

    def test_runs_three_queries_and_fills_defaults(self, client_and_session):
        client, session = client_and_session
        client.write_facts("sess-1", [{"text": "robot stopped"}], turn_index=3)
        # create_q, mentions_q, cites_q → three runs.
        assert session.run.call_count == 3
        # Every call shares the same params dict (session_id + prepared facts).
        _, params = session.run.call_args_list[0][0]
        assert params["session_id"] == "sess-1"
        assert params["turn_index"] == 3
        fact = params["facts"][0]
        assert fact["text"] == "robot stopped"
        assert fact["category"] == "general"   # default
        assert fact["severity"] == "info"      # default
        assert fact["id"].startswith("fact_")  # generated id
        assert fact["entities"] == []
        assert fact["log_ids"] == []


# ---------------------------------------------------------------------------
# get_facts_graph (shaping rows into nodes/edges)
# ---------------------------------------------------------------------------

class TestGetFactsGraph:
    def test_shapes_rows_into_nodes_and_edges(self, client_and_session):
        client, session = client_and_session
        rec = MagicMock()
        rec.data.return_value = {
            "id": "fact_1",
            "text": "lidar dropout caused abort",
            "category": "rca",
            "severity": "critical",
            "topics": ["/scan"],
            "sensors": ["lidar_a"],
            "log_nodes": ["/move_base"],
        }
        session.run.return_value = [rec]

        graph = client.get_facts_graph("sess-1")
        assert len(graph["nodes"]) == 1
        node = graph["nodes"][0]
        assert node["id"] == "fact_1"
        assert node["group"] == "fact"
        assert node["meta"]["severity"] == "critical"
        # One edge per topic/sensor/log_node, prefixed by kind.
        assert ["fact_1", "topic_/scan"] in graph["edges"]
        assert ["fact_1", "sensor_lidar_a"] in graph["edges"]
        assert ["fact_1", "node_/move_base"] in graph["edges"]

    def test_empty_rows_yield_empty_graph(self, client_and_session):
        client, session = client_and_session
        session.run.return_value = []
        graph = client.get_facts_graph("sess-1")
        assert graph == {"nodes": [], "edges": []}


class TestInitIndexesDefaultDimension:
    def test_default_dimension_follows_the_active_embedder(self, client_and_session, monkeypatch):
        """#84: a default-built vector index must match the vectors written to it.

        With no OpenAI key the embedder is MiniLM (384 dims); the old hardcoded
        1536 default built an index no written vector could match.
        """
        from app.services.embeddings import embedding_service

        client, session = client_and_session
        session.run.return_value = []
        monkeypatch.setattr(embedding_service, "get_embedding_dimension", lambda: 384)

        client.init_indexes()

        all_cypher = " || ".join(c[0][0] for c in session.run.call_args_list)
        assert "`vector.dimensions`: 384" in all_cypher
        assert "1536" not in all_cypher
