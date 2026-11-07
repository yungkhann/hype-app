#!/usr/bin/env python3
"""End-to-end smoke test for a running CQA stack, through the public entry point (the web container).

Standard library only, so it runs on any CI runner or laptop. All data is synthetic (the API's FIXTURE group), so
never point it at the production deployment: it writes test conversations, a checklist, evaluations and an appeal.

    python3 deployment/smoke_test.py --base-url http://127.0.0.1:3000 --phase seed   --state /tmp/cqa-smoke.json
    docker compose restart api        # or recreate the containers with new images
    python3 deployment/smoke_test.py --base-url http://127.0.0.1:3000 --phase verify --state /tmp/cqa-smoke.json

seed:   static frontend and fonts, /healthz, the /api/v1 proxy and its allowlist, fixture import, conversation list
        and detail, checklist create + edit (new version), mock evaluation, appeal, reviewer decision, audit trail;
        with --offline-model also an evaluation against an unreachable model service, which must fail cleanly.
verify: everything created by `seed` is still there (persistence across restarts and image updates).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

API = "/api/v1/cqa"


class Client:
    def __init__(self, base: str, host: str | None) -> None:
        self.base = base.rstrip("/")
        self.host = host

    def call(self, method: str, path: str, body: Any = None,
             expect: int | tuple[int, ...] = 200) -> tuple[int, dict[str, str], bytes]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        origin = f"https://{self.host}" if self.host else self.base
        if method not in ("GET", "HEAD"):
            request.add_header("Origin", origin)  # what a browser sends for same-origin writes
        if self.host:
            request.add_header("Host", self.host)
            request.add_header("X-Forwarded-Proto", "https")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, head, raw = response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            status, head, raw = error.code, dict(error.headers), error.read()
        allowed = expect if isinstance(expect, tuple) else (expect,)
        if status not in allowed:
            raise AssertionError(f"{method} {path}: expected {allowed}, got {status}: {raw[:300]!r}")
        return status, head, raw

    def json(self, method: str, path: str, body: Any = None, expect: int | tuple[int, ...] = 200) -> Any:
        return json.loads(self.call(method, path, body, expect)[2] or b"null")


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"  ok  {message}")


def wait_batch(client: Client, batch_id: str, timeout: float = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.json("GET", f"{API}/evaluations/batches/{batch_id}")
        if status["done"]:
            return status
        time.sleep(0.5)
    raise AssertionError(f"evaluation batch {batch_id} did not finish in {timeout}s")


def seed(client: Client, args: argparse.Namespace) -> dict:
    _, head, page = client.call("GET", "/")
    check(head.get("Content-Type", "").startswith("text/html") and b"<title>" in page, "frontend index.html served")
    _, head, _ = client.call("GET", "/js/app.js")
    check("javascript" in head.get("Content-Type", ""), "frontend ES modules served as JavaScript")
    if b"fonts/satoshi-400.woff2" in client.call("GET", "/css/app.css")[2]:
        _, head, _ = client.call("GET", "/fonts/satoshi-400.woff2")
        check(head.get("Content-Type") == "font/woff2", "self-hosted fonts served")
    check(client.call("GET", "/.env", expect=404)[0] == 404, "dotfiles are not served")

    web = client.json("GET", "/healthz")
    check(web["status"] == "ok", f"web /healthz ok (release {web['release']})")
    if args.expect_release:
        check(web["release"] == args.expect_release, f"web runs release {args.expect_release}")
    check(client.json("GET", "/api/v1/health")["status"] == "ok", "API health through the web proxy")
    blocked = client.call("GET", "/api/v1/datasets", expect=(200, 404))[0]
    check(blocked == (200 if args.full_api else 404),
          "proxy allowlist " + ("forwards the whole API" if args.full_api else "keeps data-studio endpoints private"))
    check(isinstance(client.json("GET", f"{API}/info"), dict), "CQA info endpoint answers")

    run = client.json("POST", f"{API}/imports", {"group_id": "FIXTURE", "source": "fixture"}, expect=201)
    check(run["status"] == "completed", "fixture import completed")
    conversations = client.json("GET", f"{API}/conversations?page_size=50")
    check(conversations["total"] >= 1, f"conversation list has {conversations['total']} conversations")
    conversation_id = conversations["items"][0]["id"]
    conversation = client.json("GET", f"{API}/conversations/{conversation_id}")
    check(len(conversation["messages"]) > 0, f"conversation {conversation_id} detail has messages")

    checklist = client.json("POST", f"{API}/checklists/dev-sample", expect=201)
    latest = checklist["versions"][-1]
    config = json.loads(json.dumps(latest["config"]))
    config["criteria"][0]["weight"] = config["criteria"][0]["weight"] + 1
    edited = client.json("PUT", f"{API}/checklists/{checklist['id']}", {
        "base_version": latest["version"], "config": config, "description": "edited by the smoke test",
        "note": "smoke test edit"})
    check(edited["description"] == "edited by the smoke test" and len(edited["versions"]) == len(checklist["versions"])
          + 1, "checklist edit saved as a new version")

    queued = client.json("POST", f"{API}/evaluations",
                         {"checklist_id": checklist["id"], "conversation_ids": [conversation_id], "adapter": "mock"},
                         expect=202)
    wait_batch(client, queued["batch_id"])
    evaluation_id = queued["evaluations"][0]["id"]
    evaluation = client.json("GET", f"{API}/evaluations/{evaluation_id}")
    check(evaluation["evaluation"]["status"] == "completed", "mock evaluation completed and was scored")

    scored = next(v for v in evaluation["criteria"] if v["final_score"]["status"] == "scored")
    appeal = client.json("POST", f"{API}/appeals", {"evaluation_id": evaluation_id,
                                                    "criterion_id": scored["criterion"]["id"],
                                                    "comment": "Smoke test appeal.", "submitted_by": "Smoke"},
                         expect=201)
    check(appeal["status"] == "pending", "appeal submitted")
    decided = client.json("POST", f"{API}/appeals/{appeal['id']}/decision",
                          {"decision": "confirm", "explanation": "Smoke test confirms.", "reviewer": "Smoke QA"})
    check(decided["status"] == "confirmed", "reviewer decision recorded")
    check(len(client.json("GET", f"{API}/audit")) > 0, "audit trail has entries")

    state = {"conversation_id": conversation_id, "checklist_id": checklist["id"], "evaluation_id": evaluation_id,
             "appeal_id": appeal["id"]}

    if args.offline_model:
        queued = client.json("POST", f"{API}/evaluations",
                             {"checklist_id": checklist["id"], "conversation_ids": [conversation_id],
                              "adapter": "http"}, expect=202)
        wait_batch(client, queued["batch_id"])
        failed = client.json("GET", f"{API}/evaluations/{queued['evaluations'][0]['id']}")["evaluation"]
        check(failed["status"] == "failed" and failed["error"]["code"] == "evaluator_unreachable",
              f"model offline: evaluation failed cleanly ({failed['error']['code']})")
        check(client.json("GET", "/api/v1/health")["status"] == "ok", "API still healthy with the model offline")
        check(client.json("GET", f"{API}/evaluations/{evaluation_id}")["evaluation"]["status"] == "completed",
              "earlier results still viewable with the model offline")
    return state


def verify(client: Client, state: dict) -> None:
    check(client.json("GET", "/api/v1/health")["status"] == "ok", "API healthy after restart")
    conversation = client.json("GET", f"{API}/conversations/{state['conversation_id']}")
    check(len(conversation["messages"]) > 0, "imported conversation persisted")
    checklist = client.json("GET", f"{API}/checklists/{state['checklist_id']}")
    check(checklist["description"] == "edited by the smoke test", "edited checklist persisted")
    evaluation = client.json("GET", f"{API}/evaluations/{state['evaluation_id']}")
    check(evaluation["evaluation"]["status"] == "completed", "evaluation persisted")
    appeal = client.json("GET", f"{API}/appeals/{state['appeal_id']}")
    check(appeal["appeal"]["status"] == "confirmed", "appeal and reviewer decision persisted")
    check(len(client.json("GET", f"{API}/audit")) > 0, "audit trail persisted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--phase", choices=("seed", "verify", "all"), default="all")
    parser.add_argument("--state", default="cqa-smoke-state.json", help="where seed stores ids for verify")
    parser.add_argument("--host", help="send this Host header, as Cloudflare does (e.g. lumvy.io)")
    parser.add_argument("--expect-release", help="fail unless /healthz reports this release")
    parser.add_argument("--offline-model", action="store_true",
                        help="also check that an unreachable model service fails cleanly (needs "
                             "ATLAS_CQA_EVALUATOR_URL pointing at a port with nothing listening)")
    parser.add_argument("--full-api", action="store_true", help="the proxy forwards the whole API")
    args = parser.parse_args()
    client = Client(args.base_url, args.host)
    try:
        if args.phase in ("seed", "all"):
            print(f"seed against {args.base_url}" + (f" (Host: {args.host})" if args.host else ""))
            state = seed(client, args)
            with open(args.state, "w", encoding="utf-8") as handle:
                json.dump(state, handle)
        if args.phase in ("verify", "all"):
            print(f"verify against {args.base_url}")
            with open(args.state, encoding="utf-8") as handle:
                verify(client, json.load(handle))
    except AssertionError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    print("smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
