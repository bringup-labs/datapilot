"""Shared rate-limit retry/backoff for LLM provider clients.

Every provider raises a different exception type on a 429, but they all need the
same treatment: wait (honoring the server-suggested delay when present) and retry
a few times before giving up. `retry_async` is a decorator for an async `complete`
method.

With `stream=True` the method returns its async iterator immediately and errors
surface during iteration, not at `await`. So the decorator also wraps a returned
iterator: an error raised before the first chunk reopens the stream with the
same backoff. Once a chunk has been passed on, the error is raised as is,
because retrying would repeat text the caller has already shown.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import os
import re
from typing import Any, Awaitable, Callable, TypeVar

logger = logging.getLogger(__name__)

_RETRYABLE_STATUS = {429, 503}

# Per-request timeout (seconds) for cloud provider SDK clients. Without an
# explicit timeout a hung provider stalls the whole agent turn indefinitely
# (#65/#48). The value is configurable via the DATAPILOT_LLM_TIMEOUT env var and
# falls back to a sane default. Each cloud client reads this when constructing
# its SDK client; the local Ollama client sets its own httpx timeout already.
_DEFAULT_LLM_TIMEOUT_SECONDS = 60.0


def llm_timeout_seconds() -> float:
    """Return the configured per-request LLM timeout in seconds.

    Reads ``DATAPILOT_LLM_TIMEOUT`` from the environment; non-numeric or
    non-positive values fall back to the default so a misconfigured env var can
    never disable the timeout.
    """
    raw = os.environ.get("DATAPILOT_LLM_TIMEOUT")
    if raw is None:
        return _DEFAULT_LLM_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return _DEFAULT_LLM_TIMEOUT_SECONDS
    return value if value > 0 else _DEFAULT_LLM_TIMEOUT_SECONDS
_RETRY_DELAY_RE = re.compile(r"['\"]?retry(?:Delay|-after)['\"]?[:\s]+['\"]?([0-9.]+)", re.IGNORECASE)


def rate_limit_delay(exc: BaseException) -> float | None:
    """Return a retry delay (seconds) if `exc` is a retryable rate-limit/transient
    error, else None. The delay is the server-suggested value when we can cheaply
    extract one; otherwise 0.0 (caller falls back to exponential backoff)."""
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if isinstance(status, str) and status.isdigit():
        status = int(status)
    name = type(exc).__name__
    msg = str(exc)

    is_rate_limited = (
        status in _RETRYABLE_STATUS
        or "RateLimit" in name
        or "RESOURCE_EXHAUSTED" in msg
        or " 429 " in f" {msg} "
        or msg.strip().startswith("429")
    )
    if not is_rate_limited:
        return None

    # Honor a server-suggested delay if one is parseable (Gemini `retryDelay`,
    # or a Retry-After header surfaced in the message).
    suggested = _suggested_delay_from_headers(exc)
    if suggested is not None:
        return suggested
    m = _RETRY_DELAY_RE.search(msg)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return 0.0


def _suggested_delay_from_headers(exc: BaseException) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    try:
        value = headers.get("retry-after") or headers.get("Retry-After")
    except Exception:
        return None
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


F = TypeVar("F", bound=Callable[..., Awaitable[Any]])


def retry_async(max_attempts: int = 4, base_delay: float = 2.0, max_delay: float = 30.0) -> Callable[[F], F]:
    """Decorate an async method to retry on rate-limit errors with backoff."""

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            async def _retrying_stream(stream: Any, first_attempt: int) -> Any:
                """Pass `stream` through, reopening it when it fails with a
                rate-limit error before its first chunk."""
                attempt = first_attempt
                while True:
                    started = False
                    try:
                        async for chunk in stream:
                            started = True
                            yield chunk
                        return
                    except Exception as exc:  # noqa: BLE001 — re-raised if not retryable
                        delay = rate_limit_delay(exc)
                        if started or delay is None or attempt >= max_attempts - 1:
                            raise
                        wait = min(delay or (base_delay * (2 ** attempt)), max_delay)
                        logger.warning(
                            "LLM stream rate-limited (%s); retry %d/%d in %.1fs",
                            type(exc).__name__, attempt + 1, max_attempts - 1, wait,
                        )
                        await asyncio.sleep(wait)
                        attempt += 1
                        stream = await fn(*args, **kwargs)

            last_exc: BaseException | None = None
            for attempt in range(max_attempts):
                try:
                    result = await fn(*args, **kwargs)
                    if hasattr(result, "__aiter__"):
                        return _retrying_stream(result, attempt)
                    return result
                except Exception as exc:  # noqa: BLE001 — re-raised below if not retryable
                    last_exc = exc
                    delay = rate_limit_delay(exc)
                    if delay is None or attempt == max_attempts - 1:
                        raise
                    wait = min(delay or (base_delay * (2 ** attempt)), max_delay)
                    logger.warning(
                        "LLM rate-limited (%s); retry %d/%d in %.1fs",
                        type(exc).__name__, attempt + 1, max_attempts - 1, wait,
                    )
                    await asyncio.sleep(wait)
            # The loop can only exit without returning/raising when the range is
            # empty (max_attempts < 1). Never fall off the end implicitly
            # returning None — re-raise the last error if we captured one, else
            # surface a clear programming error.
            if last_exc is not None:
                raise last_exc
            raise RuntimeError(
                f"retry_async exhausted without making an attempt (max_attempts={max_attempts})"
            )

        return wrapper  # type: ignore[return-value]

    return decorator
