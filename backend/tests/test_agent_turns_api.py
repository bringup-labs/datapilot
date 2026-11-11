import asyncio

from sqlalchemy import func, select

from app.agent.turn_store import turn_store
from app.models import ChatMessageRecord, SessionCostRecord

BODY = {
    "question": "Why did navigation abort?",
    "response": "The planner aborted after the lidar dropped out (l_8).",
    "model": "claude-sonnet-4-5-20250929",
    "auth_method": "claude.ai",
    "usage": {"tokens_in": 1500, "tokens_out": 200, "est_cost_usd": 0.0123},
    "steps": [
        {"tool": "get_bag_overview", "label": "Get bag overview"},
        {"tool": "submit_findings", "label": "Submit findings"},
    ],
    "status": "completed",
}
FINDING = {"sev": "critical", "text": "Planner aborted", "log_ids": ["sess-1:l_8"]}


def new_turn(client, sid="sess-1"):
    resp = client.post(f"/api/sessions/{sid}/agent-turns")
    assert resp.status_code == 201
    return resp.json()["turn_id"]


def complete(client, tid, sid="sess-1", **changes):
    return client.post(f"/api/sessions/{sid}/agent-turns/{tid}/complete", json={**BODY, **changes})


def count_cost_rows(factory, sid):
    async def _go():
        async with factory() as db:
            res = await db.execute(
                select(func.count()).select_from(SessionCostRecord).where(SessionCostRecord.session_id == sid)
            )
            return res.scalar_one()

    return asyncio.run(_go())


def test_create_turn_checks_the_session_like_chat(db_client, seed_session):
    assert db_client.post("/api/sessions/nope/agent-turns").status_code == 404
    seed_session("busy", status="processing")
    assert db_client.post("/api/sessions/busy/agent-turns").status_code == 409
    seed_session("sess-1")
    assert isinstance(new_turn(db_client), str)


def test_complete_builds_a_verified_envelope_from_submitted_findings(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs(["sess-1:l_8"])
    tid = new_turn(db_client)
    turn_store.submit("sess-1", tid, [FINDING], [{"label": "Planner aborted", "log_id": "sess-1:l_8"}])
    env = complete(db_client, tid).json()
    assert env["answered_by"] == "claude_code" and env["verified"] is True and env["flagged_log_ids"] == []
    assert [f["text"] for f in env["findings"]] == ["Planner aborted"] and env["citations"][0]["log_id"] == "sess-1:l_8"
    assert env["plan"] == BODY["steps"] and env["partial"] is False
    assert env["audit_trail"][0]["step_kind"] == "external_agent" and env["audit_trail"][0]["specialist"] == "claude_code"
    assert env["claude_code_usage"] == {
        "model": "claude-sonnet-4-5-20250929", "auth_method": "claude.ai", "tool_calls": 2, "est_cost_usd": 0.0123,
    }
    assert env["usage"] == {"tokens_in": 1500, "tokens_out": 200, "est_cost_usd": 0.0123}


def test_complete_without_submit_findings_is_unverified(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs(["sess-1:l_8"])
    env = complete(db_client, new_turn(db_client)).json()
    assert env["verified"] is False and env["findings"] == []


def test_findings_are_rechecked_at_completion(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs([])
    tid = new_turn(db_client)
    turn_store.submit("sess-1", tid, [FINDING], [])
    env = complete(db_client, tid).json()
    assert env["verified"] is False
    assert any("dropped 1 uncited finding" in (e.get("result_summary") or "") for e in env["audit_trail"])


def test_complete_flags_unknown_log_ids_in_the_summary(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs(["sess-1:l_8"])
    env = complete(db_client, new_turn(db_client), response="See l_8 and l_404.").json()
    assert env["flagged_log_ids"] == ["l_404"]
    assert any("l_404" in (e.get("result_summary") or "") for e in env["audit_trail"])


def test_completed_turn_reloads_like_a_normal_one(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs(["sess-1:l_8"])
    tid = new_turn(db_client)
    turn_store.submit("sess-1", tid, [FINDING], [])
    complete(db_client, tid)
    user, answer = db_client.get("/api/sessions/sess-1/messages").json()
    assert user["role"] == "user" and user["content"] == BODY["question"] and user["answered_by"] is None
    assert answer["content"] == BODY["response"] and answer["findings"][0]["text"] == "Planner aborted"
    assert answer["plan"] == BODY["steps"] and answer["answered_by"] == "claude_code" and answer["verified"] is True
    assert answer["claude_code_usage"]["tool_calls"] == 2
    assert answer["flagged_log_ids"] == []


def test_claude_code_turns_write_no_cost_row(db_client, db_session_factory, seed_session, existing_logs):
    seed_session()
    existing_logs([])
    complete(db_client, new_turn(db_client))
    assert count_cost_rows(db_session_factory, "sess-1") == 0


def test_stopped_turn_is_saved_as_partial(db_client, seed_session, existing_logs):
    seed_session()
    existing_logs([])
    env = complete(db_client, new_turn(db_client), status="stopped", response="*Generation stopped by user.*").json()
    assert env["partial"] is True and len(db_client.get("/api/sessions/sess-1/messages").json()) == 2


def test_failed_turn_is_discarded_and_not_saved(db_client, seed_session):
    seed_session()
    tid = new_turn(db_client)
    assert complete(db_client, tid, status="failed").json() == {"status": "discarded"}
    assert db_client.get("/api/sessions/sess-1/messages").json() == [] and not turn_store.exists("sess-1", tid)


def test_complete_unknown_turn_is_404(db_client, seed_session):
    seed_session()
    assert complete(db_client, "no-such-turn").status_code == 404


def test_complete_unknown_session_is_404(db_client):
    assert complete(db_client, "t", sid="nope").status_code == 404


def test_datapilot_rows_report_datapilot(db_client, db_session_factory, seed_session):
    seed_session()

    async def _go():
        async with db_session_factory() as db:
            db.add(ChatMessageRecord(session_id="sess-1", role="assistant", content="a", execution_steps="[]"))
            await db.commit()

    asyncio.run(_go())
    row = db_client.get("/api/sessions/sess-1/messages").json()[0]
    assert row["answered_by"] == "datapilot" and row["verified"] is None and row["claude_code_usage"] is None
    assert row["flagged_log_ids"] == []
