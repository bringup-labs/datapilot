"""#69: JSON endpoints declare their response schema, the `final` SSE payload is
checked against `ChatMessageEnvelope`, and the provider type covers every client."""
from __future__ import annotations

from typing import get_args

import pytest

from app.api.chat import _checked_envelope
from app.llm.base import ProviderName
from app.main import app

_JSON_ENDPOINTS = [
    ("post", "/api/sessions/create", "202"),
    ("delete", "/api/sessions/{session_id}", "200"),
    ("delete", "/api/sessions", "200"),
    ("get", "/api/sessions/{session_id}/messages", "200"),
    ("get", "/api/mcp/servers", "200"),
    ("post", "/api/mcp/servers/{worker_id}/toggle", "200"),
    ("post", "/api/settings/test-key", "200"),
    ("post", "/api/settings/models", "200"),
    ("post", "/api/settings/keys", "200"),
    ("post", "/api/settings/reload-secrets", "200"),
    ("get", "/api/settings/agent-models", "200"),
    ("put", "/api/settings/agent-models/{specialist}", "200"),
    ("delete", "/api/settings/agent-models/{specialist}", "200"),
]


@pytest.mark.parametrize("method,path,status", _JSON_ENDPOINTS)
def test_endpoint_declares_a_response_schema(method, path, status):
    operation = app.openapi()["paths"][path][method]
    schema = operation["responses"][status]["content"]["application/json"]["schema"]
    # An endpoint with no response_model documents an empty schema.
    assert schema, f"{method.upper()} {path} has no response model"


def _envelope(**over):
    base = {
        "response": "done",
        "plan": [],
        "findings": [{"sev": "critical", "text": "A", "log_ids": ["l_1"]}],
        "causal": [{"label": "x"}],
        "audit_trail": [],
        "citations": [{"log_id": "l_1", "ts": 1.0, "node": "/n", "snippet": "s"}],
        "usage": {"tokens_in": 1, "tokens_out": 2, "est_cost_usd": 0.0},
        "partial": False,
    }
    base.update(over)
    return base


def test_checked_envelope_returns_a_valid_envelope_unchanged():
    envelope = _envelope()
    assert _checked_envelope(envelope) is envelope


def test_checked_envelope_drops_only_the_malformed_items():
    envelope = _envelope(findings=[
        {"sev": "critical", "text": "A", "log_ids": ["l_1"]},
        {"sev": "warning"},                 # no text, no log_ids
        "not a finding",
    ])
    out = _checked_envelope(envelope)
    assert out["findings"] == [{"sev": "critical", "text": "A", "log_ids": ["l_1"]}]
    assert out["citations"] == envelope["citations"]
    assert out["response"] == "done"


def test_checked_envelope_rejects_an_envelope_it_cannot_repair():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        _checked_envelope(_envelope(response=None))


def test_provider_type_covers_every_client():
    from app.llm.nim_client import NimClient

    assert NimClient.provider == "nvidia"
    assert "nvidia" in get_args(ProviderName)
