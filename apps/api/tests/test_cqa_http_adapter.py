"""HTTP evaluator adapter: the URL guard, a real round trip to a local model service, and graceful failures when
the service is down or misbehaves (the deployment keeps working with the model offline)."""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.core.config import Settings
from app.cqa.adapters.base import EvaluatorError
from app.cqa.adapters.http import HttpEvaluator, is_loopback
from app.cqa.contract import EvaluationRequest

CONTRACT_DIR = Path(__file__).resolve().parents[3] / "docs" / "cqa-contract"


def make(tmp_path: Path, **overrides) -> HttpEvaluator:
    return HttpEvaluator(Settings(data_dir=tmp_path, **overrides))


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal",
                                  "HOST.DOCKER.INTERNAL"])
def test_local_hosts_count_as_this_machine(host):
    assert is_loopback(host)


@pytest.mark.parametrize("host", [None, "", "10.0.0.5", "example.com", "host.docker.internal.example.com"])
def test_other_hosts_are_not_local(host):
    assert not is_loopback(host)


def test_docker_host_url_is_available_without_the_remote_opt_in(tmp_path):
    adapter = make(tmp_path, cqa_evaluator_url="http://host.docker.internal:9000/evaluate")
    assert adapter.availability() == (True, "")


def test_remote_url_needs_the_explicit_opt_in(tmp_path):
    url = "http://10.0.0.5:9000/evaluate"
    ready, reason = make(tmp_path, cqa_evaluator_url=url).availability()
    assert not ready and "ALLOW_REMOTE" in reason
    assert make(tmp_path, cqa_evaluator_url=url, cqa_evaluator_allow_remote=True).availability() == (True, "")


def test_missing_url_is_reported_not_raised(tmp_path):
    ready, reason = make(tmp_path).availability()
    assert not ready and "ATLAS_CQA_EVALUATOR_URL" in reason


# ---- a real HTTP model service on 127.0.0.1 -------------------------------------------------------------------


def example_request() -> EvaluationRequest:
    return EvaluationRequest.model_validate(json.loads((CONTRACT_DIR / "example-request.json").read_text("utf-8")))


class ModelService(BaseHTTPRequestHandler):
    mode = "ok"
    received: list[dict] = []

    def do_POST(self):  # noqa: N802 (http.server API)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ModelService.received.append(body)
        if ModelService.mode == "error":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"model crashed")
            return
        payload = (CONTRACT_DIR / "example-response.json").read_bytes() if ModelService.mode == "ok" else b"<html>"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # keep test output quiet
        pass


@pytest.fixture
def service() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelService)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ModelService.mode, ModelService.received = "ok", []
    yield f"http://127.0.0.1:{server.server_address[1]}/evaluate"
    server.shutdown()
    server.server_close()


def test_round_trip_posts_the_request_and_returns_the_model_output(tmp_path, service):
    request = example_request()
    output = make(tmp_path, cqa_evaluator_url=service).evaluate(request)
    assert ModelService.received[0]["evaluation_id"] == request.evaluation_id
    assert output["evaluation_id"] == request.evaluation_id and output["results"]


@pytest.mark.parametrize(("mode", "code"), [("error", "evaluator_http_error"), ("html", "evaluator_invalid_json")])
def test_bad_answers_become_readable_errors(tmp_path, service, mode, code):
    ModelService.mode = mode
    with pytest.raises(EvaluatorError) as caught:
        make(tmp_path, cqa_evaluator_url=service).evaluate(example_request())
    assert caught.value.code == code


def test_model_offline_fails_gracefully(tmp_path):
    with socket.socket() as probe:  # a port with nothing listening on it
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    adapter = make(tmp_path, cqa_evaluator_url=f"http://127.0.0.1:{port}/evaluate", cqa_evaluator_timeout_s=2)
    with pytest.raises(EvaluatorError) as caught:
        adapter.evaluate(example_request())
    assert caught.value.code == "evaluator_unreachable"
