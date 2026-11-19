"""Unit coverage for `app.llm.retry`.

Targets the pure helpers (`rate_limit_delay`, `_suggested_delay_from_headers`)
and the `retry_async` decorator behavior. Real `asyncio.sleep` calls are
monkeypatched away so the retry path is exercised without wall-clock delay.

ISSUE #66 (fixed): `retry_async.wrapper` previously had an implicit-None
fall-through risk. The `for attempt in range(max_attempts)` loop only ever
`return`s inside the `try`, so if the loop ever exited without returning or
raising (e.g. an empty range when `max_attempts < 1`), the wrapper fell off the
end and silently returned `None`. The wrapper now has an explicit terminal
`raise` after the loop, so it can never return `None`. The tests below assert
that guarantee directly (loop-exhaustion path raises rather than returning None).
"""
from __future__ import annotations

import asyncio

import pytest

from app.llm import retry as retry_mod
from app.llm.retry import (
    rate_limit_delay,
    retry_async,
    _suggested_delay_from_headers,
)


# ── Fakes ──────────────────────────────────────────────────────────────────


class _RateLimitError(Exception):
    """Mimics a provider rate-limit error whose class name contains RateLimit."""

    def __init__(self, message: str = "RateLimit hit", status_code=None):
        super().__init__(message)
        self.status_code = status_code


class _FakeHeaders:
    def __init__(self, mapping):
        self._mapping = mapping

    def get(self, key, default=None):
        return self._mapping.get(key, default)


class _FakeResponse:
    def __init__(self, headers):
        self.headers = headers


class _Counter:
    """A fake async callable with a call counter that fails N times then succeeds."""

    def __init__(self, fail_times: int, exc_factory):
        self.calls = 0
        self.fail_times = fail_times
        self.exc_factory = exc_factory

    async def __call__(self, *args, **kwargs):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.exc_factory()
        return {"ok": True, "attempt": self.calls, "args": args, "kwargs": kwargs}


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    """Replace asyncio.sleep with an instant no-op so retries don't wait."""
    slept: list[float] = []

    async def _fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(retry_mod.asyncio, "sleep", _fake_sleep)
    return slept


# ── rate_limit_delay ───────────────────────────────────────────────────────


def test_rate_limit_delay_returns_none_for_non_retryable():
    assert rate_limit_delay(ValueError("totally unrelated")) is None


def test_rate_limit_delay_detects_status_code_429():
    exc = _RateLimitError("boom", status_code=429)
    # status 429 is retryable; no parseable suggested delay -> 0.0
    assert rate_limit_delay(exc) == 0.0


def test_rate_limit_delay_detects_status_code_503():
    exc = Exception("service unavailable")
    exc.status_code = 503
    assert rate_limit_delay(exc) == 0.0


def test_rate_limit_delay_status_code_as_digit_string():
    exc = Exception("rate limited")
    exc.status_code = "429"  # string status that .isdigit()
    assert rate_limit_delay(exc) == 0.0


def test_rate_limit_delay_detects_name_ratelimit():
    # Class name carries "RateLimit" but no status code.
    assert rate_limit_delay(_RateLimitError("slow down")) == 0.0


def test_rate_limit_delay_detects_resource_exhausted_message():
    exc = Exception("google says RESOURCE_EXHAUSTED for quota")
    assert rate_limit_delay(exc) == 0.0


def test_rate_limit_delay_detects_bare_429_message():
    exc = Exception("429 Too Many Requests")
    assert rate_limit_delay(exc) == 0.0


def test_rate_limit_delay_parses_gemini_retry_delay():
    exc = Exception("RESOURCE_EXHAUSTED retryDelay: 7.5 seconds")
    assert rate_limit_delay(exc) == 7.5


def test_rate_limit_delay_prefers_header_over_message():
    exc = _RateLimitError("429 retryDelay: 9", status_code=429)
    exc.response = _FakeResponse(_FakeHeaders({"retry-after": "3"}))
    # Header-suggested delay wins over the regex-parsed message value.
    assert rate_limit_delay(exc) == 3.0


# ── _suggested_delay_from_headers ──────────────────────────────────────────


def test_suggested_delay_none_when_no_response():
    assert _suggested_delay_from_headers(Exception("x")) is None


def test_suggested_delay_none_when_no_headers():
    exc = Exception("x")
    exc.response = _FakeResponse(None)
    assert _suggested_delay_from_headers(exc) is None


def test_suggested_delay_reads_retry_after_header():
    exc = Exception("x")
    exc.response = _FakeResponse(_FakeHeaders({"retry-after": "12"}))
    assert _suggested_delay_from_headers(exc) == 12.0


