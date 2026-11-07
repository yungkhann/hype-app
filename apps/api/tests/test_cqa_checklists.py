"""Checklist configuration: create, edit, reorder, versions, duplicate, replace a criterion, import/export."""

from __future__ import annotations

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
    config["criteria"].append({"id": "bye", "name": "Farewell", "weight": 10, "answer_type": "binary"})
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
    config["criteria"][0]["weight"] = 25
    assert save(client, checklist, config).status_code == 200
    config["criteria"][0]["weight"] = 30
    stale = save(client, checklist, config)  # still based on v1
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_checklist"


def test_invalid_configurations_are_rejected(client):
    bad_cases = [
        {"criteria": [{"id": "a", "name": "A", "weight": 1}, {"id": "a", "name": "B", "weight": 1}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 1, "section_id": "missing"}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 0}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 1, "answer_type": "options", "options": [
            {"id": "x", "label": "X", "points": 1}]}]},
        {"criteria": [{"id": "a", "name": "A", "weight": 1, "answer_type": "scale",
                       "scale": {"min": 5, "max": 1, "step": 1}}]},
        {"criteria": []},
        {"criteria": [{"id": "Bad Id", "name": "A", "weight": 1}]},
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
    config["criteria"][0]["weight"] = 99
    save(client, copy, config)
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
