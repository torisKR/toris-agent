from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Mapping
import urllib.error
import urllib.request


class PublishError(RuntimeError):
    pass


@dataclass(frozen=True)
class PublishMetadata:
    title: str
    description: str
    video: str
    platforms: tuple[str, ...]


@dataclass(frozen=True)
class Draft:
    status: str
    created_at: str
    metadata: PublishMetadata

    def to_dict(self) -> dict:
        return {"status": self.status, "created_at": self.created_at, "metadata": asdict(self.metadata) | {"platforms": list(self.metadata.platforms)}}


def resolve_zernio_credentials(platforms: tuple[str, ...], environ: Mapping[str, str]) -> tuple[str, str]:
    normalized = {platform.lower() for platform in platforms}
    youtube_instagram = normalized & {"youtube", "instagram"}
    threads_x = normalized & {"threads", "x", "twitter"}
    if youtube_instagram and threads_x:
        raise PublishError("one Zernio post cannot mix YOUTUBE_INSTAGRAM and THREADS_X account profiles")
    if threads_x:
        endpoint = environ.get("ZERNIO_THREADS_X_POSTS_URL") or environ.get("ZERNIO_REELS_URL", "")
        token = environ.get("ZERNIO_THREADS_X_API_TOKEN", "")
        return endpoint, token
    endpoint = environ.get("ZERNIO_YOUTUBE_INSTAGRAM_POSTS_URL") or environ.get("ZERNIO_REELS_URL", "")
    token = environ.get("ZERNIO_YOUTUBE_INSTAGRAM_API_TOKEN") or environ.get("ZERNIO_API_TOKEN", "")
    return endpoint, token


def create_draft(metadata: PublishMetadata, output: Path) -> Path:
    """사람 검토용 발행 초안을 만든다. 이 함수는 외부 API를 호출하지 않는다."""
    if not Path(metadata.video).exists():
        raise PublishError(f"video not found: {metadata.video}")
    output.parent.mkdir(parents=True, exist_ok=True)
    draft = Draft(status="awaiting_review", created_at=datetime.now(timezone.utc).isoformat(), metadata=metadata)
    output.write_text(json.dumps(draft.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def publish_zernio(draft: Draft, *, endpoint: str, token: str, confirm: bool) -> dict:
    """Zernio/중개 API 발행 어댑터. 명시적인 confirm 없이는 절대 요청하지 않는다."""
    if not confirm:
        raise PublishError("public publishing is blocked; pass --confirm-publish explicitly")
    if not endpoint or not token:
        raise PublishError("the selected Zernio profile requires a posts URL and API token")
    payload = json.dumps(asdict(draft.metadata)).encode()
    request = urllib.request.Request(endpoint, data=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise PublishError(f"publisher request failed: {exc}") from exc
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}


def load_draft(path: Path) -> Draft:
    value = json.loads(path.read_text(encoding="utf-8"))
    metadata = value["metadata"]
    return Draft(
        status=str(value["status"]),
        created_at=str(value["created_at"]),
        metadata=PublishMetadata(
            title=str(metadata["title"]),
            description=str(metadata.get("description", "")),
            video=str(metadata["video"]),
            platforms=tuple(metadata.get("platforms", [])),
        ),
    )
