"""
`rosbag_reader` MCP worker.

Wraps `app.agent.tools.{retrieve_logs, read_tf_chain, read_diagnostics, query_mcap}`.
Exposes:
  - stdio JSON-RPC (the primary MCP transport `mcp_client._dispatch_stdio` uses)
  - HTTP `/health` on port 9001 (the Agents & MCP screen polls this)
"""
from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

# These imports rely on `backend/` being on PYTHONPATH (set by the Electron
# orchestrator and by `app.agent.mcp_stdio.WorkerHandle._spawn`).
from app.agent.tools import retrieve_logs, read_tf_chain
from app.agent.tools import read_diagnostics
from app.agent.tools import query_mcap

from mcp_workers._shared.health import start_health_server, tool_counter
from mcp_workers._shared.wrap_tool import register_tool

logger = logging.getLogger(__name__)

WORKER_NAME = "rosbag_reader"
HEALTH_PORT = int(os.environ.get("ROSBAG_READER_HEALTH_PORT", "9001"))

mcp = FastMCP(WORKER_NAME)

register_tool(mcp, retrieve_logs)
register_tool(mcp, read_tf_chain)
register_tool(mcp, read_diagnostics)
register_tool(mcp, query_mcap)


def main() -> None:
    import signal
    import time

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    start_health_server(WORKER_NAME, HEALTH_PORT, tool_counter(mcp))
    logger.info("%s MCP server ready (health on :%d)", WORKER_NAME, HEALTH_PORT)
    try:
        mcp.run()  # blocks on stdin; returns when stdin closes (no client)
    except Exception:
        logger.exception("MCP stdio loop exited unexpectedly")
    # stdin closed — no stdio client connected (DATAPILOT_MCP_TRANSPORT=in_process).
    # Stay alive so the /health daemon thread keeps responding.
    logger.info("%s stdio closed; staying alive for /health", WORKER_NAME)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
