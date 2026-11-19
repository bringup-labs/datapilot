"""
Provider-agnostic LLM client contract.

All four provider clients (Anthropic / OpenAI / Gemini / Ollama) implement
`LLMClient`. The agent layer talks only to this interface — switching providers
is a one-line change in `LLMRouter`.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Literal, Protocol, TypedDict, runtime_checkable

# ── Wire types ─────────────────────────────────────────────────────────────

MessageRole = Literal["system", "user", "assistant", "tool"]


class Message(TypedDict, total=False):
    role: MessageRole
    content: str
    # For role='assistant' when the model invoked tools:
    tool_calls: list["ToolCall"]
    # For role='tool' replying to a previous tool_call:
    tool_call_id: str
    name: str           # tool name (some providers expect it)


class ToolCall(TypedDict, total=False):
    id: str
    name: str
    arguments: dict[str, Any]
    thought_signature: str | bytes


class ToolDef(TypedDict):
    """JSON-Schema-described tool the LLM may call."""
    name: str
    description: str
    parameters: dict[str, Any]   # JSON Schema


class CompletionUsage(TypedDict):
    input_tokens: int
    output_tokens: int


class CompletionResponse(TypedDict):
    """Non-streaming completion result."""
    content: str
    tool_calls: list[ToolCall]
    usage: CompletionUsage
    finish_reason: Literal["stop", "length", "tool_use", "error"] | str


class CompletionChunk(TypedDict, total=False):
    """One streamed delta."""
    delta_text: str                # accumulating prose
    tool_call_delta: ToolCall      # arriving tool call (may be partial)
    usage: CompletionUsage         # only on the final chunk
    finish_reason: str             # only on the final chunk


# The `provider` value each client class reports. `nvidia` is NimClient's (#69).
# Note this is not the settings spelling: the `default_provider` setting says
# "google" for the provider whose client reports "gemini"; the router accepts both.
ProviderName = Literal["anthropic", "openai", "gemini", "nvidia", "ollama", "mock"]


# ── Client Protocol ────────────────────────────────────────────────────────


@runtime_checkable
class LLMClient(Protocol):
    """
    Every provider client implements this. Methods are async because all
    underlying SDKs do real network I/O.
    """

    model_id: str
    provider: ProviderName

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
        """
        Run a completion.

        - When `stream=False` (default) returns `CompletionResponse` synchronously.
        - When `stream=True` returns an async iterator of `CompletionChunk`s.
        - `response_format` is a JSON Schema — providers that support structured
          output use it directly; others fall back to a system-prompt rider.
        """
        ...
