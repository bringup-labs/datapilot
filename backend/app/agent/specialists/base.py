"""
BaseSpecialist — shared run/ReAct logic.

Two flavors:
  - SpecialistKind.FULL: plan-then-execute internal loop (RCA, Anomaly).
    The specialist's LLM gets the tool catalog and iterates ReAct-style until
    it returns its final structured output (or hits the local iteration cap).
  - SpecialistKind.LIGHT: single LLM call with structured output.
    For Performance / Replay / Safety / Compare today — Phase 5+ deepens.

Both flavors emit AuditEvents to the GraphState's audit_trail.
"""
from __future__ import annotations

import json
import logging
import time
from enum import Enum
from pathlib import Path
from typing import Any

from app.agent.mcp_client import dispatch, llm_tool_defs, parse_tool_name
from app.agent.state import AuditEvent, Finding, SpecResult, SpecialistName
from app.llm.base import CompletionResponse, LLMClient, Message
from app.llm.router import LLMRouter

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent.parent / "prompts" / "specialists"

# Per-specialist internal iteration cap — bounds the ReAct loop.
INTERNAL_MAX_ITERS = 8


def _collect_strings(value: Any, into: set[str]) -> None:
    """Add every string found anywhere in a tool result to `into`."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            into.add(item)
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, (list, tuple)):
            stack.extend(item)


class SpecialistKind(str, Enum):
    FULL = "full"
    LIGHT = "light"


def _truncate(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


class BaseSpecialist:
    """Override class attributes; subclasses don't usually override `run`."""

    name: SpecialistName
    kind: SpecialistKind = SpecialistKind.LIGHT
    prompt_path: Path
    worker_subset: list[str]            # which MCP workers' tools to expose
    output_schema: dict[str, Any]       # JSON Schema the LLM must match

    @classmethod
    def system_prompt(cls) -> str:
        return cls.prompt_path.read_text(encoding="utf-8")

    async def run(
        self,
        *,
        router: LLMRouter,
        session_id: str,
        intent: str,
        session_summary: str,
    ) -> tuple[SpecResult, list[AuditEvent]]:
        """Execute the specialist. Returns (SpecResult, audit_events)."""
        audit: list[AuditEvent] = []
        started = time.perf_counter()
        audit.append({
            "step_kind": "specialist_start",
            "specialist": self.name,
            "ts": started,
            "args_summary": _truncate(intent, 200),
        })

        client = router.for_specialist(self.name)
        tool_defs = llm_tool_defs(worker_subset=self.worker_subset)

        try:
            if self.kind is SpecialistKind.LIGHT:
                result = await self._run_light(client, intent, session_id, session_summary, audit)
            else:
                result = await self._run_full(client, intent, session_id, session_summary, tool_defs, audit)
        except Exception as exc:
            logger.exception("specialist %s failed", self.name)
            audit.append({
                "step_kind": "error",
                "specialist": self.name,
                "ts": time.perf_counter(),
                "result_summary": _truncate(str(exc), 400),
            })
            return SpecResult(
                specialist=self.name,
                findings=[],
                confidence=0.0,
                error=str(exc),
            ), audit

        return result, audit

    # ── Light: single structured-output call ─────────────────────────────────

    async def _run_light(
        self,
        client: LLMClient,
        intent: str,
        session_id: str,
        session_summary: str,
        audit: list[AuditEvent],
    ) -> SpecResult:
        user = (
            f"Session: {session_id}\n{session_summary}\n\n"
            f"Specialist intent: {intent}\n\n"
            "Respond with the JSON object matching your output schema."
        )
        messages: list[Message] = [{"role": "user", "content": user}]
        resp = await client.complete(
            system=self.system_prompt(),
            messages=messages,
            response_format=self.output_schema,
            temperature=0.1,
        )
        assert isinstance(resp, dict), "non-stream complete must return dict"
        audit.append({
            "step_kind": "compose",
            "specialist": self.name,
            "ts": time.perf_counter(),
            "tokens_in": resp["usage"]["input_tokens"],
            "tokens_out": resp["usage"]["output_tokens"],
        })
        parsed = self._parse_structured(resp)
        parsed["specialist"] = self.name
        return parsed  # type: ignore[return-value]

    # ── Full: ReAct loop with tools ──────────────────────────────────────────

    async def _run_full(
        self,
        client: LLMClient,
        intent: str,
        session_id: str,
        session_summary: str,
        tool_defs: list[dict[str, Any]],
        audit: list[AuditEvent],
    ) -> SpecResult:
        user = (
            f"Session: {session_id}\n{session_summary}\n\n"
            f"Specialist intent: {intent}\n\n"
            "Use the tools to gather evidence, then respond with the JSON object "
            "matching your output schema. Cite real log_ids returned by your tool calls."
        )
        messages: list[Message] = [{"role": "user", "content": user}]
        last_text = ""
        observed: set[str] = set()   # every string a tool returned this run

        for iteration in range(INTERNAL_MAX_ITERS):
            resp = await client.complete(
                system=self.system_prompt(),
                messages=messages,
                tools=tool_defs,
                temperature=0.1,
            )
            assert isinstance(resp, dict)
            audit.append({
                "step_kind": "tool_call" if resp["tool_calls"] else "compose",
                "specialist": self.name,
                "ts": time.perf_counter(),
                "tokens_in": resp["usage"]["input_tokens"],
                "tokens_out": resp["usage"]["output_tokens"],
            })

            if not resp["tool_calls"]:
                # Model produced its final answer.
                last_text = resp["content"]
                break

            # Append the assistant turn carrying the tool_calls.
            # content MUST be None (not "") when tool_calls are present —
            # NIM and most OpenAI-compatible providers reject messages that
            # have both a non-null content and tool_calls (HTTP 400).
            messages.append({
                "role": "assistant",
                "content": resp["content"] or None,
                "tool_calls": resp["tool_calls"],
            })

            # Dispatch each tool call and feed the results back.
            for tc in resp["tool_calls"]:
                worker, name = parse_tool_name(tc["name"])
                # Always inject session_id from outer state — specialists shouldn't have to thread it.
                args = {**tc["arguments"], "session_id": session_id}
                tool_result = dispatch(worker, name, args)
                _collect_strings(tool_result, observed)
                audit.append({
                    "step_kind": "tool_result",
                    "specialist": self.name,
                    "tool": tc["name"],
                    "ts": time.perf_counter(),
                    "args_summary": _truncate(json.dumps(args), 200),
                    "result_summary": _truncate(json.dumps(tool_result)[:600], 400),
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "name": tc["name"],
                    "content": json.dumps(tool_result),
                })
        else:
            # The loop ran out while the model was still calling tools. Ask once
            # more with no tools on offer so the evidence gathered so far becomes
            # an answer instead of an `empty_response` (#57).
            logger.warning("specialist %s hit INTERNAL_MAX_ITERS without final answer", self.name)
            messages.append({
                "role": "user",
                "content": (
                    "You have no tool calls left. Using only the tool results above, "
                    "respond now with the JSON object matching your output schema."
                ),
            })
            resp = await client.complete(
                system=self.system_prompt(),
                messages=messages,
                temperature=0.1,
            )
            assert isinstance(resp, dict)
            audit.append({
                "step_kind": "compose",
                "specialist": self.name,
                "ts": time.perf_counter(),
                "tokens_in": resp["usage"]["input_tokens"],
                "tokens_out": resp["usage"]["output_tokens"],
            })
            last_text = resp["content"] or ""

        # Parse the final response into the specialist's output schema.
        parsed = self._parse_text_as_result(last_text)
        parsed["specialist"] = self.name

        # Re-ground: a cited log_id should have appeared in a tool result this
        # run. The composer only checks that an id exists in Neo4j, not that this
        # run saw it, so an id recalled from elsewhere would pass. Flag it in the
        # audit trail; the findings themselves are left for the composer (#57).
        cited = {
            lid
            for f in parsed.get("findings") or []
            if isinstance(f, dict)
            for lid in f.get("log_ids") or []
            if isinstance(lid, str)
        }
        unseen = sorted(cited - observed)
        if unseen:
            logger.warning("specialist %s cited log_ids no tool returned: %s", self.name, unseen)
            audit.append({
                "step_kind": "error",
                "specialist": self.name,
                "ts": time.perf_counter(),
                "result_summary": _truncate(
                    f"{len(unseen)} cited log_id(s) not returned by any tool this run: {', '.join(unseen)}",
                    400,
                ),
            })
        return parsed  # type: ignore[return-value]

    # ── Parsing helpers ──────────────────────────────────────────────────────

    def _parse_structured(self, resp: CompletionResponse) -> dict[str, Any]:
        """Light-mode parse: providers with native JSON-Schema put the object
        directly in `content`; others may rider the schema and still return
        JSON. We extract the first {...} balanced block as a fallback."""
        return self._parse_text_as_result(resp["content"])

    def _parse_text_as_result(self, text: str) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"findings": [], "confidence": 0.0, "error": "empty_response"}
        # Strip ```json fences if present.
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text
            if text.endswith("```"):
                text = text[: text.rfind("```")]
        text = text.strip()
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            # Find first balanced {...}
            start = text.find("{")
            end = text.rfind("}")
            if start != -1 and end > start:
                try:
                    obj = json.loads(text[start : end + 1])
                except json.JSONDecodeError:
                    return {"findings": [], "confidence": 0.0, "error": "malformed_json"}
            else:
                return {"findings": [], "confidence": 0.0, "error": "no_json"}

        # Normalize: every specialist returns at minimum {findings, confidence}.
        obj.setdefault("findings", [])
        obj.setdefault("confidence", 0.5)
        # Coerce confidence into [0, 1].
        try:
            obj["confidence"] = max(0.0, min(1.0, float(obj["confidence"])))
        except (TypeError, ValueError):
            obj["confidence"] = 0.5
        # Drop any non-dict entries in findings (malformed LLM output guard).
        # Non-dict items (e.g. strings) would cause AttributeError downstream.
        findings = obj.get("findings")
        if not isinstance(findings, list):
            findings = []
        obj["findings"] = [f for f in findings if isinstance(f, dict)]
        # Ensure findings have log_ids field.
        for f in obj["findings"]:
            f.setdefault("log_ids", [])
        return obj
