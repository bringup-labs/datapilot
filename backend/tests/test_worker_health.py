"""Worker /health server bind-host coverage (issue #91).

The health server must bind to loopback (127.0.0.1) by default so it is not
exposed on all interfaces (which would leak the worker name + tool count over
the network). The bind host stays overridable via DATAPILOT_HEALTH_HOST.

The server is spawned on a daemon thread, so we monkeypatch ThreadingHTTPServer
to capture the (host, port) tuple it is constructed with and to stop the thread
immediately (no real socket bind / serve_forever).
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import threading

import pytest
from mcp.server.fastmcp import FastMCP

# `mcp_workers` lives at the repo root, one level above `backend/`.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from mcp_workers._shared import health as health_mod


class _CapturingServer:
    """Stand-in for ThreadingHTTPServer that records its bind address and
    aborts serve_forever so the daemon thread exits immediately."""

    last_address: tuple | None = None
    constructed = threading.Event()

    def __init__(self, server_address, handler_cls):
        type(self).last_address = server_address
        type(self).constructed.set()

    def serve_forever(self):
        # Don't actually block / open a socket in the test thread.
        return

    def server_close(self):
        return


@pytest.fixture
def capture_bind(monkeypatch):
    _CapturingServer.last_address = None
    _CapturingServer.constructed = threading.Event()
    monkeypatch.setattr(health_mod, "ThreadingHTTPServer", _CapturingServer)

    def _run(**env):
        for k, v in env.items():
            if v is None:
                monkeypatch.delenv(k, raising=False)
            else:
                monkeypatch.setenv(k, v)
        health_mod.start_health_server("test-worker", 9999, lambda: 3)
        assert _CapturingServer.constructed.wait(timeout=2.0), \
            "health server thread never constructed ThreadingHTTPServer"
        return _CapturingServer.last_address

    return _run


def test_binds_loopback_by_default(capture_bind):
    host, port = capture_bind(DATAPILOT_HEALTH_HOST=None)
    assert host == "127.0.0.1"
    assert host != "0.0.0.0"
    assert port == 9999


def test_bind_host_is_overridable_via_env(capture_bind):
    host, _port = capture_bind(DATAPILOT_HEALTH_HOST="0.0.0.0")
    assert host == "0.0.0.0"


# ── Reported tool count (#86) ─────────────────────────────────────────────────

WORKERS = [
    "rosbag_reader",
    "trajectory_analyzer",
    "planner_failure_inspector",
    "anomaly_detector",
    "report_composer",
]


def test_tool_counter_counts_tools_as_they_are_registered():
    server = FastMCP("test-worker")
    count = health_mod.tool_counter(server)
    assert count() == 0

    server.add_tool(lambda: "ok", name="first")
    server.add_tool(lambda: "ok", name="second")
    assert count() == 2


class _StopMain(BaseException):
    """Raised from the stubbed stdio loop so the worker's main() returns."""


@pytest.mark.parametrize("worker", WORKERS)
def test_worker_health_reports_the_tools_it_serves(worker, monkeypatch):
    # rosbag_reader served 4 tools but its /health said 3: each worker passed
    # a hardcoded count.
    server = importlib.import_module(f"mcp_workers.{worker}.server")
    reported = {}
    monkeypatch.setattr(
        server, "start_health_server", lambda name, port, count: reported.update(count=count)
    )

    def stop(*args, **kwargs):
        raise _StopMain

    monkeypatch.setattr(server.mcp, "run", stop)
    with pytest.raises(_StopMain):
        server.main()

    served = asyncio.run(server.mcp.list_tools())
    assert reported["count"]() == len(served)
