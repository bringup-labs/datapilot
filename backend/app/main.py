"""
DataPilot FastAPI entrypoint.

Phase 3 — ingestion pipeline + session endpoints. Chat / fleet / MCP / search
routers land in Phases 4+.
"""
from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import APITokenMiddleware
from app.services.causal_rules import causal_rules_evaluator

logger = logging.getLogger(__name__)


async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Global handler: return a fixed, key-free JSON shape and log the full
    detail server-side under a correlation id (issue #63).

    Raw exception strings often embed internal bolt URIs, worker hosts, and
    absolute paths — never reflect them to the client.
    """
    correlation_id = uuid.uuid4().hex
    path = getattr(getattr(request, "url", None), "path", "?")
    logger.error("unhandled error [%s] on %s: %r", correlation_id, path, exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "correlation_id": correlation_id},
    )
from app.db_sqlite import init_db
from app.api.sessions import router as sessions_router
from app.api.chat import router as chat_router
from app.api.mcp import router as mcp_router
from app.api.settings_api import router as settings_router
from app.services.neo4j_client import neo4j_client



@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: initialize local SQLite schema (create-if-not-exists).
    await init_db()
    # Load API keys from the bind-mounted secret file (#39/#32), if present, so
    # keys never arrive via Env (docker inspect) or a renderer->HTTP POST.
    try:
        from app.config import settings as _cfg
        from app.api.settings_api import load_secrets_file
        if _cfg.datapilot_secrets_file:
            load_secrets_file(_cfg.datapilot_secrets_file)
    except Exception:
        pass  # Non-fatal — keys can still be set via the runtime endpoint
    # Load per-specialist model overrides from SQLite into the in-memory store.
    try:
        from app.db_sqlite import AsyncSessionLocal
        from app.models import AgentModelRecord
        from app.llm.router import set_specialist_override
        from sqlalchemy import select
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(select(AgentModelRecord))).scalars().all()
            for row in rows:
                set_specialist_override(row.specialist, row.model_id)
    except Exception:
        pass  # Non-fatal — fresh installs have no overrides yet
    yield
    # Shutdown: close the shared Neo4j driver so its connection pool
    # releases sockets back to the OS rather than relying on GC.
    try:
        neo4j_client.close()
    except Exception:
        # Best-effort — don't block process exit on teardown errors.
        pass
    # Phase 5: tear down any persistent MCP worker subprocesses we spawned via
    # the stdio transport. Safe to call even when no workers were launched.
    try:
        from app.agent.mcp_stdio import worker_pool
        worker_pool.shutdown()
    except Exception:
        pass


app = FastAPI(
    title="DataPilot Backend",
    version="0.1.0",
    description="Local-first ROS 2 debugging copilot — FastAPI + LangGraph.",
    lifespan=lifespan,
)

# Security (issue #64): this is a local-first backend that must only be reachable
# by the Electron renderer. Without these guards any web page the user visits
# could POST to http://localhost:8000/api/... (wipe sessions/Neo4j, overwrite
# keys, burn LLM tokens).
#
# Defense-in-depth, env-gated token check (innermost: added first so CORS wraps
# it and still tags the 401 response with CORS headers). No-op when
# DATAPILOT_API_TOKEN is unset, so dev/tests are unaffected.
app.add_middleware(APITokenMiddleware)

# CORS (always on): allow ONLY the Electron renderer — the Vite dev server on a
# loopback port (http://localhost:<port> / http://127.0.0.1:<port>) and the
# packaged renderer loaded from file:// (which sends `Origin: null`). Arbitrary
# internet origins are rejected. allow_credentials stays False to match prior
# behavior (the renderer uses bearer/header auth, not cookies).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|file://.*|null)$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Global exception handler (issue #63): sanitize any unhandled error into a
# fixed shape so internal detail never reaches the client.
app.add_exception_handler(Exception, internal_error_handler)

# Register routers
app.include_router(sessions_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(mcp_router, prefix="/api")
app.include_router(settings_router, prefix="/api")



@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness probe. The Electron orchestrator polls this on stack boot.

    `causal_rules` says how many causal rules loaded, and why none did if so:
    the backend still runs without them, but builds no causal chains (#89).
    Only a reason code is returned here; the details are in the error log.
    """
    return {
        "status": "ok",
        "phase": "3",
        "service": "datapilot-backend",
        "causal_rules": causal_rules_evaluator.status(),
    }


@app.get("/")
async def root() -> dict[str, str]:
    return {"name": "DataPilot Backend", "version": "0.1.0", "docs": "/docs"}
