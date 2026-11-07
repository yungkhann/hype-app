"""Gemma evaluator: the local Gemma model through Ollama's OpenAI-compatible API (``/v1/chat/completions``).

It is the GPT adapter pointed at another endpoint, so the prompt, the strict JSON schema built from the checklist
version, the validation of every value and evidence turn, and the single retry with feedback are exactly the same.
Nothing leaves the machine: the base URL must be loopback (Docker: the ollama-forward sidecar maps the host's
Ollama to localhost:11434) or https. No API key is sent.

In evaluation mode 1 (app/cqa/routing.py) Gemma answers only the official criteria whose definition still matches
the official baseline. It never reassesses appeals: every appeal goes to GPT.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from app.cqa.adapters.base import EvaluatorError, register_adapter
from app.cqa.adapters.http import is_loopback
from app.cqa.adapters.openai_gpt import OpenAIEvaluator


@register_adapter("gemma")
class GemmaEvaluator(OpenAIEvaluator):
    label = "Gemma (local)"
    description = "Evaluates with the local Gemma model through Ollama (ATLAS_CQA_GEMMA_MODEL)."
    provider = "gemma"
    service = "local Gemma model (Ollama)"
    family = "Gemma"
    supports_reassessment = False  # appeals are always reassessed by GPT

    @property
    def base_url(self) -> str:
        return self.settings.cqa_gemma_base_url

    @property
    def model(self) -> str:
        return self.settings.cqa_gemma_model

    @property
    def timeout_s(self) -> float:
        return self.settings.cqa_gemma_timeout_s

    @property
    def temperature(self) -> float | None:
        return 0.0

    def _key(self) -> str:
        return ""  # Ollama needs no key; none is sent

    def availability(self) -> tuple[bool, str]:
        if not self.model.strip():
            return False, "ATLAS_CQA_GEMMA_MODEL is empty."
        parts = urlsplit(self.base_url)
        if not parts.hostname or (parts.scheme != "https" and not is_loopback(parts.hostname)):
            return False, "ATLAS_CQA_GEMMA_BASE_URL must be a loopback (local) or https URL."
        return True, ""

    def reassess(self, request: Any) -> dict[str, Any]:
        raise EvaluatorError("Gemma does not reassess appeals; GPT does.", code="reassessor_unavailable")
