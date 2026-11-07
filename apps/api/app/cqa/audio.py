"""Call recordings.

A call's ``audio_url`` points at an organizer-hosted *player page* (HTML), not at an audio file. The page embeds
a short-lived signed MP3 link (it expires after about an hour). To give the browser a playable source, the API
fetches the page and extracts the ``<source src>`` / ``<audio src>`` link each time a call is opened (cached for a
few minutes). Only https hosts in ``ATLAS_CQA_AUDIO_HOSTS`` are ever contacted, so imported data cannot make the
API request arbitrary URLs. If anything fails, the UI falls back to opening the original player page.
"""

from __future__ import annotations

import html
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

from app.core.config import Settings
from app.cqa.schemas import AudioInfo, ConversationRecord

CACHE_SECONDS = 600
MAX_PAGE_BYTES = 1024 * 1024
_SOURCE = re.compile(r"<(?:source|audio)\b[^>]*?\bsrc\s*=\s*([\"'])(.*?)\1([^>]*)>", re.IGNORECASE | re.DOTALL)
_TYPE = re.compile(r"\btype\s*=\s*([\"'])(.*?)\1", re.IGNORECASE)

Opener = Callable[[str, float], tuple[str, bytes]]


def host_allowed(url: str, allowed: list[str]) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host:
        return False
    return any(host == suffix.lower() or host.endswith("." + suffix.lower().lstrip(".")) for suffix in allowed)


def open_url(url: str, timeout: float) -> tuple[str, bytes]:
    """GET up to 1 MB. Returns (content type, first bytes). Audio bodies are not downloaded beyond the peek."""
    request = urllib.request.Request(url, headers={"User-Agent": "ATLAS-CQA/1.0", "Range": "bytes=0-1048575"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (host allow-listed)
        content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        body = b"" if content_type.startswith("audio/") else response.read(MAX_PAGE_BYTES)
    return content_type, body


def extract_audio_source(page: str) -> tuple[str, str | None] | None:
    match = _SOURCE.search(page)
    if not match:
        return None
    url = html.unescape(match.group(2)).strip()
    type_match = _TYPE.search(match.group(0))
    return url, (type_match.group(2).strip() if type_match else None)


def _expiry(url: str) -> float:
    """Seconds until a signed URL expires (Azure-style ``se=``), capped by the cache window."""
    expires = parse_qs(urlsplit(url).query).get("se", [None])[0]
    if expires:
        try:
            moment = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            return max(0.0, min(CACHE_SECONDS, (moment - datetime.now(UTC)).total_seconds() - 120))
        except ValueError:
            pass
    return CACHE_SECONDS


class AudioResolver:
    def __init__(self, settings: Settings, opener: Opener = open_url) -> None:
        self.settings = settings
        self.opener = opener
        self._cache: dict[str, tuple[float, AudioInfo]] = {}

    def resolve(self, conversation: ConversationRecord) -> AudioInfo:
        url = conversation.audio_url
        if not url:
            return AudioInfo(status="unavailable", message="This conversation has no recording.")
        cached = self._cache.get(conversation.id)
        if cached and cached[0] > time.monotonic() and cached[1].player_url == url:
            return cached[1]
        allowed = self.settings.cqa_audio_hosts
        if not host_allowed(url, allowed):
            return AudioInfo(status="player_only", player_url=url,
                             message="The recording host is not in ATLAS_CQA_AUDIO_HOSTS, so the API does not contact "
                                     "it. Open the player page instead.")
        try:
            content_type, body = self.opener(url, 20.0)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return AudioInfo(status="player_only", player_url=url,
                             message=f"Could not reach the recording service ({type(error).__name__}).")
        if content_type.startswith("audio/"):
            info = AudioInfo(status="ready", stream_url=url, player_url=url, content_type=content_type)
        else:
            found = extract_audio_source(body.decode("utf-8", "replace"))
            if not found:
                return AudioInfo(status="player_only", player_url=url,
                                 message="The player page has no audio source the app can play directly.")
            stream_url, stream_type = found
            if not host_allowed(stream_url, allowed):
                return AudioInfo(status="player_only", player_url=url,
                                 message="The audio file is hosted outside ATLAS_CQA_AUDIO_HOSTS.")
            info = AudioInfo(status="ready", stream_url=stream_url, player_url=url, content_type=stream_type)
        if info.stream_url:
            self._cache[conversation.id] = (time.monotonic() + _expiry(info.stream_url), info)
        return info
