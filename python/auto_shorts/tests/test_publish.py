from pathlib import Path

import pytest

from auto_shorts.publish import PublishError, PublishMetadata, create_draft, load_draft, publish_zernio, resolve_zernio_credentials


def test_create_draft_is_awaiting_review(tmp_path: Path):
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"not a real video, just a draft fixture")
    draft_path = create_draft(PublishMetadata("제목", "설명", str(video), ("youtube",)), tmp_path / "draft.json")

    draft = load_draft(draft_path)
    assert draft.status == "awaiting_review"
    assert draft.metadata.title == "제목"


def test_publish_requires_explicit_confirmation(tmp_path: Path):
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"fixture")
    draft_path = create_draft(PublishMetadata("제목", "설명", str(video), ("instagram",)), tmp_path / "draft.json")
    draft = load_draft(draft_path)

    with pytest.raises(PublishError, match="confirm-publish"):
        publish_zernio(draft, endpoint="https://example.invalid", token="token", confirm=False)


def test_zernio_credentials_are_split_by_platform_profile():
    environ = {
        "ZERNIO_YOUTUBE_INSTAGRAM_API_TOKEN": "youtube-instagram-token",
        "ZERNIO_YOUTUBE_INSTAGRAM_POSTS_URL": "https://example.com/youtube-instagram",
        "ZERNIO_THREADS_X_API_TOKEN": "threads-x-token",
        "ZERNIO_THREADS_X_POSTS_URL": "https://example.com/threads-x",
    }

    assert resolve_zernio_credentials(("youtube", "instagram"), environ) == ("https://example.com/youtube-instagram", "youtube-instagram-token")
    assert resolve_zernio_credentials(("threads", "x"), environ) == ("https://example.com/threads-x", "threads-x-token")


def test_zernio_credentials_reject_mixed_account_profiles():
    with pytest.raises(PublishError, match="cannot mix"):
        resolve_zernio_credentials(("youtube", "threads"), {})
