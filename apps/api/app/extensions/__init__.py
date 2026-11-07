"""Analysis extensions. Importing this package registers every built-in analysis."""

from app.extensions import builtin  # noqa: F401  (registration side effect)
from app.extensions.registry import REGISTRY, AnalysisContext, column_param, register_analysis

__all__ = ["REGISTRY", "AnalysisContext", "column_param", "register_analysis"]
