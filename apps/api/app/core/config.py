"""Runtime settings. Every value can be overridden with an ``ATLAS_`` environment variable."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/api/app/core/config.py -> repository root is four levels up.
REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ATLAS_", env_file=".env", extra="ignore")

    app_name: str = "ATLAS — Data Intelligence Studio"
    data_dir: Path = Field(default=REPO_ROOT / "data" / "workspaces")
    samples_dir: Path = Field(default=REPO_ROOT / "data" / "samples")
    cors_origins: list[str] = Field(
        default=["http://localhost:3000", "http://127.0.0.1:3000"]
    )
    # Host names the API answers to (DNS-rebinding guard, see app/core/security.py). Ports are ignored.
    allowed_hosts: list[str] = Field(default=["127.0.0.1", "localhost"])

    # Upload and memory limits.
    max_upload_mb: int = 500
    max_rows: int = 5_000_000
    max_columns: int = 2_000
    max_uncompressed_mb: int = 4_096  # xlsx is a zip archive: refuse parts that expand beyond this

    # Response-size limits: the browser never receives whole datasets.
    preview_rows: int = 50
    max_page_size: int = 500
    max_chart_points: int = 5_000
    max_categories: int = 30
    max_series: int = 8

    # Profiling: expensive statistics run on a disclosed sample above this size.
    profile_sample_rows: int = 200_000
    max_correlation_columns: int = 30

    # Modeling.
    model_max_train_rows: int = 200_000
    model_workers: int = 2
    dataframe_cache_size: int = 4

    # ---- Conversation Quality Analytics (app/cqa) ----------------------------------------------------
    # The organizers' GET endpoint. It carries a signed token, so it lives in .env only (never in git).
    # `group_id` is set on this URL per import; any group_id already in the URL is replaced.
    cqa_source_url: str | None = None
    cqa_source_timeout_s: float = 60.0
    # Synthetic, clearly labeled fixtures for development and tests (group ids starting with "FIXTURE").
    cqa_fixtures_enabled: bool = True
    # Evaluator adapter used when a request does not name one: "openai" (GPT through the OpenAI API), "http",
    # "mock" (development only, not AI), or a name registered with @register_adapter (see app/cqa/adapters).
    cqa_evaluator: str = "openai"
    # OpenAI GPT evaluator. The key is read from ATLAS_CQA_OPENAI_API_KEY or OPENAI_API_KEY (environment or the
    # git-ignored .env only); it never reaches the browser. Setting it is the opt-in to send transcripts to OpenAI.
    cqa_openai_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("cqa_openai_api_key", "ATLAS_CQA_OPENAI_API_KEY", "OPENAI_API_KEY"))
    cqa_openai_model: str = "gpt-4.1"
    cqa_openai_base_url: str = "https://api.openai.com/v1"
    cqa_openai_timeout_s: float = 120.0
    # Total tries per conversation: an invalid or transiently failed answer is retried with feedback, never looped.
    cqa_openai_max_attempts: int = Field(default=2, ge=1, le=3)
    # Sent when the model accepts it; reasoning models that reject it are retried without it automatically.
    cqa_openai_temperature: float | None = 0.0
    # Adapter that reassesses an appealed criterion (a separate GPT call per appeal; it only recommends, the
    # manager decides). Only adapters that implement `reassess` qualify; the development mock does not.
    cqa_reassessor: str = "openai"
    # Evaluation modes (app/cqa/routing.py), used when a request names no adapter: 1 = hybrid (the local Qwen model
    # answers the official criteria that still match the official definition, GPT answers every other criterion),
    # 2 = GPT only. Appeals are reassessed by GPT in both modes. Applies when ATLAS_CQA_EVALUATOR=openai.
    cqa_default_mode_type: int = Field(default=1, ge=1, le=2)
    # Qwen through Ollama's OpenAI-compatible API on this machine. The setting name keeps GEMMA: the adapter id is
    # still "gemma". In Docker the ollama-forward sidecar makes the host's Ollama reachable at localhost:11434
    # inside the api container. No key is needed or sent. Default tag from the model decision "qwen 3.8 27b".
    cqa_gemma_base_url: str = "http://localhost:11434/v1"
    cqa_gemma_model: str = "qwen3:27b"
    cqa_gemma_timeout_s: float = 300.0
    # The http adapter POSTs the evaluation request here. Non-loopback hosts require the explicit opt-in
    # below, so transcripts are never sent off this machine by accident.
    cqa_evaluator_url: str | None = None
    cqa_evaluator_timeout_s: float = 180.0
    cqa_evaluator_allow_remote: bool = False
    cqa_evaluation_workers: int = 2
    # Hosts (suffix match) the API may contact to resolve a call recording's player page.
    cqa_audio_hosts: list[str] = Field(default=["powerplatform.com", "dynamics.com"])
    cqa_max_messages: int = 3_000
    cqa_max_message_chars: int = 20_000
    # Organizers' results file (JSON 1.0, app/cqa/results_export.py). team_name is required there; the export
    # form can also supply it. model.mode is derived from the evaluators used (openai = external_api); set
    # ATLAS_CQA_MODEL_MODE (local, external_api or hybrid) only for an adapter ATLAS cannot classify.
    cqa_team_name: str = ""
    cqa_model_mode: str = ""

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
