import json
from pathlib import Path

import pytest

from auto_shorts.publish import PublishError
import auto_shorts.social_agents as social_agents
from auto_shorts.social_agents import (
    CHANNELS,
    SocialBrief,
    create_social_package,
    load_env_file,
    load_social_package,
    publish_social_package,
)


ACCOUNT_ENV = {
    "ZERNIO_YOUTUBE_ACCOUNT_ID": "youtube-account",
    "ZERNIO_INSTAGRAM_ACCOUNT_ID": "instagram-account",
    "ZERNIO_THREADS_ACCOUNT_ID": "threads-account",
    "ZERNIO_X_ACCOUNT_ID": "x-account",
}


def _brief(tmp_path: Path) -> Path:
    for name in ("long.mp4", "short.mp4", "thumb.jpg", "card.png"):
        (tmp_path / name).write_bytes(b"media")
    value = {
        "headline": "Claude와 ChatGPT를 팀처럼 쓰는 AI 오케스트레이션",
        "hook": "AI 두 개를 켠다고 팀이 되지는 않습니다.",
        "body": "역할과 산출물, 검증 게이트를 분리해야 결과가 안정됩니다. " * 12,
        "key_points": [
            "Claude는 긴 문서 분석을 맡깁니다.",
            "ChatGPT는 실행안과 산출물을 만듭니다.",
            "마지막 검증은 별도 단계로 둡니다.",
        ],
        "cta": "다음 실전 구현을 보려면 팔로우하세요.",
        "conversation_question": "여러분은 어떤 역할부터 분리하시겠어요?",
        "keywords": ["AI 오케스트레이션", "Claude", "ChatGPT", "개발 자동화"],
        "topic_tag": "AI오케스트레이션",
        "chapters": ["00:00 왜 오케스트레이션인가", "02:10 역할 분리"],
        "contains_synthetic_media": True,
        "channels": list(CHANNELS),
        "media": {
            "youtube": {"path": "long.mp4", "type": "video", "thumbnail": "thumb.jpg"},
            "youtube_short": {"path": "short.mp4", "type": "video"},
            "instagram": {"path": "short.mp4", "type": "video"},
            "threads": {"path": "card.png", "type": "image"},
            "x": {"path": "short.mp4", "type": "video"},
        },
    }
    path = tmp_path / "brief.json"
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return path


def test_platform_agents_create_distinct_drafts(tmp_path: Path):
    brief_path = _brief(tmp_path)
    output = tmp_path / "package.json"
    create_social_package(SocialBrief.from_json(brief_path), output, source=str(brief_path), environ=ACCOUNT_ENV)
    package = load_social_package(output)
    drafts = {draft.channel: draft for draft in package.drafts}

    assert tuple(draft.channel for draft in package.drafts) == CHANNELS
    assert drafts["youtube"].profile == "YOUTUBE_INSTAGRAM"
    assert drafts["youtube"].platform_specific_data["categoryId"] == "27"
    assert drafts["youtube"].platform_specific_data["containsSyntheticMedia"] is True
    assert drafts["youtube"].media and drafts["youtube"].media.thumbnail
    assert drafts["youtube_short"].platform == "youtube"
    assert drafts["youtube_short"].media and drafts["youtube_short"].media.thumbnail is None
    assert drafts["instagram"].content.startswith("AI 두 개를 켠다고")
    assert drafts["instagram"].platform_specific_data == {"shareToFeed": True}
    assert drafts["threads"].profile == "THREADS_X"
    assert drafts["threads"].platform_specific_data["topic_tag"] == "AI오케스트레이션"
    assert all(len(item["content"]) <= 500 for item in drafts["threads"].platform_specific_data["threadItems"])
    assert drafts["x"].platform == "twitter"
    assert all(len(item["content"]) <= 280 for item in drafts["x"].platform_specific_data["threadItems"])
    assert "#" not in drafts["x"].content


def test_youtube_short_rejects_custom_thumbnail(tmp_path: Path):
    brief_path = _brief(tmp_path)
    value = json.loads(brief_path.read_text(encoding="utf-8"))
    value["channels"] = ["youtube_short"]
    value["media"]["youtube_short"]["thumbnail"] = "thumb.jpg"
    brief_path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(PublishError, match="Shorts custom thumbnails"):
        create_social_package(SocialBrief.from_json(brief_path), tmp_path / "package.json", source=str(brief_path), environ=ACCOUNT_ENV)


def test_social_publish_requires_explicit_confirmation(tmp_path: Path):
    brief_path = _brief(tmp_path)
    output = tmp_path / "package.json"
    create_social_package(SocialBrief.from_json(brief_path), output, source=str(brief_path), environ=ACCOUNT_ENV)
    package = load_social_package(output)

    with pytest.raises(PublishError, match="confirm-publish"):
        publish_social_package(package, environ={}, confirm=False)


def test_selected_agent_posts_to_its_account_and_records_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    brief_path = _brief(tmp_path)
    output = tmp_path / "package.json"
    create_social_package(SocialBrief.from_json(brief_path), output, source=str(brief_path), environ=ACCOUNT_ENV)
    package = load_social_package(output)
    payloads: list[dict] = []

    class FakeZernioClient:
        def __init__(self, token: str, api_root: str):
            assert token == "threads-x-token"
            assert api_root == "https://example.com/api/v1"

        def account_health(self, account_id: str) -> dict:
            assert account_id == "x-account"
            return {"status": "healthy", "capabilities": {"canPost": True}}

        def upload(self, path: Path, media_type: str) -> str:
            assert path.name == "short.mp4"
            assert media_type == "video"
            return "https://cdn.example.com/short.mp4"

        def create_post(self, payload: dict) -> dict:
            payloads.append(payload)
            return {
                "data": {
                    "post": {
                        "_id": "post-1",
                        "platforms": [
                            {
                                "platform": "twitter",
                                "status": "published",
                                "platformPostUrl": "https://x.com/toris_kr/status/1",
                            }
                        ],
                    }
                }
            }

        def get_post(self, post_id: str) -> dict:
            raise AssertionError("published response should not be polled")

    monkeypatch.setattr(social_agents, "ZernioClient", FakeZernioClient)
    environ = ACCOUNT_ENV | {
        "ZERNIO_THREADS_X_POSTS_URL": "https://example.com/api/v1/posts",
        "ZERNIO_THREADS_X_API_TOKEN": "threads-x-token",
    }
    result = publish_social_package(package, environ=environ, confirm=True, channels=("x",), wait_seconds=0)

    assert result["results"][0]["url"] == "https://x.com/toris_kr/status/1"
    assert payloads[0]["platforms"][0]["accountId"] == "x-account"
    assert "mediaItems" not in payloads[0]
    assert payloads[0]["platforms"][0]["platformSpecificData"]["threadItems"][0]["mediaItems"][0]["type"] == "video"


def test_env_file_expands_previous_value(tmp_path: Path):
    path = tmp_path / ".env.zernio"
    path.write_text("ROOT=https://example.com/api/v1/posts\nPOSTS_URL=\"${ROOT}\"\n", encoding="utf-8")
    environ: dict[str, str] = {}
    load_env_file(path, environ)
    assert environ == {"ROOT": "https://example.com/api/v1/posts", "POSTS_URL": "https://example.com/api/v1/posts"}
