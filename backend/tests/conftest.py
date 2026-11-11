import os
import sys
import pytest
import pytest_asyncio
from unittest.mock import MagicMock

# Force test environment variables
os.environ["DATAPILOT_DATA_DIR"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data_test"))
os.environ["NEO4J_URI"] = "bolt://localhost:7687"
os.environ["NEO4J_USER"] = "neo4j"
os.environ["NEO4J_PASSWORD"] = "test-pass"
# Phase 5: production default for `mcp_client.dispatch` is `stdio`, which would
# try to launch worker subprocesses. Tests use the in-process registry so the
# Phase 4 + 4.5 test suite stays fast and offline.
os.environ["DATAPILOT_MCP_TRANSPORT"] = "in_process"

# Add backend directory to sys.path
backend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

# Mock Neo4j client connection globally during tests to avoid container dependency checks
@pytest.fixture(autouse=True)
def mock_neo4j():
    from app.services.neo4j_client import neo4j_client
    # Mock Neo4j driver and sessions
    neo4j_client.driver = MagicMock()
    neo4j_client.init_indexes = MagicMock()
    neo4j_client.clear_session = MagicMock()
    neo4j_client.write_logs = MagicMock()
    neo4j_client.write_topics = MagicMock()
    neo4j_client.write_frames = MagicMock()
    neo4j_client.create_session_node = MagicMock()
    neo4j_client.write_edges = MagicMock()
    neo4j_client.write_anomalies = MagicMock()
    neo4j_client.run_query = MagicMock(return_value=[])
    yield neo4j_client


# ── Isolated in-memory DB shared by API tests ──────────────────────────────


@pytest_asyncio.fixture
async def db_session_factory():
    """Yield a session factory over a fresh in-memory SQLite with all tables."""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
    from sqlalchemy.pool import StaticPool
    from app.db_sqlite import Base
    import app.models  # noqa: F401  (ensures ORM tables register against Base)

    # A single shared in-memory connection (StaticPool keeps one connection so
    # the schema created here is visible to request handlers).
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        await engine.dispose()


@pytest.fixture
def db_client(db_session_factory, monkeypatch):
    """Yield a TestClient backed by the isolated in-memory SQLite factory."""
    from fastapi.testclient import TestClient
    from app.main import app as fastapi_app
    from app.db_sqlite import get_db
    import app.api.sessions as sessions_mod

    async def _override_get_db():
        async with db_session_factory() as session:
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


@pytest.fixture
def existing_logs(mock_neo4j):
    """Make the mocked ``run_query`` resolve only the given log IDs."""

    def _set(ids: list[str]) -> None:
        def _run_query(cypher, params=None):
            wanted = (params or {}).get("log_ids", [])
            return [
                {"log_id": i, "ts": "00:00:01.000", "node": "/node", "msg": "log line"}
                for i in wanted
                if i in ids
            ]

        mock_neo4j.run_query.side_effect = _run_query

    return _set


@pytest.fixture
def seed_session(db_session_factory):
    """Insert a ``SessionRecord`` into the isolated in-memory DB."""
    import asyncio
    from app.models import SessionRecord

    def _seed(session_id: str = "sess-1", *, status: str = "ready", **fields) -> None:
        fields.setdefault("filename", "lidar_failure.mcap")
        fields.setdefault("filepath", "lidar_failure.mcap")

        async def _go():
            async with db_session_factory() as db:
                db.add(SessionRecord(id=session_id, status=status, **fields))
                await db.commit()

        asyncio.run(_go())

    return _seed
