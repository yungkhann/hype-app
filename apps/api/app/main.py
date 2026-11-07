"""FastAPI application factory. Run with ``uvicorn app.main:app --host 127.0.0.1 --port 8000``."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.api.routes import analyses, analysis, datasets, experiments, findings, system
from app.challenge import router as challenge
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.security import OriginGuard
from app.services.datasets import DatasetService
from app.services.modeling.runner import ExperimentManager
from app.services.reporting.store import ReportStore
from app.storage.workspace import Workspace

API_PREFIX = "/api/v1"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        workspace = Workspace(settings)
        app.state.settings = settings
        app.state.workspace = workspace
        app.state.datasets = DatasetService(workspace, settings)
        app.state.experiments = ExperimentManager(workspace, app.state.datasets, settings)
        app.state.reports = ReportStore(workspace)
        yield
        app.state.experiments.shutdown()

    app = FastAPI(title=settings.app_name, version=__version__, lifespan=lifespan,
                  description="Local-first data intelligence API. Data never leaves this machine.")
    # Middleware added last runs first: Host check → CORS → Origin check → gzip → routes.
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(OriginGuard, allowed_origins=settings.cors_origins)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Content-Disposition"])
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts, www_redirect=False)
    install_error_handlers(app)
    for module in (system, datasets, analysis, analyses, experiments, findings):
        app.include_router(module.router, prefix=API_PREFIX)
    app.include_router(challenge.router, prefix=API_PREFIX)
    return app


app = create_app()
