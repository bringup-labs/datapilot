"""Google Gemini client."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from app.config import settings
from app.llm.base import (
    CompletionChunk,
    CompletionResponse,
    Message,
    ToolCall,
    ToolDef,
)
from app.llm.retry import llm_timeout_seconds, retry_async

logger = logging.getLogger(__name__)


def _clean_schema(d: Any) -> Any:
    """Recursively remove additionalProperties/additional_properties from schemas.
    The Gemini API / google-genai SDK does not support them in tool declarations.
    """
    if isinstance(d, dict):
        return {
            k: _clean_schema(v)
            for k, v in d.items()
            if k not in ("additionalProperties", "additional_properties")
        }
    elif isinstance(d, list):
        return [_clean_schema(x) for x in d]
    return d


def _to_gemini_function_declarations(tools: list[ToolDef]) -> list[dict[str, Any]]:
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "parameters": _clean_schema(t["parameters"]),
        }
        for t in tools
    ]


def _to_gemini_contents(messages: list[Message]) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for m in messages:
        role = m["role"]
        if role == "system":
            continue
        # Gemini uses 'user' and 'model' for assistant
        gem_role = "model" if role == "assistant" else "user"
        if role == "assistant" and m.get("tool_calls"):
            parts: list[dict[str, Any]] = []
            if m.get("content"):
                parts.append({"text": m["content"]})
            for tc in m["tool_calls"]:
                fc_part: dict[str, Any] = {"function_call": {"name": tc["name"], "args": tc["arguments"]}}
                if "thought_signature" in tc:
                    fc_part["thought_signature"] = tc["thought_signature"]
                parts.append(fc_part)
        elif role == "tool":
            parts = [{
                "function_response": {
                    "name": m.get("name", "tool"),
                    "response": {"content": m.get("content", "")},
                }
            }]
        else:
            parts = [{"text": m.get("content", "")}]

        # Gemini rejects consecutive turns with the same role — merge parts instead.
        if contents and contents[-1]["role"] == gem_role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": gem_role, "parts": parts})
    return contents


def _usage(meta: Any) -> dict[str, int]:
    """Token usage from a response's `usage_metadata`.

    Thinking tokens are billed as output but reported apart from
    `candidates_token_count`, so they are added in: leaving them out undercounts
    what the token-budget guardrail sees (#74). The SDK leaves absent counts as
    None.
    """
    def count(name: str) -> int:
        return int(getattr(meta, name, 0) or 0)

    return {
        "input_tokens": count("prompt_token_count"),
        "output_tokens": count("candidates_token_count") + count("thoughts_token_count"),
    }


class GeminiClient:
    provider = "gemini"

    def __init__(self, model_id: str):
        from google import genai
        # Explicit per-request timeout so a hung provider can't stall the agent
        # turn indefinitely (#65/#48). google-genai expects the timeout in
        # milliseconds via http_options, unlike the seconds-based SDKs.
        http_options = {"timeout": int(llm_timeout_seconds() * 1000)}
        self.client = genai.Client(api_key=settings.gemini_api_key, http_options=http_options)
        self.model_id = model_id
        self._genai = genai
        
        # Parse actual model name and thinking configuration settings
        self.actual_model_name = model_id
        self.thinking_level = None
        
        if "gemini-3.5-flash" in model_id:
            self.actual_model_name = "gemini-3.5-flash"
            if "medium" in model_id.lower():
                self.thinking_level = "MEDIUM"
            elif "high" in model_id.lower():
                self.thinking_level = "HIGH"
        elif "gemini-3.1-pro" in model_id:
            self.actual_model_name = "gemini-3.1-pro-preview"

    @retry_async()
    async def complete(
        self,
        *,
        system: str,
        messages: list[Message],
        tools: list[ToolDef] | None = None,
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        stream: bool = False,
    ) -> CompletionResponse | AsyncIterator[CompletionChunk]:
        generation_config_dict: dict[str, Any] = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
            "system_instruction": system,
        }
        if response_format:
            generation_config_dict["response_mime_type"] = "application/json"
            # Use response_json_schema (accepts standard JSON Schema including
            # additionalProperties, minItems, etc.) instead of response_schema
            # which only accepts Gemini's native Schema type.
            generation_config_dict["response_json_schema"] = response_format

        if self.thinking_level:
            generation_config_dict["thinking_config"] = {
                "thinking_budget": 2048 if self.thinking_level == "HIGH" else 1024
            }

        if tools:
            generation_config_dict["tools"] = [{"function_declarations": _to_gemini_function_declarations(tools)}]

        contents = _to_gemini_contents(messages)

        if stream:
            return self._stream(contents, generation_config_dict)

        resp = await self.client.aio.models.generate_content(
            model=self.actual_model_name,
            contents=contents,
            config=generation_config_dict,
        )
        
        # resp.text raises ValueError when the response contains no text parts
        # (e.g. a pure function-call response). Fall back to empty string.
        try:
            text = resp.text or ""
        except ValueError:
            text = ""
        tool_calls: list[ToolCall] = []
        for candidate in getattr(resp, "candidates", []) or []:
            if not getattr(candidate, "content", None):
                continue
            for part in getattr(candidate.content, "parts", []) or []:
                fc = getattr(part, "function_call", None)
                if fc:
                    tc_dict: ToolCall = {
                        "id": f"gemini_{fc.name}_{len(tool_calls)}",
                        "name": fc.name,
                        "arguments": dict(fc.args) if getattr(fc, "args", None) else {},
                    }
                    if getattr(part, "thought_signature", None):
                        tc_dict["thought_signature"] = part.thought_signature
                    tool_calls.append(tc_dict)

        usage = getattr(resp, "usage_metadata", None)
        return {
            "content": text,
            "tool_calls": tool_calls,
            "usage": _usage(usage),
            "finish_reason": "stop",
        }

    async def _stream(self, contents: list[dict[str, Any]], config: dict[str, Any]) -> AsyncIterator[CompletionChunk]:
        stream = await self.client.aio.models.generate_content_stream(
            model=self.actual_model_name,
            contents=contents,
            config=config,
        )
        last_usage: dict[str, int] | None = None
        async for chunk in stream:
            # chunk.text raises ValueError for non-text chunks (e.g. function calls).
            try:
                text = chunk.text
            except ValueError:
                text = None
            if text:
                yield {"delta_text": text}
            if hasattr(chunk, "usage_metadata") and chunk.usage_metadata:
                last_usage = _usage(chunk.usage_metadata)
        yield {"usage": last_usage or {"input_tokens": 0, "output_tokens": 0}, "finish_reason": "stop"}
