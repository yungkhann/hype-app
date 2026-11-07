"""Guards for an unauthenticated API that listens on localhost.

There is no login (non-goal), so the API protects itself from the one realistic attacker: a web page open in the
same browser. Two gaps remain after CORS:

* **DNS rebinding.** A hostile hostname can be re-pointed at 127.0.0.1; the page is then "same-origin" and CORS
  never applies. Browsers still send that hostname in ``Host``, so only local host names are accepted
  (``TrustedHostMiddleware``, configured from ``Settings.allowed_hosts``).
* **Simple cross-site requests.** CORS stops a foreign page from *reading* a response, not from sending a form
  POST that executes. Browsers always attach ``Origin`` to cross-origin POST/PUT/PATCH/DELETE, so a
  state-changing request whose ``Origin`` is neither the web app nor the API itself is refused here.

Requests without ``Origin`` (curl, scripts, tests) are allowed: they cannot come from a web page.
"""

from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class OriginGuard:
    def __init__(self, app: ASGIApp, allowed_origins: list[str]) -> None:
        self.app = app
        self.allowed = {origin.rstrip("/") for origin in allowed_origins}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
            headers = {key.lower(): value for key, value in scope["headers"]}
            origin = headers.get(b"origin")
            if origin is not None:
                value = origin.decode("latin-1").rstrip("/")
                host = headers.get(b"host", b"").decode("latin-1")
                same_origin = value in {f"http://{host}", f"https://{host}"}
                if value not in self.allowed and not same_origin:
                    response = JSONResponse(status_code=403, content={"error": {
                        "code": "forbidden_origin",
                        "message": f"Requests from {value} may not change this workspace. "
                                   "Add the web app's origin to ATLAS_CORS_ORIGINS if this is intended.",
                        "details": None,
                    }})
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)
