"""
MCP stdio transport — one persistent subprocess per worker.

Used by `mcp_client._dispatch_stdio`. The worker subprocesses are FastMCP
servers in `mcp_workers/<name>/server.py` (Phase 5). They communicate over
stdin/stdout using MCP's line-delimited JSON-RPC.

Design:
  - One `WorkerHandle` per worker (rosbag_reader, trajectory_analyzer, …).
  - Lazy launch: a worker subprocess is started on first dispatch to it.
  - Auto-restart: if the pipe breaks (worker crashed / killed), the next
    dispatch relaunches it.
  - The Electron orchestrator may pre-start the workers via Docker; in that
    case our subprocesses connect to existing docker-exec stdio. For local
    dev / tests, we launch the FastMCP server directly via `python -m`.

The implementation here is intentionally minimal — Phase 5 ships the
contract, not a high-throughput pool. Specialists rarely hit > 1 RPS today.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import select
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from app.version import __version__

logger = logging.getLogger(__name__)

# Worker name → Python module path to launch.
# Phase 5: `mcp_workers/<name>/server.py`. Each is a FastMCP entrypoint.
WORKER_MODULES: dict[str, str] = {
    "rosbag_reader":              "mcp_workers.rosbag_reader.server",
    "trajectory_analyzer":        "mcp_workers.trajectory_analyzer.server",
    "planner_failure_inspector":  "mcp_workers.planner_failure_inspector.server",
    "anomaly_detector":           "mcp_workers.anomaly_detector.server",
    "report_composer":            "mcp_workers.report_composer.server",
}

# Repo root — used to add `mcp_workers/` to PYTHONPATH for the child process.
_REPO_ROOT = Path(__file__).resolve().parents[3]


class WorkerHandle:
    """One persistent subprocess + stdin/stdout pipe, with a request-id counter."""

    def __init__(self, worker: str, module: str):
        self.worker = worker
        self.module = module
        self.proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._next_id = 0
        self._initialized = False

    def _spawn(self) -> None:
        """Launch the worker subprocess. Caller must hold self._lock."""
        if self.proc is not None and self.proc.poll() is None:
            return  # already running

        env = os.environ.copy()
        # `mcp_workers.*` lives at the repo root; `app.*` lives in `backend/`.
        # Both must be on PYTHONPATH so the worker's `server.py` can import them.
        backend_root = _REPO_ROOT / "backend"
        env["PYTHONPATH"] = f"{_REPO_ROOT}:{backend_root}:" + env.get("PYTHONPATH", "")
        # The worker code shouldn't try to re-enter stdio dispatch.
        env["DATAPILOT_MCP_TRANSPORT"] = "in_process"

        logger.info("spawning MCP worker %s via %s", self.worker, self.module)
        # `stderr=None` inherits the parent's stderr so worker log lines flow to
        # the backend's stderr stream. Capturing into a pipe without a draining
        # reader would deadlock the child once the OS pipe buffer fills (workers
        # configure logging at INFO to sys.stderr, so this matters in practice).
        self.proc = subprocess.Popen(
            [sys.executable, "-m", self.module],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=env,
            cwd=str(_REPO_ROOT),
            bufsize=0,
        )
        self._initialized = False
        # Send the MCP initialize handshake.
        self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "datapilot-backend", "version": __version__},
        })
        self._initialized = True

    def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send one JSON-RPC request and read one response line."""
        assert self.proc is not None and self.proc.stdin and self.proc.stdout
        self._next_id += 1
        request = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params}
        line = (json.dumps(request) + "\n").encode("utf-8")
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

        # Read until we get our matching response or hit the deadline.
        #
        # `readline()` alone is blocking — a frozen worker would hang forever
        # and silently ignore the 30s budget. We gate it on `select.select()`
        # so the deadline is enforced even when the child has stalled.
        # (POSIX-only; workers run in Linux containers, dev is macOS — both
        # support select() on subprocess pipes. Windows is not a target here.)
        deadline = time.time() + 30.0
        stdout = self.proc.stdout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"worker {self.worker} timed out on {method}")
            ready, _, _ = select.select([stdout], [], [], remaining)
            if not ready:
                raise TimeoutError(f"worker {self.worker} timed out on {method}")
            raw = stdout.readline()
            if not raw:
                # Pipe closed.
                raise RuntimeError(f"worker {self.worker} stdout closed (exit={self.proc.poll()})")
            # `errors="replace"` so a stray non-UTF-8 byte (binary debug print,
            # corrupted log) doesn't crash the dispatch — we'd rather drop the
            # offending line and keep reading.
            try:
                response = json.loads(raw.decode("utf-8", errors="replace").strip())
            except json.JSONDecodeError:
                continue  # might be a log line from the worker
            if response.get("id") == self._next_id:
                return response

    def call_tool(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Send a `tools/call` request. Returns the parsed tool result envelope."""
        with self._lock:
            try:
                self._spawn()
                resp = self._send_request("tools/call", {"name": tool_name, "arguments": args})
            except (BrokenPipeError, RuntimeError, TimeoutError) as exc:
                # Recycle and report tool_unavailable.
                self.terminate()
                raise

        if "error" in resp:
            return {
                "ok": False,
                "error": {
                    "code": "tool_rpc_error",
                    "message": resp["error"].get("message", "rpc error"),
                    "retryable": True,
                },
            }
        # MCP tools/call response: {result: {content: [{type:"text", text: "..."}], isError: bool}}
        # Our convention: workers return a JSON-stringified envelope as the text
        # content. Decode here.
        result_obj = resp.get("result") or {}
        content = result_obj.get("content") or []
        for block in content:
            if block.get("type") == "text":
                try:
                    return json.loads(block.get("text", "{}"))
                except json.JSONDecodeError:
                    continue
        return {"ok": False, "error": {"code": "malformed_rpc_response", "message": "no text content", "retryable": True}}

    def terminate(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2.0)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None
        self._initialized = False


class WorkerPool:
    """One handle per worker. Thread-safe."""

    def __init__(self):
        self._handles: dict[str, WorkerHandle] = {}
        self._lock = threading.Lock()

    def _get(self, worker: str) -> WorkerHandle:
        module = WORKER_MODULES.get(worker)
        if not module:
            raise ValueError(f"unknown worker: {worker!r}")
        with self._lock:
            handle = self._handles.get(worker)
            if handle is None:
                handle = WorkerHandle(worker, module)
                self._handles[worker] = handle
            return handle

    def dispatch(self, worker: str, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        handle = self._get(worker)
        # Workers expose tools under the unqualified `tool_name`; the
        # `worker__tool` qualifier from `llm_tool_defs` is split before calling
        # dispatch (specialists do that). Here we get the bare name.
        result = handle.call_tool(tool_name, args)
        return result

    def shutdown(self) -> None:
        with self._lock:
            for handle in self._handles.values():
                handle.terminate()
            self._handles.clear()


# Module-level singleton — `mcp_client._dispatch_stdio` consumes this.
worker_pool = WorkerPool()

# Belt-and-suspenders cleanup: the FastAPI lifespan shutdown already calls
# `worker_pool.shutdown()`, but `atexit` also covers abrupt exits (uncaught
# exceptions, direct script invocations, pytest runners) so we don't leak
# orphaned worker subprocesses. SIGKILL still bypasses this — that's
# unavoidable, the OS reaps the children on its own.
atexit.register(worker_pool.shutdown)
