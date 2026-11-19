"""
MCP-shaped dispatcher with pluggable transport.

`dispatch(worker, tool, args) -> {ok, result | error}`.

Transport is selected by `DATAPILOT_MCP_TRANSPORT`:
  - "stdio"      (production default): JSON-RPC over stdio to the worker
                 subprocesses managed by the Electron orchestrator.
  - "in_process" (test / dev): calls the worker tool's `run` function
                 in-process — faster and zero-subprocess overhead.

`mock_neo4j` autouse fixture in `backend/tests/conftest.py` forces
`in_process` so all tests run without Docker.

Tool catalog is built at import-time by introspecting each tool module's
WORKER / NAME / DESCRIPTION / INPUT_SCHEMA / OUTPUT_SCHEMA / run.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any, Callable, TypedDict

from app.config import settings
from app.agent.tools import (
    find_aborts,
    find_dropouts,
    query_causal_chain,
    query_graph,
    query_mcap,
    query_topic,
    read_tf_chain,
    retrieve_logs,
)
from app.agent.tools import (
    query_topic_rate,
    find_statistical_outliers,
    find_signature_matches,
    compute_node_cpu,
    find_rate_regressions,
    query_commands,
    query_recoveries,
    query_safety_rules,
    compare_metric_distributions,
    compare_log_signatures,
    read_diagnostics,
    format_causal_chain,
)

logger = logging.getLogger(__name__)


class ToolDescriptor(TypedDict):
    worker: str
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    run: Callable[[dict[str, Any]], dict[str, Any]]


def _descriptor(module: Any) -> ToolDescriptor:
    return ToolDescriptor(
        worker=module.WORKER,
        name=module.NAME,
        description=module.DESCRIPTION,
        input_schema=module.INPUT_SCHEMA,
        output_schema=module.OUTPUT_SCHEMA,
        run=module.run,
    )


# Tool catalog — every tool any specialist can call must be registered here.
_REGISTRY: dict[tuple[str, str], ToolDescriptor] = {}


def _register(module: Any) -> None:
    desc = _descriptor(module)
    _REGISTRY[(desc["worker"], desc["name"])] = desc


for _module in (
    retrieve_logs,
    query_topic,
    query_graph,
    query_mcap,
    find_aborts,
    query_causal_chain,
    find_dropouts,
    read_tf_chain,
):
    _register(_module)

# Real tools (Phase 5 — Neo4j-backed implementations).
for _module in (
    query_topic_rate,
    find_statistical_outliers,
    find_signature_matches,
    compute_node_cpu,
    find_rate_regressions,
    query_commands,
    query_recoveries,
    query_safety_rules,
    compare_metric_distributions,
    compare_log_signatures,
    read_diagnostics,
    format_causal_chain,
):
    _register(_module)


def list_tools(worker: str | None = None) -> list[ToolDescriptor]:
    """Return the full tool catalog or just one worker's tools."""
    if worker is None:
        return list(_REGISTRY.values())
    return [d for d in _REGISTRY.values() if d["worker"] == worker]


def get_tool(worker: str, name: str) -> ToolDescriptor | None:
    return _REGISTRY.get((worker, name))


def _current_transport() -> str:
    """Read the transport at call time so test fixtures can toggle without
    re-importing the module."""
    return os.environ.get("DATAPILOT_MCP_TRANSPORT", "stdio").lower()


def dispatch(worker: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """
    Invoke a registered tool. Returns the tool's response unmodified — i.e.
    `{ok: true, result: …}` or `{ok: false, error: {code, message, retryable}}`.

    The dispatcher itself never raises — unknown tools return a structured
    `tool_unavailable` error so the specialist's ReAct loop can replan around it.

    Transport is selected by `DATAPILOT_MCP_TRANSPORT`:
      - "in_process": same as Phase 4 — call the worker tool's `run` directly.
      - "stdio" (default): JSON-RPC over stdio to the worker subprocess.
    """
    # Tools are synchronous, so the only way to enforce a ceiling is to run the
    # call on another thread and stop waiting for it (#58). A call that overruns
    # keeps its thread until it returns; the pool bounds how many can pile up.
    future = _TOOL_EXECUTOR.submit(_dispatch_untimed, worker, name, args)
    try:
        return future.result(timeout=settings.tool_timeout_s)
    except FutureTimeoutError:
        future.cancel()
        logger.warning("dispatch: tool %s.%s exceeded %.1fs", worker, name, settings.tool_timeout_s)
        return {
            "ok": False,
            "error": {
                "code": "tool_timeout",
                "message": f"{worker}.{name} did not finish within {settings.tool_timeout_s:g}s",
                "retryable": True,
            },
        }


_TOOL_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="mcp-tool")


