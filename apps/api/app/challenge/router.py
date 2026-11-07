"""Bespoke challenge endpoints, mounted at ``/api/v1/challenge``.

Add routes here when the case needs an interface beyond the generic analysis runner, e.g. a scoring
endpoint for the jury's evaluation format. Keep computation in a service function, not in the route.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.extensions import REGISTRY
from app.schemas.extensions import AnalysisInfo

router = APIRouter(prefix="/challenge", tags=["challenge"])


class ChallengeInfo(BaseModel):
    status: str
    case_title: str | None
    analyses: list[AnalysisInfo]


# Fill in once the case is revealed; the Challenge page shows it as its heading.
CASE_TITLE: str | None = None


@router.get("/info", response_model=ChallengeInfo)
def info() -> ChallengeInfo:
    analyses = [d.info() for d in REGISTRY.values() if d.category == "challenge"]
    return ChallengeInfo(status="case revealed" if CASE_TITLE else "awaiting case",
                         case_title=CASE_TITLE, analyses=analyses)
