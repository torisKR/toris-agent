import json
from pathlib import Path

import pytest

from auto_shorts.klipy import KlipyClient, KlipyError


class _Response:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.payload


def test_search_and_download_clip(monkeypatch, tmp_path: Path):
    calls = []
    responses = [
        _Response(
            json.dumps(
                {
                    "result": True,
                    "data": {
                        "data": [
                            {
                                "id": 7,
                                "title": "Funny",
                                "slug": "funny-7",
                                "file": {"mp4": "https://cdn.example/clip.mp4"},
                            }
                        ]
                    },
                }
            ).encode()
        ),
        _Response(b"video-bytes"),
    ]

    def fake_urlopen(request, timeout):
        calls.append(request.full_url)
        return responses.pop(0)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = KlipyClient("secret-key")
    clips = client.search_clips("funny")
    output = client.download_clip(clips[0], tmp_path / "clip.mp4")

    assert clips[0].title == "Funny"
    assert output.read_bytes() == b"video-bytes"
    assert "/secret-key/" in calls[0]
    assert calls[1] == "https://cdn.example/clip.mp4"


def test_search_requires_key_and_query():
    with pytest.raises(KlipyError, match="KLIPY_API_KEY"):
        KlipyClient("")
    with pytest.raises(KlipyError, match="query"):
        KlipyClient("secret-key").search_clips(" ")