def _dispatch_untimed(worker: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    transport = _current_transport()
    if transport == "in_process":
        return _dispatch_in_process(worker, name, args)
    return _dispatch_stdio(worker, name, args)


async def dispatch_async(worker: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """`dispatch` for async callers.

    Tools are synchronous: in-process they run blocking Cypher on the sync
    Neo4j driver, and over stdio they block on the worker's pipe. Running them
    on a worker thread keeps one slow query from freezing every other chat
    stream on the event loop (#46).
    """
    return await asyncio.to_thread(dispatch, worker, name, args)


def _dispatch_in_process(worker: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """In-process dispatch — what Phase 4 used everywhere."""
    desc = _REGISTRY.get((worker, name))
    if desc is None:
        logger.warning("dispatch: unknown tool %s.%s", worker, name)
        return {
            "ok": False,
            "error": {
                "code": "tool_unavailable",
                "message": f"No such tool: {worker}.{name}",
                "retryable": False,
            },
        }

    started = time.perf_counter()
    try:
        result = desc["run"](args)
    except Exception as exc:
        logger.exception("dispatch: tool %s.%s raised", worker, name)
        return {
            "ok": False,
            "error": {
                "code": "tool_exception",
                "message": str(exc),
                "retryable": True,
            },
        }
    latency_ms = int((time.perf_counter() - started) * 1000)
    if isinstance(result, dict) and "ok" in result:
        result.setdefault("latency_ms", latency_ms)
        return result
    return {"ok": True, "result": result, "latency_ms": latency_ms}


def _dispatch_stdio(worker: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """
    JSON-RPC over stdio to a worker subprocess.

    The worker subprocesses are managed by `app.agent.mcp_stdio.WorkerPool` —
    one persistent child process per worker, recycled on failure. The pool is
    lazy: workers are launched on first dispatch.

    Imported lazily so the in-process path stays zero-dependency. If the
    `mcp` SDK or worker code is unreachable, we degrade to the in-process
    fallback (which is the Phase 4 behavior the dispatcher already supports).
    """
    try:
        from app.agent.mcp_stdio import worker_pool
        return worker_pool.dispatch(worker, name, args)
    except ImportError:
        logger.warning("mcp_stdio unavailable, falling back to in_process dispatch")
        return _dispatch_in_process(worker, name, args)
    except Exception as exc:
        # Worker subprocess died, broken pipe, etc. Report as tool_unavailable
        # so specialists can replan around it (spec §13 graceful degradation).
        logger.exception("stdio dispatch to %s.%s failed", worker, name)
        return {
            "ok": False,
            "error": {
                "code": "tool_unavailable",
                "message": str(exc),
                "retryable": True,
            },
        }


def llm_tool_defs(worker_subset: list[str] | None = None) -> list[dict[str, Any]]:
    """
    Render the catalog into the `ToolDef` shape the LLM clients accept.
    `worker_subset` lets a specialist hand the LLM only its allowed tools.
    """
    out = []
    for desc in _REGISTRY.values():
        if worker_subset and desc["worker"] not in worker_subset:
            continue
        out.append({
            "name": f"{desc['worker']}__{desc['name']}",
            "description": desc["description"],
            "parameters": desc["input_schema"],
        })
    return out


def parse_tool_name(qualified: str) -> tuple[str, str]:
    """Split `worker__tool` back into `(worker, tool)`."""
    if "__" not in qualified:
        raise ValueError(f"Tool name must be qualified as worker__tool: {qualified!r}")
    worker, _, name = qualified.partition("__")
    return worker, name
