"""
End-to-end SSE smoke test for POST /api/sessions/{id}/chat.

Patches the LLM router to return canned responses and the Neo4j client to
return the expected log_ids so citation resolution succeeds. Asserts the 8
event types appear in the right order.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.sessions import run_ingestion
from app.db_sqlite import AsyncSessionLocal, init_db
from app.main import app
from app.models import SessionRecord
from tests.fixtures.mock_llm import MockRouter


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    asyncio.run(init_db())


@pytest.fixture
def session_with_demo_data(mock_neo4j):
    """Ingest lidar_failure.mcap so /chat has a ready session to act on."""
    session_id = f"chat-test-{uuid.uuid4()}"

    async def _arrange():
        async with AsyncSessionLocal() as db:
            db.add(SessionRecord(id=session_id, filename="lidar_failure.mcap",
                                 filepath="lidar_failure.mcap", status="processing"))
            await db.commit()
        await run_ingestion(session_id, "lidar_failure.mcap")

    asyncio.run(_arrange())
    return session_id


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    """Parse an SSE response body into a list of (event, data) pairs.
    sse-starlette uses CRLF line endings, so split on either pattern."""
    # Normalize line endings first.
    normalized = body.replace("\r\n", "\n")
    events: list[tuple[str, dict]] = []
    for block in normalized.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        event_name = "message"
        data_str = ""
        for line in block.splitlines():
            if line.startswith("event:"):
                event_name = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_str = line[len("data:"):].strip()
        if data_str:
            try:
                events.append((event_name, json.loads(data_str)))
            except json.JSONDecodeError:
                events.append((event_name, {"_raw": data_str}))
    return events


def test_chat_streams_all_event_types(session_with_demo_data, mock_neo4j):
    """SSE smoke: plan → step-start → step-done (×2) → final."""
    session_id = session_with_demo_data

    # Mock the citation resolver and Neo4j vector search to return canned data
    # matching the MockLLMClient's RCA output (log_ids l_5, l_6, l_8, l_9).
    mock_neo4j.run_query.return_value = [
        {"log_id": "l_5", "ts": "00:01:04.215", "node": "/sensors", "msg": "Sensor dropout"},
        {"log_id": "l_6", "ts": "00:01:05.001", "node": "/costmap", "msg": "defensive inflation"},
        {"log_id": "l_8", "ts": "00:01:06.118", "node": "/move_base", "msg": "Planner aborted"},
        {"log_id": "l_9", "ts": "00:01:06.310", "node": "/cmd_vel", "msg": "emergency brake"},
    ]

    with patch("app.api.chat.get_router", return_value=MockRouter()), \
         patch("app.api.chat.get_checkpointer", return_value=None):
        client = TestClient(app)
        response = client.post(
            f"/api/sessions/{session_id}/chat",
            json={"message": "Why did navigation abort?"},
        )
        assert response.status_code == 200
        events = _parse_sse(response.text)

    event_names = [name for name, _ in events]
    assert "plan" in event_names, (
        f"missing plan event; saw {event_names}\n--- RAW BODY ---\n{response.text[:3000]}"
    )
    assert "final" in event_names, f"missing final event; saw {event_names}"
    # Plan should arrive before final.
    assert event_names.index("plan") < event_names.index("final")

    # Final envelope shape.
    final_payload = next(payload for name, payload in events if name == "final")
    assert "response" in final_payload
    assert "findings" in final_payload
    assert "causal" in final_payload
    assert "citations" in final_payload
    assert "usage" in final_payload
    assert "audit_trail" in final_payload

    # Every finding cites at least one log_id that was resolved into a citation.
    cited_ids = {c["log_id"] for c in final_payload["citations"]}
    for f in final_payload["findings"]:
        assert any(lid in cited_ids for lid in f["log_ids"]), \
            f"finding {f['text']!r} cites unresolved log_ids"


def test_chat_rejects_unready_session():
    """A session that hasn't finished ingestion can't be chatted with."""
    session_id = f"chat-not-ready-{uuid.uuid4()}"

    async def _arrange():
        async with AsyncSessionLocal() as db:
            db.add(SessionRecord(id=session_id, filename="x.mcap",
                                 filepath="x.mcap", status="processing"))
            await db.commit()
    asyncio.run(_arrange())

    client = TestClient(app)
    response = client.post(
        f"/api/sessions/{session_id}/chat",
        json={"message": "ping"},
    )
    assert response.status_code == 409


def test_chat_404_on_missing_session():
    client = TestClient(app)
    response = client.post(
        f"/api/sessions/does-not-exist/chat",
        json={"message": "ping"},
    )
    assert response.status_code == 404


def test_chat_general_session_works():
    """General session should automatically initialize and respond via direct composer completion."""
    with patch("app.api.chat.get_router", return_value=MockRouter()):
        client = TestClient(app)
        response = client.post(
            "/api/sessions/general/chat",
            json={"message": "ping"},
        )
        assert response.status_code == 200
        events = _parse_sse(response.text)

        event_names = [name for name, _ in events]
        assert "plan" in event_names
        assert "final" in event_names

        # Plan should arrive before final, plan is empty
        assert event_names.index("plan") < event_names.index("final")
        plan_payload = next(payload for name, payload in events if name == "plan")
        assert plan_payload["plan"] == []

        final_payload = next(payload for name, payload in events if name == "final")
        assert "response" in final_payload
        assert "Navigation aborted" in final_payload["response"]
        assert final_payload["plan"] == []
        assert final_payload["findings"] == []



def _plan_events(session_id, router, monkeypatch, deadline_s):
    from app.config import settings

    monkeypatch.setattr(settings, "plan_event_deadline_s", deadline_s)
    with patch("app.api.chat.get_router", return_value=router), \
         patch("app.api.chat.get_checkpointer", return_value=None):
        response = TestClient(app).post(
            f"/api/sessions/{session_id}/chat",
            json={"message": "Why did navigation abort?"},
        )
    events = _parse_sse(response.text)
    assert "final" in [name for name, _ in events]
    return [payload for name, payload in events if name == "plan"]


def test_chat_sends_a_provisional_plan_when_the_supervisor_is_slow(
    session_with_demo_data, mock_neo4j, monkeypatch
):
    """#55: the first plan event must not wait on a slow supervisor model."""
    import asyncio

    from tests.fixtures.mock_llm import MockLLMClient

    class _SlowSupervisor(MockLLMClient):
        async def complete(self, *, system, **kwargs):
            if "DataPilot Supervisor" in system:
                await asyncio.sleep(0.4)
            return await super().complete(system=system, **kwargs)

    plans = _plan_events(
        session_with_demo_data, MockRouter(client=_SlowSupervisor()), monkeypatch, deadline_s=0.05
    )

    assert len(plans) == 2
    assert plans[0]["provisional"] is True
    assert [s["specialist"] for s in plans[0]["plan"]] == ["RootCauseAnalyst"]
    # The supervisor's own plan still arrives and replaces the provisional one.
    assert not plans[1].get("provisional")
    assert len(plans[1]["plan"]) == 2


def test_chat_sends_only_the_real_plan_when_the_supervisor_is_fast(
    session_with_demo_data, mock_neo4j, monkeypatch
):
    plans = _plan_events(session_with_demo_data, MockRouter(), monkeypatch, deadline_s=5)

    assert len(plans) == 1
    assert not plans[0].get("provisional")