def test_suggested_delay_reads_capitalized_header():
    exc = Exception("x")
    exc.response = _FakeResponse(_FakeHeaders({"Retry-After": "4"}))
    assert _suggested_delay_from_headers(exc) == 4.0


def test_suggested_delay_invalid_value_returns_none():
    exc = Exception("x")
    exc.response = _FakeResponse(_FakeHeaders({"retry-after": "not-a-number"}))
    assert _suggested_delay_from_headers(exc) is None


# ── retry_async: success / retry / give-up ─────────────────────────────────


async def test_retry_async_succeeds_first_try():
    counter = _Counter(fail_times=0, exc_factory=lambda: _RateLimitError())
    wrapped = retry_async()(counter)
    result = await wrapped("a", k="v")
    assert result["ok"] is True
    assert counter.calls == 1
    # Args/kwargs are passed through untouched.
    assert result["args"] == ("a",)
    assert result["kwargs"] == {"k": "v"}


async def test_retry_async_retries_then_succeeds(no_sleep):
    counter = _Counter(fail_times=2, exc_factory=lambda: _RateLimitError(status_code=429))
    wrapped = retry_async(max_attempts=4, base_delay=2.0)(counter)
    result = await wrapped()
    assert result["ok"] is True
    assert counter.calls == 3  # failed twice, succeeded on the third
    # Two backoff sleeps happened (one per retry).
    assert len(no_sleep) == 2


async def test_retry_async_reraises_after_max_attempts(no_sleep):
    counter = _Counter(fail_times=99, exc_factory=lambda: _RateLimitError(status_code=429))
    wrapped = retry_async(max_attempts=3)(counter)
    with pytest.raises(_RateLimitError):
        await wrapped()
    assert counter.calls == 3  # exhausted exactly max_attempts tries
    # On the final attempt it raises instead of sleeping, so only 2 sleeps.
    assert len(no_sleep) == 2


async def test_retry_async_does_not_retry_non_rate_limit_error(no_sleep):
    def boom():
        return ValueError("hard failure, not retryable")

    counter = _Counter(fail_times=1, exc_factory=boom)
    wrapped = retry_async(max_attempts=4)(counter)
    with pytest.raises(ValueError):
        await wrapped()
    # Non-retryable: raised immediately, no retry, no sleep.
    assert counter.calls == 1
    assert len(no_sleep) == 0


async def test_retry_async_uses_exponential_backoff_when_no_suggested_delay(no_sleep):
    counter = _Counter(fail_times=2, exc_factory=lambda: _RateLimitError(status_code=429))
    wrapped = retry_async(max_attempts=4, base_delay=2.0, max_delay=30.0)(counter)
    await wrapped()
    # base_delay * 2**attempt for attempt 0 and 1 -> 2.0, 4.0
    assert no_sleep == [2.0, 4.0]


async def test_retry_async_honors_suggested_delay_capped_by_max_delay(no_sleep):
    def make_exc():
        e = _RateLimitError(status_code=429)
        e.response = _FakeResponse(_FakeHeaders({"retry-after": "1000"}))
        return e

    counter = _Counter(fail_times=1, exc_factory=make_exc)
    wrapped = retry_async(max_attempts=3, base_delay=2.0, max_delay=30.0)(counter)
    await wrapped()
    # Suggested delay 1000 is clamped down to max_delay (30.0).
    assert no_sleep == [30.0]


async def test_retry_async_preserves_function_metadata():
    @retry_async()
    async def my_named_fn():
        return 1

    # functools.wraps keeps the original name.
    assert my_named_fn.__name__ == "my_named_fn"


async def test_retry_async_streaming_path_is_pass_through():
    """Characterize the streaming no-op claim: when the wrapped coroutine
    returns an async iterator (the stream=True shape), the decorator returns it
    unchanged on the first successful call without interfering.

    NOTE (issue #66): the decorator wraps `complete` regardless of stream mode;
    it is only a transparent pass-through because the streaming `complete`
    returns its async iterator synchronously (no error at await time). The retry
    loop never inspects `stream`, so a future change that makes the streaming
    await raise would silently fall into the retry/None fall-through path.
    """

    async def _gen():
        yield {"delta_text": "hello"}
        yield {"delta_text": " world"}

    async def complete_stream(*, stream: bool = False):
        # Mirrors the real clients: return the async generator object directly.
        return _gen()

    wrapped = retry_async()(complete_stream)
    iterator = await wrapped(stream=True)
    collected = [chunk async for chunk in iterator]
    assert collected == [{"delta_text": "hello"}, {"delta_text": " world"}]


