"""HTTP evaluator: POST the evaluation request as JSON to a model service, read the ModelOutput JSON back.

Configure with ``ATLAS_CQA_EVALUATOR_URL`` (for example ``http://127.0.0.1:9000/evaluate``) and select it with
``ATLAS_CQA_EVALUATOR=http``. Only loopback hosts are allowed unless ``ATLAS_CQA_EVALUATOR_ALLOW_REMOTE=true``:
transcripts must not leave this machine by accident.
"""

from __future__ import annotations

import ipaddress
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from app.cqa.adapters.base import EvaluatorAdapter, EvaluatorError, register_adapter
from app.cqa.contract import EvaluationRequest

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
# Inside a Docker Desktop container, the machine running Docker (where the model service runs) is reached by this
# name. It is the same physical machine, so it counts as local for the guard below.
DOCKER_HOST_NAMES = frozenset({"host.docker.internal"})


def is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost" or host.lower() in DOCKER_HOST_NAMES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


@register_adapter("http")
class HttpEvaluator(EvaluatorAdapter):
    label = "Model service (HTTP)"
    version = "1"
    is_mock = False
    description = "Sends the evaluation request to the model service at ATLAS_CQA_EVALUATOR_URL."

    def availability(self) -> tuple[bool, str]:
        url = self.settings.cqa_evaluator_url
        if not url:
            return False, "ATLAS_CQA_EVALUATOR_URL is not set."
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return False, "ATLAS_CQA_EVALUATOR_URL must be an http(s) URL."
        if not is_loopback(parts.hostname) and not self.settings.cqa_evaluator_allow_remote:
            return False, ("the URL is not on this machine; set ATLAS_CQA_EVALUATOR_ALLOW_REMOTE=true to allow "
                           "sending transcripts to it.")
        return True, ""

    def evaluate(self, request: EvaluationRequest) -> dict:
        ready, reason = self.availability()
        if not ready:
            raise EvaluatorError(reason, code="evaluator_not_configured")
        body = request.model_dump_json().encode("utf-8")
        http_request = urllib.request.Request(
            self.settings.cqa_evaluator_url or "", data=body, method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "ATLAS-CQA/1.0"})
        try:
            with urllib.request.urlopen(http_request, timeout=self.settings.cqa_evaluator_timeout_s) as response:  # noqa: S310
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            detail = error.read(400).decode("utf-8", "replace") if error.fp else ""
            raise EvaluatorError(f"The model service answered HTTP {error.code}. {detail}".strip(),
                                 code="evaluator_http_error") from None
        except TimeoutError:
            raise EvaluatorError("The model service did not answer in time.", code="evaluator_timeout") from None
        except (urllib.error.URLError, OSError) as error:
            reason_text = getattr(error, "reason", error)
            raise EvaluatorError(f"Could not reach the model service ({reason_text}).",
                                 code="evaluator_unreachable") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise EvaluatorError("The model service response is larger than 8 MB.", code="evaluator_invalid_json")
        try:
            return json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise EvaluatorError("The model service did not return JSON.", code="evaluator_invalid_json") from None
