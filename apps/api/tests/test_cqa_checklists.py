"""Checklist configuration: create, edit, reorder, versions, duplicate, replace a criterion, import/export."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from tests.cqa_helpers import API, dev_checklist, evaluate, import_fixtures

BASE = {
    "name": "Team checklist",
    "config": {
        "sections": [{"id": "s1", "name": "Section one"}],
        "criteria": [
            {"id": "greet", "name": "Greets", "weight": 20, "answer_type": "binary", "section_id": "s1",
             "na_allowed": True, "na_rule": "No operator."},
            {"id": "skill", "name": "Skill", "weight": 50, "answer_type": "scale",
             "scale": {"min": 1, "max": 5, "step": 1}},
            {"id": "result", "name": "Result", "weight": 30, "answer_type": "options",
             "options": [{"id": "yes", "label": "Solved", "points": 1}, {"id": "no", "label": "Not solved",
                                                                         "points": 0}]},
        ],
        "scoring": {"rounding": {"mode": "half_up", "digits": 0}},
    },
}


def create(client, payload=None):
    response = client.post(f"{API}/checklists", json=payload or BASE)
    assert response.status_code == 201, response.text
    return response.json()


def save(client, checklist, config, note="edit", **extra):
    return client.put(f"{API}/checklists/{checklist['id']}",
                      json={"base_version": checklist["latest_version"], "config": config, "note": note, **extra})


def test_create_returns_version_one_with_the_full_configuration(client):
    checklist = create(client)
    assert checklist["latest_version"] == 1 and checklist["origin"] == "custom"
    version = checklist["versions"][0]
    assert [c["id"] for c in version["config"]["criteria"]] == ["greet", "skill", "result"]
    assert version["config"]["criteria"][1]["scale"] == {"min": 1.0, "max": 5.0, "step": 1.0, "labels": {}}
    summaries = client.get(f"{API}/checklists").json()
    assert summaries[0]["criteria"] == 3 and summaries[0]["total_weight"] == 100


def test_edit_add_remove_and_reorder_create_new_versions_and_keep_old_ones(client):
    checklist = create(client)
    config = checklist["versions"][0]["config"]
    config["criteria"][0]["name"] = "Greets warmly"
    config["criteria"][0]["description"] = "Opens with a greeting."
    config["criteria"][1]["weight"] = 40
    config["criteria"].append({"id": "bye", "name": "Farewell", "weight": 40, "answer_type": "binary"})
    config["criteria"].reverse()
    config["criteria"] = [c for c in config["criteria"] if c["id"] != "result"]
    updated = save(client, checklist, config, note="Reworded, reweighted, reordered").json()
    assert updated["latest_version"] == 2
    latest = updated["versions"][-1]
    assert [c["id"] for c in latest["config"]["criteria"]] == ["bye", "skill", "greet"]
    assert latest["note"] == "Reworded, reweighted, reordered"
    first = client.get(f"{API}/checklists/{checklist['id']}").json()["versions"][0]
    assert [c["id"] for c in first["config"]["criteria"]] == ["greet", "skill", "result"]  # v1 untouched
    assert first["config"]["criteria"][0]["name"] == "Greets"


def test_answer_type_scale_and_na_settings_are_editable(client):
    checklist = create(client)
    config = checklist["versions"][0]["config"]
    config["criteria"][0].update({"answer_type": "scale", "scale": {"min": 0, "max": 10, "step": 2},
                                  "na_allowed": False})
    updated = save(client, checklist, config).json()
    greet = updated["versions"][-1]["config"]["criteria"][0]
    assert greet["answer_type"] == "scale" and greet["scale"]["max"] == 10 and greet["na_allowed"] is False


def test_saving_an_unchanged_config_does_not_create_a_version(client):
    checklist = create(client)
    same = save(client, checklist, checklist["versions"][0]["config"]).json()
    assert same["latest_version"] == 1
    renamed = client.put(f"{API}/checklists/{checklist['id']}", json={"base_version": 1, "name": "Renamed"}).json()
    assert renamed["name"] == "Renamed" and renamed["latest_version"] == 1


def test_stale_edits_are_refused(client):
    checklist = create(client)
    config = checklist["versions"][0]["config"]
    config["criteria"][0]["name"] = "Greets the client"
    assert save(client, checklist, config).status_code == 200
    config["criteria"][0]["name"] = "Greets politely"
    stale = save(client, checklist, config)  # still based on v1
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_checklist"


def test_invalid_configurations_are_rejected(client):
    # Weights total 100 so each case fails for its own reason, not the weight rule.
    bad_cases = [
        {"criteria": [{"id": "a", "name": "A", "weight": 50}, {"id": "a", "name": "B", "weight": 50}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 100, "section_id": "missing"}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 0}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 100, "answer_type": "options", "options": [
            {"id": "x", "label": "X", "points": 1}]}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 100, "answer_type": "scale",
                       "scale": {"min": 5, "max": 1, "step": 1}}]},
        {"criteria": []},
        {"criteria": [{"id": "Bad Id", "name": "A", "weight": 100}]},
    ]
    for config in bad_cases:
        response = client.post(f"{API}/checklists", json={"name": "x", "config": config})
        assert response.status_code == 422, config


def test_duplicate_copies_a_version_into_an_independent_checklist(client):
    checklist = create(client)
    copy = client.post(f"{API}/checklists/{checklist['id']}/duplicate", json={"name": "Copy"}).json()
    assert copy["id"] != checklist["id"] and copy["name"] == "Copy" and copy["latest_version"] == 1
    assert copy["duplicated_from"] == checklist["id"]
    assert copy["versions"][0]["config"] == checklist["versions"][0]["config"]
    config = copy["versions"][0]["config"]
    config["criteria"][0]["name"] = "Changed in the copy"
    assert save(client, copy, config).json()["latest_version"] == 2
    assert client.get(f"{API}/checklists/{checklist['id']}").json()["latest_version"] == 1


def test_replace_criterion_keeps_position_and_records_the_replacement(client):
    checklist = create(client)
    new = {"id": "empathy", "name": "Shows empathy", "weight": 50, "answer_type": "binary", "na_allowed": False}
    response = client.post(f"{API}/checklists/{checklist['id']}/criteria/skill/replace",
                           json={"base_version": 1, "criterion": new})
    assert response.status_code == 200, response.text
    replaced = response.json()
    latest = replaced["versions"][-1]
    assert replaced["latest_version"] == 2
    assert [c["id"] for c in latest["config"]["criteria"]] == ["greet", "empathy", "result"]
    assert latest["replacements"] == [{"old_id": "skill", "new_id": "empathy", "old_name": "Skill",
                                       "new_name": "Shows empathy"}]
    assert "Replaced 'Skill' with 'Shows empathy'" in latest["note"]
    audit = client.get(f"{API}/audit", params={"checklist_id": checklist["id"]}).json()
    assert audit[0]["type"] == "checklist.criterion_replaced"


def test_replace_criterion_validation(client):
    checklist = create(client)
    url = f"{API}/checklists/{checklist['id']}/criteria"
    same_id = {"id": "skill", "name": "x", "weight": 1}
    assert client.post(f"{url}/skill/replace", json={"base_version": 1, "criterion": same_id}).status_code == 422
    taken = {"id": "greet", "name": "x", "weight": 1}
    assert client.post(f"{url}/skill/replace", json={"base_version": 1, "criterion": taken}).status_code == 422
    fine = {"id": "fresh", "name": "x", "weight": 1}
    assert client.post(f"{url}/nope/replace", json={"base_version": 1, "criterion": fine}).status_code == 404
    assert client.post(f"{url}/skill/replace", json={"base_version": 7, "criterion": fine}).status_code == 409


def test_export_and_import_round_trip(client):
    checklist = create(client)
    exported = client.get(f"{API}/checklists/{checklist['id']}/export")
    assert "attachment" in exported.headers["content-disposition"]
    body = exported.json()
    assert body["format"] == "atlas-cqa-checklist/1" and body["version"] == 1
    imported = client.post(f"{API}/checklists/import", json={k: body[k] for k in ("name", "description", "origin",
                                                                                   "config")}).json()
    assert imported["versions"][0]["config_hash"] == checklist["versions"][0]["config_hash"]


def test_dev_sample_is_labeled_unofficial(client):
    sample = dev_checklist(client)
    assert sample["origin"] == "dev_sample" and "unofficial" in sample["name"].lower()
    criteria = sample["versions"][0]["config"]["criteria"]
    assert {c["answer_type"] for c in criteria} == {"binary", "scale", "options"}
    assert any(c["na_allowed"] for c in criteria) and any(c["severe_error_enabled"] for c in criteria)


def test_used_checklists_can_be_archived_but_not_deleted(client):
    import_fixtures(client)
    checklist = create(client)
    unused = create(client, {**BASE, "name": "Unused"})
    evaluate(client, checklist["id"], ["fx-ru-001"])
    assert client.delete(f"{API}/checklists/{checklist['id']}").status_code == 409
    assert client.delete(f"{API}/checklists/{unused['id']}").status_code == 200
    archived = client.put(f"{API}/checklists/{checklist['id']}", json={"base_version": 1, "archived": True}).json()
    assert archived["archived"]
    assert client.get(f"{API}/checklists").json() == []
    assert len(client.get(f"{API}/checklists", params={"include_archived": True}).json()) == 1


# ---- Part 2: dynamic checklists ---------------------------------------------------------------------

OFFICIAL = "freedom-broker-official"
OFFICIAL_TABLE = {  # the guide appendix, page 3: id -> (name, weight, answer type, allowed scores, N/A)
    "contact": ("Установление контакта", 10, "binary", None, False),
    "discovery": ("Выявление потребности", 15, "binary", None, True),
    "identification": ("Идентификация", 20, "binary", None, True),
    "consultation": ("Корректность и полнота", 20, "numeric", [0, 5, 10, 15, 20], True),
    "empathy": ("Эмпатия", 15, "binary", None, False),
    "dialogue": ("Ведение, скорость, грамотность", 15, "numeric", [0, 4, 7, 10], False),
    "closure": ("Завершение", 5, "binary", None, True),
    "critical": ("Грубые ошибки", 0, "binary", None, False),
}


def weighted(cid, weight, **extra):
    return {"id": cid, "name": cid.title(), "weight": weight, "answer_type": "binary", **extra}


def restarted(settings):
    """A second app over the same data directory: what a server restart reads back from disk."""
    return TestClient(create_app(settings))


def test_custom_checklists_have_no_fixed_number_of_criteria(client):
    one = create(client, {"name": "One", "config": {"criteria": [weighted("only", 100)]}})
    assert len(one["versions"][0]["config"]["criteria"]) == 1
    many = create(client, {"name": "Twelve", "config": {"criteria": [
        weighted(f"c{i}", 8 if i < 8 else 9) for i in range(12)]}})
    assert len(many["versions"][0]["config"]["criteria"]) == 12


def test_criteria_can_be_added_edited_disabled_and_removed(client, settings):
    checklist = create(client)
    config = checklist["versions"][0]["config"]
    config["criteria"][0].update(name="Greets by name", description="Uses the client's name.", weight=10)
    config["criteria"].append(weighted("empathy", 10))                          # add
    v2 = save(client, checklist, config, note="add empathy").json()
    config = v2["versions"][-1]["config"]
    config["criteria"] = [c for c in config["criteria"] if c["id"] != "result"]  # remove (weight 30)
    config["criteria"][1]["weight"] = 80                                          # skill 50 -> 80
    v3 = save(client, v2, config, note="remove result").json()
    config = v3["versions"][-1]["config"]
    config["criteria"][2]["enabled"] = False                                      # disable empathy (10)
    config["criteria"][1]["weight"] = 90
    v4 = save(client, v3, config, note="disable empathy").json()
    assert v4["latest_version"] == 4
    with restarted(settings) as again:
        stored = again.get(f"{API}/checklists/{checklist['id']}").json()
    ids = [[c["id"] for c in v["config"]["criteria"]] for v in stored["versions"]]
    assert ids == [["greet", "skill", "result"], ["greet", "skill", "result", "empathy"],
                   ["greet", "skill", "empathy"], ["greet", "skill", "empathy"]]
    latest = stored["versions"][-1]["config"]["criteria"]
    assert latest[0]["name"] == "Greets by name" and latest[0]["description"] == "Uses the client's name."
    assert [c["enabled"] for c in latest] == [True, True, False]
    detail = client.get(f"{API}/checklists/{checklist['id']}/versions/4").json()
    assert detail["active_criteria"] == ["greet", "skill"]


def test_custom_numeric_scales_persist_and_are_validated(client, settings):
    payload = {"name": "Numeric", "config": {"criteria": [
        {"id": "dialogue", "name": "Dialogue", "weight": 60, "answer_type": "numeric",
         "allowed_scores": [10, 0, 7, 4]},
        {"id": "depth", "name": "Depth", "weight": 40, "answer_type": "numeric", "allowed_scores": [0, 2.5, 5],
         "na_allowed": True}]}}
    checklist = create(client, payload)
    with restarted(settings) as again:
        criteria = again.get(f"{API}/checklists/{checklist['id']}").json()["versions"][0]["config"]["criteria"]
    assert criteria[0]["allowed_scores"] == [0, 4, 7, 10]  # stored ascending
    assert criteria[1]["allowed_scores"] == [0, 2.5, 5] and criteria[1]["na_allowed"] is True

    def numeric(scores):
        return {"name": "bad", "config": {"criteria": [{"id": "n", "name": "N", "weight": 100,
                                                        "answer_type": "numeric", "allowed_scores": scores}]}}
    for scores in ([0, 5, 5], [0, 5, 5.0], [0, -1, 5], [7], [], None, [0, 0], [True, 5], ["5", 10], [0, 20000]):
        response = client.post(f"{API}/checklists", json=numeric(scores))
        assert response.status_code == 422, scores
    duplicated = client.post(f"{API}/checklists", json=numeric([0, 5, 5.0])).json()
    assert "duplicated allowed score(s): 5." in duplicated["error"]["details"][0]["msg"]


def test_weights_must_total_100_for_enabled_weighted_criteria(client):
    short = client.post(f"{API}/checklists", json={"name": "x", "config": {"criteria": [
        weighted("a", 60), weighted("b", 30)]}})
    assert short.status_code == 422
    error = short.json()["error"]
    assert error["code"] == "invalid_weights" and error["details"]["total_weight"] == 90
    assert "90%" in error["message"]

    thirds = create(client, {"name": "Thirds", "config": {"criteria": [
        weighted("a", 33.3), weighted("b", 33.3), weighted("c", 33.4)]}})  # exact decimals, no float noise
    assert thirds["latest_version"] == 1

    ok = create(client, {"name": "With extras", "config": {"criteria": [
        weighted("a", 70), weighted("b", 30),
        weighted("off", 25, enabled=False),                                     # disabled: not counted
        weighted("critical", 0, severe_error_enabled=True)]}})                  # indicator: not counted
    summary = next(s for s in client.get(f"{API}/checklists").json() if s["id"] == ok["id"])
    assert summary["total_weight"] == 100 and summary["weights_valid"] and summary["enabled_criteria"] == 3

    config = ok["versions"][0]["config"]
    config["criteria"][2]["enabled"] = True                                     # now 125%
    refused = save(client, ok, config)
    assert refused.status_code == 422 and refused.json()["error"]["details"]["total_weight"] == 125
    assert client.get(f"{API}/checklists/{ok['id']}").json()["latest_version"] == 1  # nothing saved

    for criterion in (weighted("z", 0), {**weighted("z", 0, severe_error_enabled=True), "answer_type": "numeric",
                                         "allowed_scores": [0, 1]}):
        bad = client.post(f"{API}/checklists", json={"name": "x", "config": {"criteria": [weighted("a", 100),
                                                                                        criterion]}})
        assert bad.status_code == 422, criterion  # weight 0 only for a yes/no critical-error indicator

    replace = client.post(f"{API}/checklists/{ok['id']}/criteria/b/replace",
                          json={"base_version": 1, "criterion": weighted("b2", 20)})
    assert replace.status_code == 422 and "had weight 30" in replace.json()["error"]["message"]


def test_validate_reports_problems_without_saving(client):
    url = f"{API}/checklists/validate"
    good = client.post(url, json={"criteria": [weighted("a", 100), weighted("crit", 0, severe_error_enabled=True)]})
    assert good.status_code == 200 and good.json()["valid"] and good.json()["indicators"] == ["crit"]
    short = client.post(url, json={"criteria": [weighted("a", 40)]}).json()
    assert not short["valid"] and short["total_weight"] == 40 and short["issues"][0]["code"] == "invalid_weights"
    broken = client.post(url, json={"criteria": [weighted("a", 100), {"id": "n", "name": "N", "weight": 0,
                                                                       "answer_type": "numeric",
                                                                       "allowed_scores": [3, 3]}]}).json()
    assert not broken["valid"] and broken["total_weight"] is None
    assert broken["issues"][0]["criterion_id"] == "n"
    assert client.get(f"{API}/checklists").json() == []


def test_new_versions_preserve_old_versions_and_their_evaluations(client):
    import_fixtures(client)
    v1_config = {"criteria": [weighted("contact", 30), weighted("discovery", 30),
                              {"id": "consultation", "name": "Consultation", "weight": 40, "answer_type": "numeric",
                               "allowed_scores": [0, 5, 10]}]}
    checklist = create(client, {"name": "Versioned", "config": v1_config})
    evaluate(client, checklist["id"], ["fx-ru-001"])
    first = client.get(f"{API}/evaluations", params={"checklist_id": checklist["id"]}).json()["items"][0]
    before = client.get(f"{API}/evaluations/{first['id']}").json()["evaluation"]

    v2_config = {"criteria": [weighted("contact", 25), weighted("discovery", 25),
                              {"id": "consultation", "name": "Updated consultation", "weight": 35,
                               "answer_type": "numeric", "allowed_scores": [0, 4, 7, 10]},
                              weighted("empathy", 15)]}
    v2 = save(client, checklist, v2_config, note="v2").json()
    assert v2["latest_version"] == 2

    versions = client.get(f"{API}/checklists/{checklist['id']}/versions").json()
    assert [(v["version"], v["is_latest"], v["evaluations"]) for v in versions] == [(2, True, 0), (1, False, 1)]
    old = client.get(f"{API}/checklists/{checklist['id']}/versions/1").json()
    assert [c["id"] for c in old["config"]["criteria"]] == ["contact", "discovery", "consultation"]
    assert old["config"]["criteria"][2]["allowed_scores"] == [0, 5, 10] and not old["is_latest"]
    assert client.get(f"{API}/checklists/{checklist['id']}/versions/3").status_code == 404

    after = client.get(f"{API}/evaluations/{first['id']}").json()["evaluation"]
    assert after["checklist_version"] == 1 and after["checklist"] == before["checklist"]
    assert after["final_score"] == before["final_score"]

    evaluate(client, checklist["id"], ["fx-ru-001"], checklist_version=1)       # select an old version
    evaluate(client, checklist["id"], ["fx-ru-001"])                            # default: latest
    used = sorted(e["checklist_version"] for e in client.get(
        f"{API}/evaluations", params={"checklist_id": checklist["id"]}).json()["items"])
    assert used == [1, 1, 2]


def test_official_template_is_a_reusable_reference(client, settings):
    templates = client.get(f"{API}/checklist-templates").json()
    assert [t["id"] for t in templates] == [OFFICIAL]
    assert templates[0]["origin"] == "official" and templates[0]["total_weight"] == 100
    template = client.get(f"{API}/checklist-templates/{OFFICIAL}").json()
    criteria = {c["id"]: c for c in template["config"]["criteria"]}
    assert list(criteria) == list(OFFICIAL_TABLE)
    for cid, (name, weight, answer_type, scores, na) in OFFICIAL_TABLE.items():
        c = criteria[cid]
        assert (c["name"], c["weight"], c["answer_type"], c["allowed_scores"], c["na_allowed"]) == \
            (name, weight, answer_type, scores, na), cid
        assert c["description"] == "" and c["na_rule"] == ""  # wording is not invented
    assert criteria["critical"]["severe_error_enabled"]
    assert [cid for cid, c in criteria.items() if c["severe_error_enabled"]] == ["critical"]
    assert template["config"]["scoring"] == {"max_score": 100, "rounding": {"mode": "half_up", "digits": 2},
                                             "severe_error_policy": "flag_only", "na_policy": "redistribute"}
    assert client.get(f"{API}/checklist-templates/nope").status_code == 404

    assert client.get(f"{API}/checklists").json() == []  # nothing is seeded
    made = client.post(f"{API}/checklists/from-template", json={"template_id": OFFICIAL}).json()
    assert made["origin"] == "official" and made["template_id"] == OFFICIAL and made["latest_version"] == 1
    assert made["versions"][0]["config"] == template["config"]

    config = made["versions"][0]["config"]                                      # customize the copy
    config["criteria"] = [c for c in config["criteria"] if c["id"] != "closure"]
    config["criteria"][0]["weight"] = 15
    assert save(client, made, config).json()["latest_version"] == 2
    assert client.get(f"{API}/checklist-templates/{OFFICIAL}").json() == template  # reference unchanged

    custom = client.post(f"{API}/checklists/from-template", json={"template_id": OFFICIAL, "name": "Team copy"})
    assert custom.json()["name"] == "Team copy"
    with restarted(settings) as again:                                          # restart: no new copies
        assert len(again.get(f"{API}/checklists").json()) == 2
    assert len(client.get(f"{API}/checklists").json()) == 2


def test_official_template_evaluates_with_the_mock_and_reports_the_critical_flag(client):
    import_fixtures(client)
    made = client.post(f"{API}/checklists/from-template", json={"template_id": OFFICIAL}).json()
    evaluate(client, made["id"])
    items = client.get(f"{API}/evaluations", params={"checklist_id": made["id"]}).json()["items"]
    assert items and all(e["status"] == "completed" for e in items), [e.get("error") for e in items]
    record = client.get(f"{API}/evaluations/{items[0]['id']}").json()
    assert [v["criterion"]["id"] for v in record["criteria"]] == list(OFFICIAL_TABLE)
    critical = next(c for c in record["evaluation"]["final_score"]["criteria"] if c["criterion_id"] == "critical")
    assert critical["weight"] == 0 and critical["points"] in (0, None)


def test_disabled_criteria_are_not_sent_to_the_evaluator(client):
    import_fixtures(client)
    checklist = create(client, {"name": "Partly off", "config": {"criteria": [
        weighted("on", 100), weighted("off", 50, enabled=False)]}})
    evaluate(client, checklist["id"], ["fx-ru-001"])
    item = client.get(f"{API}/evaluations", params={"checklist_id": checklist["id"]}).json()["items"][0]
    sent = client.get(f"{API}/evaluations/{item['id']}/request").json()
    assert [c["id"] for c in sent["checklist"]["criteria"]] == ["on"]
    detail = client.get(f"{API}/evaluations/{item['id']}").json()
    assert [v["criterion"]["id"] for v in detail["criteria"]] == ["on"]
    assert detail["evaluation"]["checklist"]["criteria"][1]["id"] == "off"  # kept in the snapshot
