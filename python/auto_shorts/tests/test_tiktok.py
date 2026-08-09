from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from auto_shorts.tiktok import TikTokClient, TikTokError, generate_pkce


class _Response:
    def __init__(self, payload: bytes = b""):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.payload


def test_authorization_url_contains_web_scopes_and_pkce():
    client = TikTokClient("client-key", "client-secret")
    verifier, challenge = generate_pkce()
    url = client.authorization_url("http://127.0.0.1:8765/tiktok/callback", state="state-1", code_verifier=verifier)
    query = parse_qs(urlparse(url).query)

    assert query["client_key"] == ["client-key"]
    assert query["scope"] == ["user.info.basic,video.upload"]
    assert query["state"] == ["state-1"]
    assert query["code_challenge"] == [challenge]
    assert query["code_challenge_method"] == ["S256"]
    assert len(verifier) >= 43


def test_exchange_code_sends_form_and_returns_safe_metadata(monkeypatch):
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((request, timeout))
        return _Response(
            json.dumps(
                {
                    "access_token": "access-secret",
                    "refresh_token": "refresh-secret",
                    "open_id": "open-1",
                    "scope": "user.info.basic,video.upload",
                    "expires_in": 86400,
                    "refresh_expires_in": 31536000,
                    "token_type": "Bearer",
                }
            ).encode()
        )

    monkeypatch.setattr("auto_shorts.tiktok.urlopen", fake_urlopen)
    token = TikTokClient("client-key", "client-secret").exchange_code(
        "auth-code", "http://127.0.0.1:8765/tiktok/callback", code_verifier="v" * 43
    )

    body = parse_qs(calls[0][0].data.decode())
    assert body["client_key"] == ["client-key"]
    assert body["client_secret"] == ["client-secret"]
    assert body["code"] == ["auth-code"]
    assert body["code_verifier"] == ["v" * 43]
    assert token.public_dict() == {
        "open_id": "open-1",
        "scope": "user.info.basic,video.upload",
        "expires_in": 86400,
        "refresh_expires_in": 31536000,
        "token_type": "Bearer",
    }


def test_upload_to_draft_requires_explicit_confirmation(tmp_path: Path):
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")

    with pytest.raises(TikTokError, match="confirm-upload"):
        TikTokClient("client-key", "client-secret").upload_video_to_draft(video, "access-token")


def test_upload_to_draft_initializes_and_sends_file(monkeypatch, tmp_path: Path):
    video = tmp_path / "reel.mp4"
    payload = b"0123456789"
    video.write_bytes(payload)
    calls = []

    def fake_urlopen(request, timeout):
        calls.append(request)
        if request.full_url.endswith("/video/init/"):
            return _Response(json.dumps({"data": {"publish_id": "publish-1", "upload_url": "https://upload.example/1"}, "error": {"code": "ok"}}).encode())
        return _Response()

    monkeypatch.setattr("auto_shorts.tiktok.urlopen", fake_urlopen)
    publish_id = TikTokClient("client-key", "client-secret").upload_video_to_draft(
        video, "access-token", confirm=True
    )

    assert publish_id == "publish-1"
    assert len(calls) == 2
    init_body = json.loads(calls[0].data.decode())
    assert init_body["source_info"] == {
        "source": "FILE_UPLOAD",
        "video_size": len(payload),
        "chunk_size": len(payload),
        "total_chunk_count": 1,
    }
    assert calls[1].method == "PUT"
    assert calls[1].data == payload
    assert calls[1].headers["Content-range"] == f"bytes 0-{len(payload) - 1}/{len(payload)}"
    assert hashlib.sha256(calls[1].data).hexdigest()
