"""In-memory store of findings Claude Code submits during a DataPilot turn."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class StoredTurn:
    session_id: str
    created: float
    findings: list[dict] = field(default_factory=list)
    causal: list[dict] = field(default_factory=list)


class TurnStore:
    """Bounded by count and age. A turn lives only for one question."""

    def __init__(
        self,
        max_turns: int = 256,
        ttl_s: float = 3600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_turns = max_turns
        self._ttl_s = ttl_s
        self._clock = clock
        self._turns: dict[str, StoredTurn] = {}  # insertion order == age order

    def create(self, session_id: str) -> str:
        now = self._clock()
        for tid in [t for t, s in self._turns.items() if now - s.created > self._ttl_s]:
            del self._turns[tid]
        turn_id = uuid.uuid4().hex
        self._turns[turn_id] = StoredTurn(session_id=session_id, created=now)
        while len(self._turns) > self._max_turns:
            del self._turns[next(iter(self._turns))]
        return turn_id

    def _get(self, session_id: str, turn_id: str | None) -> StoredTurn | None:
        turn = self._turns.get(turn_id) if turn_id else None
        return turn if turn is not None and turn.session_id == session_id else None

    def exists(self, session_id: str, turn_id: str | None) -> bool:
        return self._get(session_id, turn_id) is not None

    def submit(self, session_id: str, turn_id: str | None, findings: list[dict], causal: list[dict]) -> bool:
        turn = self._get(session_id, turn_id)
        if turn is None:
            return False
        turn.findings = list(findings)
        turn.causal = list(causal)
        return True

    def pop(self, session_id: str, turn_id: str | None) -> StoredTurn | None:
        if self._get(session_id, turn_id) is None:
            return None
        return self._turns.pop(turn_id)

    def discard_session(self, session_id: str) -> None:
        for tid in [t for t, s in self._turns.items() if s.session_id == session_id]:
            del self._turns[tid]

    def clear(self) -> None:
        self._turns.clear()

    def __len__(self) -> int:
        return len(self._turns)


turn_store = TurnStore()
