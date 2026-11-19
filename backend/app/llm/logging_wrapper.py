"""
Transparent LLM client wrapper.

Prompt/response *content* logging is **opt-in** and OFF by default. It is
enabled only when the environment variable ``DATAPILOT_PROMPT_LOGGING`` is set
to ``"1"``. When disabled (the default), the wrapper passes calls straight
through to the inner client and writes no prompt or response content anywhere —
system prompts, user/assistant messages, and model output never touch disk.

When enabled, every ``complete()`` call is written as a single JSON line to a
rotating log file at ``${DATAPILOT_DATA_DIR}/llm_prompts.log``:
  {"ts": "…", "direction": "request", "provider": "…", "model": "…", "system": "…", "messages": […]}
  {"ts": "…", "direction": "response", "provider": "…", "model": "…", "content": "…", "usage": {…}}
"""
from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import os
import threading
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from app.llm.base import CompletionChunk, CompletionResponse, LLMClient, Message, ProviderName, ToolDef

_logger_lock = threading.Lock()


def prompt_logging_enabled() -> bool:
    """True only when prompt/response content logging is explicitly opted in.

    Read live from the environment (not cached) so tests and runtime toggles
    take effect without a process restart.
    """
    return os.environ.get("DATAPILOT_PROMPT_LOGGING") == "1"


def _get_prompt_logger() -> logging.Logger:
    log = logging.getLogger("datapilot.llm_prompts")
    if log.handlers:
        return log
    # Double-checked locking: re-test inside the lock to avoid a race where two
    # coroutines both see `handlers` empty before either adds the handler.
    with _logger_lock:
        if not log.handlers:
            from app.config import settings
            log_path = os.path.join(settings.datapilot_data_dir, "llm_prompts.log")
            os.makedirs(settings.datapilot_data_dir, exist_ok=True)

            handler = logging.handlers.RotatingFileHandler(
                log_path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8"
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            log.addHandler(handler)
            log.setLevel(logging.DEBUG)
            log.propagate = False
    return log


def _write(entry: dict[str, Any]) -> None:
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    try:
        _get_prompt_logger().debug(json.dumps(entry, default=str))
    except Exception:
        pass  # never let logging break the request


class LoggingLLMClient:
    """Wraps any LLMClient and writes every complete() call to the prompt log."""

    def __init__(self, inner: LLMClient) -> None:
        self._inner = inner
        self.model_id: str = inner.model_id
        self.provider: ProviderName = inner.provider

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
        logging_on = prompt_logging_enabled()

        if logging_on:
            # Offload the synchronous file write so it never blocks the event loop.
            await asyncio.to_thread(_write, {
                "direction": "request",
                "provider": self.provider,
                "model": self.model_id,
                "system": system,
                "messages": messages,
                "stream": stream,
            })

        result = await self._inner.complete(
            system=system,
            messages=messages,
            tools=tools,
            response_format=response_format,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=stream,
        )

        if not stream:
            if logging_on:
                await asyncio.to_thread(_write, {
                    "direction": "response",
                    "provider": self.provider,
                    "model": self.model_id,
                    "content": result.get("content", ""),       # type: ignore[union-attr]
                    "tool_calls": result.get("tool_calls", []), # type: ignore[union-attr]
                    "usage": result.get("usage", {}),           # type: ignore[union-attr]
                    "finish_reason": result.get("finish_reason", ""),  # type: ignore[union-attr]
                })
            return result

        # Streaming: when logging is off, return the inner stream untouched so
        # the wrapper is fully transparent (no accumulation, no content write).
        if not logging_on:
            return result  # type: ignore[return-value]

        return self._log_stream(result)  # type: ignore[arg-type]

    async def _log_stream(
        self, stream: AsyncIterator[CompletionChunk]
    ) -> AsyncIterator[CompletionChunk]:
        accumulated = ""
        usage: dict[str, Any] = {}
        finish_reason = ""
        async for chunk in stream:
            if chunk.get("delta_text"):
                accumulated += chunk["delta_text"]
            if chunk.get("usage"):
                usage = dict(chunk["usage"])
            if chunk.get("finish_reason"):
                finish_reason = chunk["finish_reason"]
            yield chunk
        await asyncio.to_thread(_write, {
            "direction": "response",
            "provider": self.provider,
            "model": self.model_id,
            "content": accumulated,
            "usage": usage,
            "finish_reason": finish_reason,
        })
