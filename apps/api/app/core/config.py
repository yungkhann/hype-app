"""Runtime settings. Every value can be overridden with an ``ATLAS_`` environment variable."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
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
    # Evaluator adapter used when a request does not name one: "mock" (development only), "http", or a
    # name registered with @register_adapter (see app/cqa/adapters).
    cqa_evaluator: str = "mock"
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

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
