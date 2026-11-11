"""Unit-level coverage for the sessions + mcp + health API surface.

These run against the real FastAPI app via `TestClient`, but with an **isolated
in-memory SQLite** swapped in for `get_db` so each test starts from a clean
schema and never touches the shared on-disk dev DB. Neo4j is already mocked
process-wide by the autouse `mock_neo4j` fixture in `conftest.py`, and the
ingestion background task is stubbed to a no-op so `create` exercises only the
endpoint's own DB write (no parser / embedding / network I/O).
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from app.main import app as fastapi_app
from app.db_sqlite import Base, get_db
import app.api.sessions as sessions_mod
import app.models  # noqa: F401  (ensures ORM tables register against Base)


# ── Isolated in-memory DB wired into the app via dependency override ────────


@pytest_asyncio.fixture
async def db_client(monkeypatch):
    """Yield a TestClient backed by a fresh in-memory SQLite for each test."""
    # A single shared in-memory connection (StaticPool keeps one connection so
    # the schema created here is visible to request handlers).
    from sqlalchemy.pool import StaticPool

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestSession = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def _override_get_db():
        async with TestSession() as session:
            yield session

    fastapi_app.dependency_overrides[get_db] = _override_get_db

    # Stub the background ingestion task so `create` does no parser/network I/O.
    async def _noop_ingestion(session_id, filepath):
        return None

    monkeypatch.setattr(sessions_mod, "run_ingestion", _noop_ingestion)

    client = TestClient(fastapi_app)
    try:
        yield client
    finally:
        fastapi_app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


# ── health ─────────────────────────────────────────────────────────────────


def test_health_endpoint(db_client):
    resp = db_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert {key: body[key] for key in ("status", "phase", "service")} == {
        "status": "ok", "phase": "3", "service": "datapilot-backend",
    }


# ── create ─────────────────────────────────────────────────────────────────


def test_create_session_returns_202_and_processing(db_client):
    resp = db_client.post("/api/sessions/create", json={"filepath": "/abs/path/lidar_failure.mcap"})
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "processing"
    assert body["filepath"] == "/abs/path/lidar_failure.mcap"
    # A uuid session id is allocated.
    assert isinstance(body["session_id"], str) and len(body["session_id"]) >= 32


def test_create_session_basenames_the_filename(db_client):
    # The record's filename should be the basename, not the full path.
    resp = db_client.post("/api/sessions/create", json={"filepath": "/some/deep/dir/run42.mcap"})
    session_id = resp.json()["session_id"]
    got = db_client.get(f"/api/sessions/{session_id}")
    assert got.status_code == 200
    assert got.json()["filename"] == "run42.mcap"
    assert got.json()["filepath"] == "/some/deep/dir/run42.mcap"


def test_create_session_handles_windows_path_basename(db_client):
    resp = db_client.post(
        "/api/sessions/create",
        json={"filepath": r"C:\\bags\\nav\\crash.db3"},
    )
    session_id = resp.json()["session_id"]
    got = db_client.get(f"/api/sessions/{session_id}")
    assert got.json()["filename"] == "crash.db3"


def test_create_session_missing_filepath_is_422(db_client):
    resp = db_client.post("/api/sessions/create", json={})
    assert resp.status_code == 422


# ── get ────────────────────────────────────────────────────────────────────


def test_get_session_returns_record(db_client):
    created = db_client.post("/api/sessions/create", json={"filepath": "bagA.mcap"}).json()
    sid = created["session_id"]
    resp = db_client.get(f"/api/sessions/{sid}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == sid
    assert body["filename"] == "bagA.mcap"
    assert body["status"] == "processing"
    # topics_list defaults to empty list when no topics_list column is set.
    assert body["topics_list"] == []


def test_get_session_unknown_id_returns_404(db_client):
    resp = db_client.get("/api/sessions/does-not-exist")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found"


# ── list ───────────────────────────────────────────────────────────────────


def test_list_sessions_empty_initially(db_client):
    resp = db_client.get("/api/sessions")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_sessions_returns_all_created(db_client):
    db_client.post("/api/sessions/create", json={"filepath": "one.mcap"})
    db_client.post("/api/sessions/create", json={"filepath": "two.mcap"})
    resp = db_client.get("/api/sessions")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2
    filenames = {s["filename"] for s in body}
    assert filenames == {"one.mcap", "two.mcap"}


# ── delete (single) ────────────────────────────────────────────────────────


def test_delete_session_removes_the_record(db_client):
    """Regression test for issue #62 (un-awaited delete).

    `delete_session` must `await db.delete(record)` so the row is staged and the
    following `await db.commit()` actually removes it. Otherwise the endpoint
    reports success while the session survives.
    """
    created = db_client.post("/api/sessions/create", json={"filepath": "todelete.mcap"}).json()
    sid = created["session_id"]

    resp = db_client.delete(f"/api/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "success"

    # The record is actually gone: a follow-up GET 404s.
    follow = db_client.get(f"/api/sessions/{sid}")
    assert follow.status_code == 404


def test_delete_session_unknown_id_returns_404(db_client):
    resp = db_client.delete("/api/sessions/nope")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Session not found"


def test_delete_session_calls_neo4j_clear(db_client, monkeypatch):
    # delete_session best-effort clears Neo4j for the session id.
    from app.services.neo4j_client import neo4j_client

    calls = []
    monkeypatch.setattr(neo4j_client, "clear_session", lambda sid: calls.append(sid))

    created = db_client.post("/api/sessions/create", json={"filepath": "x.mcap"}).json()
    sid = created["session_id"]
    db_client.delete(f"/api/sessions/{sid}")
    assert calls == [sid]


# ── delete (all) ───────────────────────────────────────────────────────────


def test_delete_all_sessions_clears_everything(db_client):
    db_client.post("/api/sessions/create", json={"filepath": "a.mcap"})
    db_client.post("/api/sessions/create", json={"filepath": "b.mcap"})
    assert len(db_client.get("/api/sessions").json()) == 2

    resp = db_client.delete("/api/sessions")
    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert db_client.get("/api/sessions").json() == []


# ── status-gated sub-resources (no ingestion -> status stays "processing") ──


def test_timeline_returns_empty_when_not_ready(db_client):
    sid = db_client.post("/api/sessions/create", json={"filepath": "p.mcap"}).json()["session_id"]
    resp = db_client.get(f"/api/sessions/{sid}/timeline")
    # status is "processing" (ingestion stubbed), so endpoint short-circuits to [].
    assert resp.status_code == 200
    assert resp.json() == []


def test_topics_returns_empty_when_not_ready(db_client):
    sid = db_client.post("/api/sessions/create", json={"filepath": "p.mcap"}).json()["session_id"]
    resp = db_client.get(f"/api/sessions/{sid}/topics")
    assert resp.status_code == 200
    assert resp.json() == []


def test_anomalies_returns_empty_when_not_ready(db_client):
    sid = db_client.post("/api/sessions/create", json={"filepath": "p.mcap"}).json()["session_id"]
    resp = db_client.get(f"/api/sessions/{sid}/anomalies")
    assert resp.status_code == 200
    assert resp.json() == []


def test_timeline_unknown_session_404(db_client):
    resp = db_client.get("/api/sessions/ghost/timeline")
    assert resp.status_code == 404


# ── mcp servers (health-probe path mocked) ─────────────────────────────────


def test_mcp_list_servers_shape(db_client):
    # No workers running; httpx probes fail -> disconnected entries. We assert
    # the contract shape and worker set the renderer relies on.
    resp = db_client.get("/api/mcp/servers")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    ids = {e["id"] for e in body}
    assert ids == {
        "rosbag_reader",
        "trajectory_analyzer",
        "planner_failure_inspector",
        "anomaly_detector",
        "report_composer",
    }
    for e in body:
        assert e["transport"] == "stdio"
        assert isinstance(e["tools"], int)
        assert "enabled" in e and "status" in e and "last_error" in e


def test_mcp_toggle_flips_and_restores(db_client):
    initial = {e["id"]: e["enabled"] for e in db_client.get("/api/mcp/servers").json()}
    start = initial["anomaly_detector"]

    resp = db_client.post("/api/mcp/servers/anomaly_detector/toggle")
    assert resp.status_code == 200
    assert resp.json() == {"id": "anomaly_detector", "enabled": not start}

    # Disabled workers report status "disabled".
    listing = db_client.get("/api/mcp/servers").json()
    entry = next(e for e in listing if e["id"] == "anomaly_detector")
    assert entry["enabled"] == (not start)
    if not entry["enabled"]:
        assert entry["status"] == "disabled"

    # Restore default so we don't leak state to sibling tests/modules.
    db_client.post("/api/mcp/servers/anomaly_detector/toggle")


def test_mcp_toggle_unknown_worker_404(db_client):
    resp = db_client.post("/api/mcp/servers/not_real/toggle")
    assert resp.status_code == 404
