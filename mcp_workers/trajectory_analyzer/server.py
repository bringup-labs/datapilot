"""
`trajectory_analyzer` MCP worker.

Wraps `app.agent.tools.{query_topic, query_topic_rate}`.
Exposes stdio JSON-RPC + HTTP `/health` on port 9002.
"""
from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

# These imports rely on `backend/` being on PYTHONPATH (set by the Electron
# orchestrator and by `app.agent.mcp_stdio.WorkerHandle._spawn`).
from app.agent.tools import query_topic
from app.agent.tools import query_topic_rate

from mcp_workers._shared.health import start_health_server, tool_counter
from mcp_workers._shared.wrap_tool import register_tool

logger = logging.getLogger(__name__)

WORKER_NAME = "trajectory_analyzer"
HEALTH_PORT = int(os.environ.get("TRAJECTORY_ANALYZER_HEALTH_PORT", "9002"))

mcp = FastMCP(WORKER_NAME)

register_tool(mcp, query_topic)
register_tool(mcp, query_topic_rate)


def main() -> None:
    import signal
    import time

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    start_health_server(WORKER_NAME, HEALTH_PORT, tool_counter(mcp))
    logger.info("%s MCP server ready (health on :%d)", WORKER_NAME, HEALTH_PORT)
    try:
        mcp.run()
    except Exception:
        logger.exception("MCP stdio loop exited unexpectedly")
    logger.info("%s stdio closed; staying alive for /health", WORKER_NAME)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
