"""Conversation import: organizers' payload parsing (RU/KZ/EN, chat and call, every speaker role), the server-side
fetch by group_id, re-imports and failure handling. All data is synthetic."""

from __future__ import annotations

import pytest

from app.cqa.ingestion import (
    SourceError,
    parse_clock,
    parse_instant,
    parse_payload,
    source_url_for,
)
from tests.cqa_helpers import API, chat_record, import_fixtures, organizer_payload

NOW = "2026-11-07T08:00:00+00:00"
SIGNED = "https://example.invalid/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=AbC%2B1&group_id=DEV"


def voice_record(cid: str = "call-1") -> dict:
    return {"conversation_id": cid, "channel": "voice call", "language": "RU",
            "audio_url": "https://player.example.invalid/rec/1",
            "transcript": [
                {"timestamp": "2026-11-03T13:10:00.6388245+00:00", "speaker": "operator", "text": "Добрый день."},
                {"timestamp": "2026-11-03T13:10:04.1388245+00:00", "speaker": "client", "text": "Здравствуйте."},
                {"timestamp": "2026-11-03T13:11:00.6388245+00:00", "speaker": "system", "text": "Перевод звонка."}]}


def test_clock_and_iso_timestamps():
    assert parse_clock("00:02") == 2 and parse_clock("12:34") == 754 and parse_clock("1:02:03") == 3723
    assert parse_clock("00:61") is None and parse_clock("abc") is None
    assert parse_instant("2026-11-03T15:49:13.1900670+00:00").microsecond == 190067  # seven digits accepted
    assert parse_instant("2026-11-04T14:30:00Z").utcoffset().total_seconds() == 0
    assert parse_instant("00:02") is None


@pytest.mark.parametrize(("language", "expected"), [("RU", "RU"), ("KZ", "KZ"), ("EN", "EN"), ("kk", "KZ")])
def test_parses_chats_in_all_three_languages(language, expected):
    parsed = parse_payload(organizer_payload([chat_record("c1", language)]), "DEV", "organizer_api", NOW)
    record = parsed.records[0]
    assert record.language == expected and record.language_raw == language and record.channel == "chat"
    assert record.channel_raw == "agent chat"


def test_preserves_speakers_timestamps_and_text_with_stable_ids():
    parsed = parse_payload(organizer_payload([chat_record("c1")]), "DEV", "organizer_api", NOW)
    messages = parsed.records[0].messages
    assert [m.id for m in messages] == ["m1", "m2", "m3", "m4", "m5"]
    assert [m.speaker for m in messages] == ["client", "bot", "system", "operator", "client"]
    assert [m.timestamp for m in messages] == ["00:00", "00:05", "00:06", "00:40", "01:10"]
    assert messages[3].offset_seconds == 40 and messages[3].text == "Добрый день! Меня зовут Ая. Чем помочь?"
    again = parse_payload(organizer_payload([chat_record("c1")]), "DEV", "organizer_api", NOW)
    assert again.records[0].transcript_hash == parsed.records[0].transcript_hash


def test_parses_voice_calls_with_iso_offsets_and_audio():
    record = parse_payload(organizer_payload([voice_record()]), "DEV", "organizer_api", NOW).records[0]
    assert record.channel == "voice" and record.audio_url == "https://player.example.invalid/rec/1"
    assert record.messages[0].timestamp == "2026-11-03T13:10:00.6388245+00:00"  # kept verbatim
    assert [m.offset_seconds for m in record.messages] == [0.0, 3.5, 60.0]
    assert record.messages[1].at.startswith("2026-11-03T13:10:04")


def test_rejects_bad_records_individually_and_keeps_the_rest():
    records = [chat_record("good"), {"conversation_id": "bad/../id", "transcript": []},
               {"conversation_id": "empty", "channel": "agent chat", "language": "RU", "transcript": []},
               chat_record("good"), "not a record"]
    parsed = parse_payload(organizer_payload(records), "DEV", "organizer_api", NOW)
    assert [r.id for r in parsed.records] == ["good"]
    codes = [i.code for i in parsed.issues if i.severity == "error"]
    assert codes == ["invalid_conversation_id", "invalid_transcript", "duplicate_conversation_id", "invalid_record"]


def test_unknown_values_are_kept_and_reported_not_invented():
    record = chat_record("odd", "DE")
    record["channel"] = "carrier pigeon"
    record["transcript"].append({"timestamp": "later", "speaker": "supervisor", "text": None})
    parsed = parse_payload(organizer_payload([record]), "DEV", "organizer_api", NOW)
    conversation = parsed.records[0]
    assert conversation.language == "DE" and conversation.channel == "chat"
    last = conversation.messages[-1]
    assert last.speaker == "unknown" and last.speaker_raw == "supervisor" and last.timestamp == "later"
    assert {"unknown_language", "unknown_channel", "unknown_speaker", "empty_text", "unparsed_timestamp"} <= {
        i.code for i in parsed.issues}


def test_source_failure_and_bad_shapes_raise():
    with pytest.raises(SourceError, match="reported a failure: group not found"):
        parse_payload({"isSuccess": False, "error": "group not found", "data": None}, "X", "organizer_api", NOW)
    with pytest.raises(SourceError):
        parse_payload({"isSuccess": True, "data": {}}, "X", "organizer_api", NOW)