# ── issue #66: never implicitly return None ─────────────────────────────────


async def test_retry_async_never_returns_none_on_loop_exhaustion():
    """If the retry loop ever exits without returning or raising (an empty
    range when max_attempts < 1), the wrapper must raise rather than silently
    return None. Pre-fix this returned None; now it raises RuntimeError."""

    async def never_called(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("fn should never be invoked when max_attempts < 1")

    wrapped = retry_async(max_attempts=0)(never_called)
    with pytest.raises(RuntimeError):
        await wrapped()


async def test_retry_async_reraise_path_returns_non_none(no_sleep):
    """The give-up path raises the underlying error (never returns None)."""
    counter = _Counter(fail_times=99, exc_factory=lambda: _RateLimitError(status_code=429))
    wrapped = retry_async(max_attempts=2)(counter)
    with pytest.raises(_RateLimitError):
        await wrapped()


async def test_retry_async_success_result_is_never_none():
    """Sanity check the happy path never yields None for a real result."""
    counter = _Counter(fail_times=0, exc_factory=lambda: _RateLimitError())
    wrapped = retry_async()(counter)
    result = await wrapped()
    assert result is not None


# ── retry_async: streaming (#74) ───────────────────────────────────────────


class _StreamingClient:
    """`complete(stream=True)` returns an async iterator whose errors surface
    during iteration, the way every provider client's `_stream` does."""

    def __init__(self, fail_times: int, *, fail_after_chunks: int = 0, exc=None):
        self.fail_times = fail_times
        self.fail_after_chunks = fail_after_chunks
        self.exc = exc or (lambda: _RateLimitError(status_code=429))
        self.streams_opened = 0

    async def complete(self, *, stream: bool = False):
        assert stream
        return self._stream()

    async def _stream(self):
        self.streams_opened += 1
        failing = self.streams_opened <= self.fail_times
        for i in range(3):
            if failing and i == self.fail_after_chunks:
                raise self.exc()
            yield {"delta_text": f"c{i}"}


async def _collect(stream) -> list[str]:
    return [chunk["delta_text"] async for chunk in stream]


async def test_retry_async_retries_a_stream_that_fails_before_its_first_chunk(no_sleep):
    client = _StreamingClient(fail_times=2)
    complete = retry_async(max_attempts=4)(client.complete)

    assert await _collect(await complete(stream=True)) == ["c0", "c1", "c2"]
    assert client.streams_opened == 3
    assert len(no_sleep) == 2


async def test_retry_async_does_not_retry_a_stream_that_already_sent_text(no_sleep):
    # Retrying after text has been shown would repeat it.
    client = _StreamingClient(fail_times=1, fail_after_chunks=1)
    complete = retry_async(max_attempts=4)(client.complete)

    seen: list[str] = []
    with pytest.raises(_RateLimitError):
        async for chunk in await complete(stream=True):
            seen.append(chunk["delta_text"])
    assert seen == ["c0"]
    assert client.streams_opened == 1


async def test_retry_async_gives_up_on_a_stream_after_max_attempts(no_sleep):
    client = _StreamingClient(fail_times=99)
    complete = retry_async(max_attempts=3)(client.complete)

    with pytest.raises(_RateLimitError):
        await _collect(await complete(stream=True))
    assert client.streams_opened == 3


async def test_retry_async_does_not_retry_a_stream_on_other_errors(no_sleep):
    client = _StreamingClient(fail_times=1, exc=lambda: ValueError("bad request"))
    complete = retry_async(max_attempts=4)(client.complete)

    with pytest.raises(ValueError):
        await _collect(await complete(stream=True))
    assert client.streams_opened == 1


def test_gemini_usage_counts_thinking_tokens_as_output():
    """#74: thinking tokens are billed output; leaving them out undercounts the
    token budget."""
    from types import SimpleNamespace

    from app.llm.gemini_client import _usage

    meta = SimpleNamespace(prompt_token_count=100, candidates_token_count=40, thoughts_token_count=25)
    assert _usage(meta) == {"input_tokens": 100, "output_tokens": 65}
    # Fields the SDK leaves as None, and a missing usage object, count as 0.
    assert _usage(SimpleNamespace(prompt_token_count=7, candidates_token_count=None)) == {
        "input_tokens": 7, "output_tokens": 0,
    }
    assert _usage(None) == {"input_tokens": 0, "output_tokens": 0}
