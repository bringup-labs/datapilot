"""Token-protected ``/mcp`` endpoint exposing the single-bag analysis tools.

Claude Code (started by Electron main on the host) calls these read-only tools
for the open bag. The bag is identified by the ``X-DataPilot-Session`` header,
never by a tool argument.
"""
from __future__ import annotations

import copy
import json
import secrets
from typing import Any

import anyio.to_thread
import jsonschema
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from sqlalchemy import select

from app.agent.grounding import check_findings
from app.agent.mcp_client import dispatch, get_tool
from app.agent.turn_store import turn_store
from app.api.chat import session_overview
from app.auth import read_mcp_token
from app.config import settings
from app.db_sqlite import AsyncSessionLocal
from app.models import SessionRecord

#: (worker, name) for every tool that works on a single bag.
SINGLE_BAG_TOOLS: tuple[tuple[str, str], ...] = (
    ("rosbag_reader", "retrieve_logs"),
    ("rosbag_reader", "read_diagnostics"),
    ("rosbag_reader", "read_tf_chain"),
    ("planner_failure_inspector", "find_aborts"),
    ("planner_failure_inspector", "query_causal_chain"),
    ("planner_failure_inspector", "query_commands"),
    ("planner_failure_inspector", "query_recoveries"),
    ("planner_failure_inspector", "query_safety_rules"),
    ("trajectory_analyzer", "query_topic"),
    ("trajectory_analyzer", "query_topic_rate"),
    ("anomaly_detector", "find_dropouts"),
    ("anomaly_detector", "find_statistical_outliers"),
    ("anomaly_detector", "find_signature_matches"),
    ("anomaly_detector", "compute_node_cpu"),
    ("report_composer", "format_causal_chain"),
)

_WORKER_BY_NAME = {name: worker for worker, name in SINGLE_BAG_TOOLS}


def advertised_schema(input_schema: dict) -> dict:
    """Copy of a tool's input schema with ``session_id`` removed."""
    schema = copy.deepcopy(input_schema)
    props = schema.get("properties")
    if isinstance(props, dict):
        props.pop("session_id", None)
    required = schema.get("required")
    if isinstance(required, list):
        required = [r for r in required if r != "session_id"]
        if required:
            schema["required"] = required
        else:
            schema.pop("required", None)
    return schema


def json_result(payload: dict) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(payload, default=str))],
        isError=not payload.get("ok", False),
    )


def error_result(code: str, message: str) -> types.CallToolResult:
    return json_result({"ok": False, "error": {"code": code, "message": message, "retryable": False}})


def _advertised_tools() -> dict[str, tuple[str, dict, str, dict]]:
    out = {}
    for worker, name in SINGLE_BAG_TOOLS:
        desc = get_tool(worker, name)
        if desc is not None:
            out[name] = (worker, desc, desc["description"], advertised_schema(desc["input_schema"]))
    return out


_OVERVIEW_DESCRIPTION = "Facts about the loaded bag: file name, robot, duration, message count and topics. Call this first."
_OVERVIEW_SCHEMA: dict = {"type": "object", "properties": {}, "additionalProperties": False}

_SUBMIT_DESCRIPTION = (
    "Report your findings for this question. Critical and warning findings must cite log IDs from tool "
    "results; findings citing log IDs that don't exist in this bag are rejected. Each call replaces your "
    "previous submission, so always send the full list. Returns what was accepted and what was rejected, "
    "with reasons."
)
_SUBMIT_SCHEMA: dict = {
    "type": "object", "additionalProperties": False, "required": ["findings"],
    "properties": {
        "findings": {"type": "array", "maxItems": 50, "items": {
            "type": "object", "additionalProperties": False, "required": ["sev", "text", "log_ids"],
            "properties": {
                "sev": {"enum": ["critical", "warning", "info"]},
                "text": {"type": "string", "minLength": 1, "maxLength": 500},
                "detail": {"type": "string", "maxLength": 2000},
                "log_ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 200}},
            }}},
        "causal": {"type": "array", "maxItems": 30, "items": {
            "type": "object", "additionalProperties": False, "required": ["label"],
            "properties": {
                "label": {"type": "string", "minLength": 1, "maxLength": 300},
                "log_id": {"type": "string", "maxLength": 200},
            }}},
    },
}


