"""Evaluator adapters. Every module in this package is imported at start-up so its @register_adapter runs.

Built in: ``mock`` (development only, deterministic, not AI) and ``http`` (POST to a model service).
Add the real model by dropping a module here; see ``base.py`` and docs/cqa-model-contract.md.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil

from app.cqa.adapters.base import REGISTRY, EvaluatorAdapter, EvaluatorError, create_adapters, register_adapter

logger = logging.getLogger("atlas.cqa")

for _module in pkgutil.iter_modules(__path__):
    if _module.name != "base" and not _module.name.startswith("_"):
        try:
            importlib.import_module(f"{__name__}.{_module.name}")
        except Exception:  # a broken adapter must not take the API down
            logger.exception("Could not load CQA evaluator adapter module '%s'", _module.name)

__all__ = ["REGISTRY", "EvaluatorAdapter", "EvaluatorError", "create_adapters", "register_adapter"]
