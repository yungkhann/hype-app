"""Evaluator adapters: the seam where the real AI model plugs in.

An adapter turns an :class:`~app.cqa.contract.EvaluationRequest` into a :class:`~app.cqa.contract.ModelOutput`
(or an equivalent dict). It never scores: the backend validates the output and the scoring engine computes every
number. Register an adapter with::

    from app.cqa.adapters.base import EvaluatorAdapter, register_adapter

    @register_adapter("team-model")
    class TeamModel(EvaluatorAdapter):
        label = "Team model"
        version = "0.1"
        is_mock = False

        def evaluate(self, request):
            ...  # call the model, return a ModelOutput or dict

Any module placed in ``app/cqa/adapters/`` is imported at start-up, so dropping the file in is enough. Select
it with ``ATLAS_CQA_EVALUATOR=team-model`` (or per request in the UI).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.core.config import Settings
from app.cqa.contract import CONTRACT_VERSION, EvaluationRequest, ModelOutput
from app.cqa.schemas import EvaluatorInfo


class EvaluatorError(Exception):
    """The evaluator could not produce an answer (unreachable, timed out, crashed)."""

    def __init__(self, message: str, code: str = "evaluator_error", issues: list[str] | None = None,
                 raw: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.issues = issues or []  # e.g. why the model's last answer was rejected
        self.raw = raw  # the model's last answer, kept on the failed evaluation for audit


class EvaluatorAdapter:
    name: str = ""
    label: str = ""
    version: str = ""
    is_mock: bool = False
    description: str = ""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def availability(self) -> tuple[bool, str]:
        """(ready, reason). The UI shows the reason when an adapter cannot run."""
        return True, ""

    def evaluate(self, request: EvaluationRequest) -> ModelOutput | dict[str, Any]:
        raise NotImplementedError

    def info(self) -> EvaluatorInfo:
        ready, reason = self.availability()
        description = self.description if ready else f"{self.description} Not available: {reason}".strip()
        return EvaluatorInfo(name=self.name, label=self.label or self.name, version=self.version,
                             is_mock=self.is_mock, description=description, available=ready,
                             contract_version=CONTRACT_VERSION)


REGISTRY: dict[str, type[EvaluatorAdapter]] = {}


def register_adapter(name: str) -> Callable[[type[EvaluatorAdapter]], type[EvaluatorAdapter]]:
    def decorate(cls: type[EvaluatorAdapter]) -> type[EvaluatorAdapter]:
        if not name or len(name) > 64:
            raise ValueError("Adapter names must be 1–64 characters.")
        cls.name = name
        REGISTRY[name] = cls
        return cls
    return decorate


def create_adapters(settings: Settings) -> dict[str, EvaluatorAdapter]:
    return {name: cls(settings) for name, cls in REGISTRY.items()}