async def _get_bag_overview(session_id: str) -> types.CallToolResult:
    async with AsyncSessionLocal() as db:
        record = (await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))).scalar_one_or_none()
    if record is None or record.status != "ready":
        return error_result("no_bag", "No loaded bag for this session.")
    return json_result({"ok": True, "result": session_overview(record)})


async def _submit_findings(session_id: str, turn_id: str | None, args: dict[str, Any]) -> types.CallToolResult:
    if not turn_store.exists(session_id, turn_id):
        return error_result("no_active_turn", "No active DataPilot question for this turn.")
    checked = await anyio.to_thread.run_sync(
        check_findings, session_id, args.get("findings", []), args.get("causal", [])
    )
    turn_store.submit(session_id, turn_id, list(checked["findings"]), list(checked["causal"]))
    rejected = {r["index"] for r in checked["rejected"]}
    accepted = [
        {"index": i, "sev": f.get("sev"), "text": f.get("text")}
        for i, f in enumerate(args.get("findings", []))
        if i not in rejected
    ]
    return json_result({"ok": True, "result": {
        "accepted": accepted,
        "rejected": checked["rejected"],
        "causal_rejected": checked["causal_rejected"],
        "note": "This list replaces anything you submitted earlier for this question.",
    }})


server = Server("datapilot")


@server.list_tools()
async def _list_tools() -> list[types.Tool]:
    tools = [
        types.Tool(name=name, description=description, inputSchema=schema)
        for name, (_w, _d, description, schema) in _advertised_tools().items()
    ]
    return [
        types.Tool(name="get_bag_overview", description=_OVERVIEW_DESCRIPTION, inputSchema=_OVERVIEW_SCHEMA),
        *tools,
        types.Tool(name="submit_findings", description=_SUBMIT_DESCRIPTION, inputSchema=_SUBMIT_SCHEMA),
    ]


@server.call_tool(validate_input=False)
async def _call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    request = server.request_context.request
    session_id = request.headers.get("x-datapilot-session") if request is not None else None
    if not session_id:
        return error_result("missing_session", "Missing X-DataPilot-Session header.")
    local = {"get_bag_overview": _OVERVIEW_SCHEMA, "submit_findings": _SUBMIT_SCHEMA}
    entry = None if name in local else _advertised_tools().get(name)
    if entry is None and name not in local:
        return error_result("unknown_tool", f"Unknown tool: {name}")
    schema = local[name] if entry is None else entry[3]
    args = {k: v for k, v in (arguments or {}).items() if k != "session_id"}
    try:
        jsonschema.validate(args, schema)
    except jsonschema.ValidationError as e:
        return error_result("invalid_arguments", f"Input validation error: {e.message}")
    if name == "get_bag_overview":
        return await _get_bag_overview(session_id)
    if name == "submit_findings":
        return await _submit_findings(session_id, request.headers.get("x-datapilot-turn"), args)
    worker = entry[0]
    out = await anyio.to_thread.run_sync(dispatch, worker, name, {**args, "session_id": session_id})
    return json_result(out)


def create_session_manager() -> StreamableHTTPSessionManager:
    return StreamableHTTPSessionManager(
        app=server,
        stateless=True,
        json_response=True,
        security_settings=TransportSecuritySettings(allowed_hosts=["localhost:*", "127.0.0.1:*"]),
    )


def _bearer(scope: Scope) -> str:
    for key, value in scope.get("headers", []):
        if key == b"authorization":
            scheme, _, credentials = value.decode("latin-1").partition(" ")
            if scheme.lower() == "bearer":
                return credentials.strip()
    return ""


class MCPEndpoint:
    """ASGI app: bearer-token gate in front of the MCP session manager."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        expected = read_mcp_token(settings.datapilot_secrets_file)
        presented = _bearer(scope)
        if not expected or not presented or not secrets.compare_digest(
            presented.encode("utf-8"), expected.encode("utf-8")
        ):
            await JSONResponse(
                {"detail": "Invalid or missing token."},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return
        manager = getattr(scope["app"].state, "mcp_session_manager", None)
        if manager is None:
            await JSONResponse({"detail": "Tool endpoint is not running."}, status_code=503)(scope, receive, send)
            return
        await manager.handle_request(scope, receive, send)
