from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

class Settings(BaseSettings):
    # pydantic-settings v2 auto-maps each field to its UPPER_SNAKE env var by
    # name (case-insensitive), so the explicit `Field(env=...)` mappings the v1
    # code used are unnecessary — and were silently ignored under v2 (issue #77).
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "datapilot-local"
    datapilot_data_dir: str = "/data"
    datapilot_host_mount: str = "/host"
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    ollama_host: str = "http://host.docker.internal:11434"
    default_provider: Optional[str] = None
    default_model: Optional[str] = None
    # Path (inside the container) to a JSON {provider: key} secret file the
    # Electron main process bind-mounts read-only. Read at startup and on
    # /settings/reload-secrets so API keys never arrive via Env or HTTP (#39/#32).
    datapilot_secrets_file: Optional[str] = None
    # Ceiling on one MCP tool call, whichever transport runs it. Past it the
    # caller gets a retryable `tool_timeout` error (#58). Matches the stdio
    # transport's own deadline; bag-wide `query_mcap` scans need the headroom.
    tool_timeout_s: float = 30.0

settings = Settings()
