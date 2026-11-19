"""
`/api/mcp/servers` — surfaces the 5 MCP workers to the Agents & MCP screen.

Per the Phase 5 spec (§5.7), the Agents screen lists each worker with its
status (`connected | disconnected | error`), transport (`stdio | http`),
and tool count. Status is discovered by polling each worker's HTTP `/health`
endpoint independently of the stdio handshake — that way a hung stdio loop
shows as `disconnected` here while still reporting the container running.

Toggle persistence (writing the enabled flag to `agent_models` SQLite) is
Phase 11 work; for Phase 5 we keep an in-memory toggle map so the API shape
is settled and the renderer can wire to it without breakage.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from app.schemas import McpServerInfo, McpToggleResponse
from app.agent.mcp_stdio import WORKER_MODULES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp", tags=["mcp"])

# Per-worker HTTP health ports. Must match `HEALTH_PORT` in each
# `mcp_workers/<name>/server.py` and the published port in docker-compose.yml.
WORKER_HEALTH_PORTS: dict[str, int] = {
    "rosbag_reader":             9001,
    "trajectory_analyzer":       9002,
    "planner_failure_inspector": 9003,
    "anomaly_detector":          9004,
    "report_composer":           9005,
}

# Human-readable labels for the renderer.
WORKER_LABELS: dict[str, str] = {
    "rosbag_reader":             "Rosbag Reader",
    "trajectory_analyzer":       "Trajectory Analyzer",
    "planner_failure_inspector": "Planner Failure Inspector",
    "anomaly_detector":          "Anomaly Detector",
    "report_composer":           "Report Composer",
}

# In-memory toggle map. Phase 11 swaps this for SQLite-backed `agent_models`.
_enabled: dict[str, bool] = {name: True for name in WORKER_MODULES}


def _health_host() -> str:
    """Where to reach the worker `/health` from the backend process.

    - In the docker stack: each worker is a sibling container reachable by its
      compose service name (matches `container_name` in docker-compose.yml).
    - In local dev (stdio subprocesses launched by `mcp_stdio.WorkerHandle`):
      they bind 0.0.0.0 on the host, so `127.0.0.1` works.
    """
    # `DATAPILOT_MCP_HEALTH_HOST` lets the orchestrator override this when the
    # service names differ from defaults.
    return os.environ.get("DATAPILOT_MCP_HEALTH_HOST", "127.0.0.1")


async def _probe_health(client: httpx.AsyncClient, worker: str) -> dict[str, Any]:
    """One worker's `/health` payload, or a synthetic error envelope."""
    port = WORKER_HEALTH_PORTS[worker]
    url = f"http://{_health_host()}:{port}/health"
    try:
        resp = await client.get(url, timeout=1.5)
        if resp.status_code != 200:
            return {"status": "error", "tools": 0, "last_error": f"HTTP {resp.status_code}"}
        body = resp.json()
        return {
            "status": "connected",
            "tools": int(body.get("tools", 0)),
            "last_error": None,
        }
    except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
        return {"status": "disconnected", "tools": 0, "last_error": None}
    except Exception as exc:
        # Never surface the raw exception text — it can embed internal hosts /
        # ports / paths (issue #63). Log the type server-side; return a fixed
        # client-facing string.
        logger.warning("health probe failed for %s: %s", worker, type(exc).__name__)
        return {"status": "error", "tools": 0, "last_error": "probe failed"}


@router.get("/servers", response_model=list[McpServerInfo])
async def list_servers() -> list[dict[str, Any]]:
    """Return one entry per worker — what the Agents & MCP screen renders."""
    async with httpx.AsyncClient() as client:
        probes = await asyncio.gather(
            *(_probe_health(client, name) for name in WORKER_MODULES)
        )

    out: list[dict[str, Any]] = []
    for (name, _module), probe in zip(WORKER_MODULES.items(), probes):
        out.append({
            "id": name,
            "name": WORKER_LABELS.get(name, name),
            "transport": "stdio",
            "enabled": _enabled.get(name, True),
            "status": probe["status"] if _enabled.get(name, True) else "disabled",
            "tools": probe["tools"],
            "calls_7d": 0,  # Phase 11 wires telemetry counters.
            "last_error": probe["last_error"],
        })
    return out


@router.post("/servers/{worker_id}/toggle", response_model=McpToggleResponse)
async def toggle_server(worker_id: str) -> dict[str, Any]:
    """Flip the worker's enabled flag. Phase 11 persists this to SQLite."""
    if worker_id not in WORKER_MODULES:
        raise HTTPException(status_code=404, detail=f"unknown worker {worker_id!r}")
    new_state = not _enabled.get(worker_id, True)
    _enabled[worker_id] = new_state
    return {"id": worker_id, "enabled": new_state}
