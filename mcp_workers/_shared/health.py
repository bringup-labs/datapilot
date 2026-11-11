"""
Tiny HTTP `/health` server, spun up on a daemon thread alongside the worker's
stdio loop. Used by `backend/app/api/mcp.py::GET /api/mcp/servers` to discover
each worker's status independently of the stdio handshake.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Bind the health server to loopback by default so the worker name + tool count
# are not exposed on all interfaces (issue #91). The backend probes it locally,
# so loopback is sufficient. Operators that genuinely need cross-interface
# access (e.g. probing from another container) can override via the env var.
_DEFAULT_HEALTH_HOST = "127.0.0.1"


def tool_counter(mcp: Any) -> Callable[[], int]:
    """A `tool_count_fn` that counts the tools registered on `mcp`, a FastMCP
    server, each time /health is read. A hardcoded count drifted from the
    tools a worker actually served (#86).

    FastMCP's public `list_tools()` is async, and /health is served from a
    plain thread, so this reads the same registry through `_tool_manager`.
    """
    return lambda: len(mcp._tool_manager.list_tools())


def start_health_server(worker_name: str, port: int, tool_count_fn: Callable[[], int]) -> None:
    """Spawn a daemon HTTP server on `port`. Non-blocking.

    Endpoints:
      GET /health  → {"worker": str, "status": "ok", "tools": int}
    """

    class Handler(BaseHTTPRequestHandler):
        def address_string(self):  # type: ignore[override]
            # `BaseHTTPRequestHandler.address_string` does a reverse DNS lookup
            # by default. On Docker networks (and any host with slow / missing
            # DNS) that lookup can stall multiple seconds, blowing past the
            # backend's 1.5s health-probe timeout and flipping the worker's UI
            # status to `disconnected`. Returning the raw IP keeps probes snappy.
            return self.client_address[0]

        def do_GET(self):
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps({
                "worker": worker_name,
                "status": "ok",
                "tools": tool_count_fn(),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args, **kwargs):
            # Silence access logging — workers run with stdout consumed by the
            # MCP transport; we don't want noise on stderr either.
            pass

    host = os.environ.get("DATAPILOT_HEALTH_HOST") or _DEFAULT_HEALTH_HOST

    def _serve():
        try:
            srv = ThreadingHTTPServer((host, port), Handler)
            logger.info("health server for %s listening on %s:%d", worker_name, host, port)
            srv.serve_forever()
        except Exception:
            logger.exception("health server for %s crashed", worker_name)

    threading.Thread(target=_serve, daemon=True, name=f"health-{worker_name}").start()
