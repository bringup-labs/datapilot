"""
`anomaly_detector` MCP worker.

Wraps `app.agent.tools.{find_dropouts, find_statistical_outliers,
find_signature_matches, compute_node_cpu, find_rate_regressions,
compare_metric_distributions, compare_log_signatures}`.
Exposes stdio JSON-RPC + HTTP `/health` on port 9004.
"""
from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

from app.agent.tools import find_dropouts
from app.agent.tools import (
    find_statistical_outliers,
    find_signature_matches,
    compute_node_cpu,
    find_rate_regressions,
    compare_metric_distributions,
    compare_log_signatures,
)

from mcp_workers._shared.health import start_health_server, tool_counter
from mcp_workers._shared.wrap_tool import register_tool

logger = logging.getLogger(__name__)

WORKER_NAME = "anomaly_detector"
HEALTH_PORT = int(os.environ.get("ANOMALY_DETECTOR_HEALTH_PORT", "9004"))

mcp = FastMCP(WORKER_NAME)

register_tool(mcp, find_dropouts)
register_tool(mcp, find_statistical_outliers)
register_tool(mcp, find_signature_matches)
register_tool(mcp, compute_node_cpu)
register_tool(mcp, find_rate_regressions)
register_tool(mcp, compare_metric_distributions)
register_tool(mcp, compare_log_signatures)


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