def test_group_id_is_set_without_touching_the_signed_query():
    url = source_url_for(SIGNED, "CONTROL-1")
    assert url.endswith("&sig=AbC%2B1&group_id=CONTROL-1")
    assert url.count("group_id=") == 1 and "sp=%2Ftriggers%2Fmanual%2Frun" in url


# ---- through the API --------------------------------------------------------------------------------


@pytest.fixture
def source(client, settings):
    """Point the API at a fake organizers' endpoint; record the URLs it requests."""
    calls: list[str] = []
    datasets: dict[str, dict] = {}

    def fetch(url: str, timeout: float):
        calls.append(url)
        group = url.rsplit("group_id=", 1)[1]
        if group not in datasets:
            return {"isSuccess": False, "error": f"unknown group {group}", "data": None}
        return datasets[group]

    settings.cqa_source_url = SIGNED
    client.app.state.cqa.fetcher = fetch
    return calls, datasets


def test_import_requires_a_configured_source(client):
    response = client.post(f"{API}/imports", json={"group_id": "DEV"})
    assert response.status_code == 422 and response.json()["error"]["code"] == "source_not_configured"


def test_import_by_group_id_through_the_backend(client, source):
    calls, datasets = source
    datasets["DEV"] = organizer_payload([chat_record("p-ru-1", "RU"), chat_record("p-kz-1", "KZ"),
                                         chat_record("p-en-1", "EN"), voice_record("p-call-1")])
    run = client.post(f"{API}/imports", json={"group_id": "DEV"}).json()
    assert run["status"] == "completed" and run["created"] == 4 and run["reported_total"] == 4
    assert calls and "group_id=DEV" in calls[0]
    page = client.get(f"{API}/conversations").json()
    assert page["total"] == 4
    assert {f["value"]: f["count"] for f in page["facets"]["language"]} == {"EN": 1, "KZ": 1, "RU": 2}
    assert {f["value"] for f in page["facets"]["channel"]} == {"chat", "voice"}
    detail = client.get(f"{API}/conversations/p-call-1").json()
    assert detail["has_audio"] and detail["messages"][0]["speaker"] == "operator"


def test_reimport_is_idempotent_and_a_new_group_adds_conversations(client, source):
    _, datasets = source
    datasets["DEV"] = organizer_payload([chat_record("a"), chat_record("b")])
    datasets["CONTROL"] = organizer_payload([chat_record("b"), chat_record("c")], group="CONTROL")
    client.post(f"{API}/imports", json={"group_id": "DEV"})
    again = client.post(f"{API}/imports", json={"group_id": "DEV"}).json()
    assert again["created"] == 0 and again["unchanged"] == 2
    control = client.post(f"{API}/imports", json={"group_id": "CONTROL"}).json()
    assert control["created"] == 1 and control["unchanged"] == 1
    assert client.get(f"{API}/conversations/b").json()["group_ids"] == ["DEV", "CONTROL"]
    assert client.get(f"{API}/conversations", params={"group_id": "CONTROL"}).json()["total"] == 2


def test_changed_transcript_creates_a_new_revision(client, source):
    _, datasets = source
    datasets["DEV"] = organizer_payload([chat_record("a")])
    client.post(f"{API}/imports", json={"group_id": "DEV"})
    changed = chat_record("a")
    changed["transcript"][0]["text"] = "Другой текст."
    datasets["DEV"] = organizer_payload([changed])
    run = client.post(f"{API}/imports", json={"group_id": "DEV"}).json()
    assert run["updated"] == 1 and any(i["code"] == "transcript_changed" for i in run["issues"])
    assert client.get(f"{API}/conversations/a").json()["revision"] == 2


def test_source_failure_is_reported_and_logged_without_leaking_the_url(client, source):
    response = client.post(f"{API}/imports", json={"group_id": "MISSING"})
    assert response.status_code == 502
    assert "unknown group MISSING" in response.json()["error"]["message"]
    runs = client.get(f"{API}/imports").json()
    assert runs[0]["status"] == "failed" and "sig=" not in str(runs)


def test_fixtures_are_labeled_and_cannot_pose_as_organizer_data(client):
    run = import_fixtures(client)
    assert run["source"] == "fixture" and run["created"] == 6
    page = client.get(f"{API}/conversations", params={"source": "fixture"}).json()
    assert all(item["id"].startswith("fx-") and item["source"] == "fixture" for item in page["items"])
    assert client.post(f"{API}/imports", json={"group_id": "FIXTURE"}).status_code == 422
    assert client.post(f"{API}/imports", json={"group_id": "DEV", "source": "fixture"}).status_code == 422


def test_conversation_list_search_filter_sort_and_paging(client):
    import_fixtures(client)
    assert client.get(f"{API}/conversations", params={"q": "PIN"}).json()["total"] == 1  # English text
    assert client.get(f"{API}/conversations", params={"q": "шотты"}).json()["total"] == 1  # Kazakh text
    assert client.get(f"{API}/conversations", params={"language": ["KZ", "EN"]}).json()["total"] == 4
    assert client.get(f"{API}/conversations", params={"channel": "voice"}).json()["items"][0]["id"] == "fx-ru-002"
    page = client.get(f"{API}/conversations", params={"page_size": 4, "page": 2, "sort": "messages",
                                                     "desc": True}).json()
    assert page["total"] == 6 and len(page["items"]) == 2
    not_evaluated = client.get(f"{API}/conversations", params={"status": "not_evaluated"}).json()
    assert not_evaluated["total"] == 6
    assert client.get(f"{API}/conversations/does-not-exist").status_code == 404
