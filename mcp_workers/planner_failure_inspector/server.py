"""
`planner_failure_inspector` MCP worker.

Wraps `app.agent.tools.{find_aborts, query_causal_chain, query_commands,
query_recoveries, query_safety_rules}`.
Exposes stdio JSON-RPC + HTTP `/health` on port 9003.
"""
from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

from app.agent.tools import find_aborts, query_causal_chain
from app.agent.tools import query_commands, query_recoveries, query_safety_rules

from mcp_workers._shared.health import start_health_server, tool_counter
from mcp_workers._shared.wrap_tool import register_tool

logger = logging.getLogger(__name__)

WORKER_NAME = "planner_failure_inspector"
HEALTH_PORT = int(os.environ.get("PLANNER_FAILURE_INSPECTOR_HEALTH_PORT", "9003"))

mcp = FastMCP(WORKER_NAME)

register_tool(mcp, find_aborts)
register_tool(mcp, query_causal_chain)
register_tool(mcp, query_commands)
register_tool(mcp, query_recoveries)
register_tool(mcp, query_safety_rules)


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
