"""Conversation ingestion: the organizers' API (GET by group_id), its payload format, and labeled fixtures.

Payload format (CQA Hackathon student guide, p. 3)::

    {"error": "", "isSuccess": true, "data": {
        "dataset_group_id": "DEV", "total_records": 65,
        "records": [{"conversation_id": "p1-ru-001", "channel": "agent chat", "language": "RU",
                     "transcript": [{"timestamp": "00:02", "speaker": "operator", "text": "..."}],
                     "audio_url": null}]}}

* channel: "agent chat" or "voice call"; language: RU, KZ or EN; speakers: client, operator, bot, system.
* Chat timestamps are MM:SS; call timestamps are ISO 8601 with a time zone. Both are kept verbatim.
* audio_url is empty for chats and links to the recording's player page for calls.

Records that cannot be parsed are rejected one by one with a reason; the rest of the import continues.
Nothing is invented: unknown values are kept as received and reported as warnings.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from app.core.errors import AppError, ValidationFailed
from app.cqa.schemas import (
    CONVERSATION_ID_PATTERN,
    Channel,
    ConversationRecord,
    ConversationSource,
    ImportIssue,
    Message,
    Speaker,
)

FIXTURES_PATH = Path(__file__).resolve().parent / "fixtures" / "conversations.json"
FIXTURE_PREFIX = "FIXTURE"
MAX_SOURCE_BYTES = 64 * 1024 * 1024

_CHANNELS: dict[str, Channel] = {"agent chat": "chat", "chat": "chat", "voice call": "voice", "voice": "voice",
                                 "call": "voice"}
_LANGUAGES = {"RU": "RU", "RUS": "RU", "RU-RU": "RU", "KZ": "KZ", "KK": "KZ", "KAZ": "KZ", "KK-KZ": "KZ",
              "EN": "EN", "ENG": "EN", "EN-US": "EN", "EN-GB": "EN"}
_SPEAKERS: dict[str, Speaker] = {"client": "client", "customer": "client", "клиент": "client",
                                 "operator": "operator", "agent": "operator", "оператор": "operator",
                                 "bot": "bot", "бот": "bot", "system": "system", "система": "system"}
_CLOCK = re.compile(r"^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?:[.,](\d+))?$")
_FRACTION = re.compile(r"(\.\d{6})\d+")
_ID = re.compile(CONVERSATION_ID_PATTERN)


class SourceError(AppError):
    status_code = 502
    code = "source_unavailable"


@dataclass
class ParsedPayload:
    reported_group: str | None
    reported_total: int | None
    records: list[ConversationRecord] = field(default_factory=list)
    issues: list[ImportIssue] = field(default_factory=list)
    received: int = 0


# ---------------------------------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------------------------------


def parse_clock(value: str) -> float | None:
    """MM:SS (or H:MM:SS, with optional fraction) → seconds."""
    match = _CLOCK.fullmatch(value.strip())
    if not match:
        return None
    hours, minutes, seconds, fraction = match.groups()
    if int(seconds) >= 60 or (hours is not None and int(minutes) >= 60):
        return None
    total = int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)
    return total + (float(f"0.{fraction}") if fraction else 0.0)


def parse_instant(value: str) -> datetime | None:
    """ISO 8601 → datetime. Accepts 'Z' and more than six fractional digits (the call transcripts have seven)."""
    text = value.strip()
    if not text or ("T" not in text and " " not in text):
        return None
    text = _FRACTION.sub(r"\1", text.replace("Z", "+00:00").replace("z", "+00:00"))
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


# ---------------------------------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------------------------------


def transcript_hash(messages: list[Message]) -> str:
    canonical = json.dumps([[m.speaker_raw, m.timestamp, m.text] for m in messages], ensure_ascii=False,
                           separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _issue(severity: str, code: str, message: str, index: int | None, cid: str | None) -> ImportIssue:
    return ImportIssue(severity=severity, code=code, message=message, record_index=index, conversation_id=cid)


def parse_record(record: Any, index: int, group_id: str, source: ConversationSource, now: str, *,
                 max_messages: int = 3_000, max_chars: int = 20_000) -> tuple[ConversationRecord | None,
                                                                              list[ImportIssue]]:
    issues: list[ImportIssue] = []
    if not isinstance(record, dict):
        return None, [_issue("error", "invalid_record", "Record is not an object.", index, None)]
    cid = record.get("conversation_id")
    cid = str(cid).strip() if isinstance(cid, (str, int)) and not isinstance(cid, bool) else None
    if not cid or not _ID.fullmatch(cid):
        return None, [_issue("error", "invalid_conversation_id",
                             "conversation_id is missing or has unsupported characters.", index, None)]

    def warn(code: str, message: str) -> None:
        issues.append(_issue("warning", code, message, index, cid))

    def reject(code: str, message: str) -> tuple[None, list[ImportIssue]]:
        issues.append(_issue("error", code, message, index, cid))
        return None, issues

    audio_url = record.get("audio_url")
    if isinstance(audio_url, str) and audio_url.strip():
        audio_url = audio_url.strip()
        if urlsplit(audio_url).scheme not in ("http", "https"):
            warn("invalid_audio_url", "audio_url is not an http(s) link and was ignored.")
            audio_url = None
    else:
        audio_url = None

    channel_raw = str(record.get("channel") or "").strip()
    channel = _CHANNELS.get(channel_raw.lower())
    if channel is None:
        channel = "voice" if audio_url else "chat"
        warn("unknown_channel", f"Channel '{channel_raw or '(empty)'}' is not 'agent chat' or 'voice call'; "
                                f"treated as {channel} because audio_url is {'set' if audio_url else 'empty'}.")

    language_raw = str(record.get("language") or "").strip()
    language = _LANGUAGES.get(language_raw.upper())
    if language is None:
        language = language_raw.upper() or "UNKNOWN"
        warn("unknown_language", f"Language '{language_raw or '(empty)'}' is not RU, KZ or EN; kept as received.")

    transcript = record.get("transcript")
    if isinstance(transcript, str):
        try:
            transcript = json.loads(transcript)
            warn("transcript_was_text", "transcript arrived as a JSON string and was decoded.")
        except json.JSONDecodeError:
            return reject("invalid_transcript", "transcript is text but not JSON.")
    if not isinstance(transcript, list) or not transcript:
        return reject("invalid_transcript", "transcript is missing or empty.")
    if len(transcript) > max_messages:
        return reject("transcript_too_long", f"transcript has {len(transcript)} lines (limit {max_messages}).")

    messages: list[Message] = []
    instants: list[datetime | None] = []
    for position, line in enumerate(transcript):
        if not isinstance(line, dict):
            return reject("invalid_message", f"Line {position + 1} is not an object.")
        speaker_raw = str(line.get("speaker") or "").strip()
        speaker = _SPEAKERS.get(speaker_raw.lower(), "unknown")
        if speaker == "unknown":
            warn("unknown_speaker", f"Line {position + 1}: speaker '{speaker_raw or '(empty)'}' is not a known role.")
        text = line.get("text")
        if text is None:
            text = ""
            warn("empty_text", f"Line {position + 1} has no text.")
        elif not isinstance(text, str):
            text = str(text)
        if len(text) > max_chars:
            return reject("message_too_long", f"Line {position + 1} is longer than {max_chars} characters.")
        timestamp = line.get("timestamp")
        timestamp = "" if timestamp is None else str(timestamp).strip()
        offset = parse_clock(timestamp) if timestamp else None
        instant = None if offset is not None or not timestamp else parse_instant(timestamp)
        if timestamp and offset is None and instant is None:
            warn("unparsed_timestamp", f"Line {position + 1}: timestamp '{timestamp}' kept as text (not MM:SS or "
                                       "ISO 8601).")
        instants.append(instant)
        messages.append(Message(id=f"m{position + 1}", index=position, speaker=speaker, speaker_raw=speaker_raw,
                                text=text, timestamp=timestamp, offset_seconds=offset,
                                at=instant.isoformat() if instant else None))

    first = next((i for i in instants if i is not None), None)
    if first is not None:
        for message, instant in zip(messages, instants, strict=True):
            if instant is not None:
                try:
                    message.offset_seconds = round((instant - first).total_seconds(), 3)
                except TypeError:  # naive and aware instants mixed
                    message.offset_seconds = None
    if channel == "voice" and not audio_url:
        warn("no_recording", "Voice call without audio_url: there is no recording to play.")

    return ConversationRecord(
        id=cid, group_ids=[group_id], channel=channel, channel_raw=channel_raw, language=language,
        language_raw=language_raw, audio_url=audio_url, source=source, messages=messages,
        transcript_hash=transcript_hash(messages), revision=1, imported_at=now, updated_at=now,
        warnings=[i.message for i in issues if i.severity == "warning"]), issues


def parse_payload(payload: Any, group_id: str, source: ConversationSource, now: str, *, max_messages: int = 3_000,
                  max_chars: int = 20_000) -> ParsedPayload:
    if not isinstance(payload, dict):
        raise SourceError("The source did not return a JSON object.", code="invalid_payload")
    if payload.get("isSuccess") is False:
        reason = str(payload.get("error") or "no reason given")[:300]
        raise SourceError(f"The organizers' API reported a failure: {reason}", code="source_failed")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise SourceError("The response has no data.records array.", code="invalid_payload")
    reported_total = data.get("total_records")
    parsed = ParsedPayload(reported_group=str(data.get("dataset_group_id") or "") or None,
                           reported_total=reported_total if isinstance(reported_total, int) else None)
    parsed.received = len(data["records"])
    seen: set[str] = set()
    for index, record in enumerate(data["records"]):
        conversation, issues = parse_record(record, index, group_id, source, now, max_messages=max_messages,
                                            max_chars=max_chars)
        parsed.issues.extend(issues)
        if conversation is None:
            continue
        if conversation.id in seen:
            parsed.issues.append(_issue("error", "duplicate_conversation_id",
                                        "conversation_id appears more than once in this response; only the first "
                                        "was kept.", index, conversation.id))
            continue
        seen.add(conversation.id)
        parsed.records.append(conversation)
    if parsed.reported_group and parsed.reported_group != group_id:
        parsed.issues.append(_issue("warning", "group_mismatch",
                                    f"Requested group '{group_id}', the source answered for "
                                    f"'{parsed.reported_group}'.", None, None))
    if parsed.reported_total is not None and parsed.reported_total != parsed.received:
        parsed.issues.append(_issue("warning", "count_mismatch",
                                    f"total_records says {parsed.reported_total}, the response holds "
                                    f"{parsed.received} records.", None, None))
    return parsed


# ---------------------------------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------------------------------


def source_url_for(base_url: str, group_id: str) -> str:
    """The configured URL with ``group_id`` set. The rest of the query (signed token) is kept byte for byte."""
    parts = urlsplit(base_url)
    if parts.scheme not in ("https", "http") or not parts.netloc:
        raise ValidationFailed("ATLAS_CQA_SOURCE_URL must be an http(s) URL.", code="invalid_source_url")
    query = [item for item in parts.query.split("&") if item and not item.lower().startswith("group_id=")]
    query.append(f"group_id={quote(group_id, safe='')}")
    return parts._replace(query="&".join(query)).geturl()


Fetcher = Callable[[str, float], Any]


def http_get_json(url: str, timeout: float) -> Any:
    """GET a JSON document. Error messages never include the URL: it carries a signed token."""
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "ATLAS-CQA/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (scheme checked)
            body = response.read(MAX_SOURCE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise SourceError(f"The organizers' API answered HTTP {error.code}.", code="source_http_error") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise SourceError(f"Could not reach the organizers' API ({type(reason).__name__}).") from None
    if len(body) > MAX_SOURCE_BYTES:
        raise SourceError("The response is larger than 64 MB.", code="source_too_large")
    try:
        return json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SourceError("The organizers' API did not return JSON.", code="invalid_payload") from None


def load_fixtures(path: Path = FIXTURES_PATH) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    return document.get("groups", {})


def fixture_groups(path: Path = FIXTURES_PATH) -> list[str]:
    try:
        return sorted(load_fixtures(path))
    except (OSError, json.JSONDecodeError):
        return []


def fixture_payload(group_id: str, path: Path = FIXTURES_PATH) -> Any:
    groups = load_fixtures(path)
    if group_id not in groups:
        raise ValidationFailed(f"No fixture group '{group_id}'. Available: {', '.join(sorted(groups)) or 'none'}.",
                               code="unknown_fixture_group")
    return groups[group_id]
