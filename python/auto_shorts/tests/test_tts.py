import json
from pathlib import Path

import pytest

from auto_shorts.tts import FishAudioTTS, TtsError


class _Response:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


def test_fish_audio_requires_api_key(tmp_path: Path):
    with pytest.raises(TtsError, match="FISHAUDIO_API_KEY"):
        FishAudioTTS("", cache_dir=tmp_path / "cache")


def test_fish_audio_synthesizes_and_caches(monkeypatch, tmp_path: Path):
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((request, timeout))
        return _Response(b"fake-mp3")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    output = tmp_path / "audio" / "news.mp3"
    client = FishAudioTTS("secret", cache_dir=tmp_path / "cache", reference_id="voice-1")

    client.synthesize("안녕하세요", output, speed=1.05)
    client.synthesize("안녕하세요", output, speed=1.05)

    assert output.read_bytes() == b"fake-mp3"
    assert len(calls) == 1
    request, timeout = calls[0]
    assert timeout == 120
    assert request.headers["Authorization"] == "Bearer secret"
    assert request.headers["Model"] == "s2.1-pro-free"
    payload = json.loads(request.data)
    assert payload["text"] == "안녕하세요"
    assert payload["reference_id"] == "voice-1"
    assert payload["format"] == "mp3"
    assert payload["prosody"]["speed"] == 1.05
