from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
import mimetypes
import os
from pathlib import Path
import time
from typing import Any, Mapping
import urllib.error
import urllib.request
import uuid

from .publish import PublishError, resolve_zernio_credentials


CHANNELS = ("youtube_short", "youtube", "instagram", "threads", "x")

_CHANNEL_PLATFORM = {
    "youtube_short": "youtube",
    "youtube": "youtube",
    "instagram": "instagram",
    "threads": "threads",
    "x": "twitter",
}

_CHANNEL_PROFILE = {
    "youtube_short": "YOUTUBE_INSTAGRAM",
    "youtube": "YOUTUBE_INSTAGRAM",
    "instagram": "YOUTUBE_INSTAGRAM",
    "threads": "THREADS_X",
    "x": "THREADS_X",
}

_ACCOUNT_ENV = {
    "youtube_short": "ZERNIO_YOUTUBE_ACCOUNT_ID",
    "youtube": "ZERNIO_YOUTUBE_ACCOUNT_ID",
    "instagram": "ZERNIO_INSTAGRAM_ACCOUNT_ID",
    "threads": "ZERNIO_THREADS_ACCOUNT_ID",
    "x": "ZERNIO_X_ACCOUNT_ID",
}

_STRATEGIES = {
    "youtube_short": {
        "agent": "YouTube Shorts Agent",
        "format": "9:16 video up to 3 minutes",
        "focus": "first-second hook, one takeaway, next-video CTA",
    },
    "youtube": {
        "agent": "YouTube Lecture Agent",
        "format": "long-form educational video",
        "focus": "searchable title, thumbnail, chapters, retention",
    },
    "instagram": {
        "agent": "Instagram Reels Agent",
        "format": "9:16 Reel or visual feed post",
        "focus": "visual proof, save value, profile visit",
    },
    "threads": {
        "agent": "Threads Conversation Agent",
        "format": "original text or connected thread",
        "focus": "experience-led opinion, replies, topic community",
    },
    "x": {
        "agent": "X Real-time Agent",
        "format": "concise post or thread with optional media",
        "focus": "timely point, direct language, one clear action",
    },
}


@dataclass(frozen=True)
class MediaSpec:
    path: str
    type: str
    thumbnail: str | None = None


@dataclass(frozen=True)
class SocialBrief:
    headline: str
    hook: str
    body: str
    cta: str
    key_points: tuple[str, ...] = field(default_factory=tuple)
    keywords: tuple[str, ...] = field(default_factory=tuple)
    url: str = ""
    topic_tag: str = ""
    conversation_question: str = ""
    chapters: tuple[str, ...] = field(default_factory=tuple)
    contains_synthetic_media: bool = False
    channels: tuple[str, ...] = CHANNELS
    media: Mapping[str, MediaSpec] = field(default_factory=dict)

    @classmethod
    def from_json(cls, path: Path) -> "SocialBrief":
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PublishError(f"invalid social brief JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise PublishError("social brief must be a JSON object")

        raw_media = value.get("media", {})
        if not isinstance(raw_media, dict):
            raise PublishError("social brief media must be an object")
        media: dict[str, MediaSpec] = {}
        for channel, raw in raw_media.items():
            if not isinstance(raw, dict):
                raise PublishError(f"media.{channel} must be an object")
            media[channel] = MediaSpec(
                path=str(raw.get("path", "")),
                type=str(raw.get("type", "")),
                thumbnail=(str(raw["thumbnail"]) if raw.get("thumbnail") else None),
            )

        brief = cls(
            headline=str(value.get("headline", "")),
            hook=str(value.get("hook", "")),
            body=str(value.get("body", "")),
            cta=str(value.get("cta", "")),
            key_points=tuple(str(item) for item in value.get("key_points", [])),
            keywords=tuple(str(item) for item in value.get("keywords", [])),
            url=str(value.get("url", "")),
            topic_tag=str(value.get("topic_tag", "")),
            conversation_question=str(value.get("conversation_question", "")),
            chapters=tuple(str(item) for item in value.get("chapters", [])),
            contains_synthetic_media=bool(value.get("contains_synthetic_media", False)),
            channels=tuple(str(item) for item in value.get("channels", CHANNELS)),
            media=media,
        )
        return brief.resolve_paths(path.parent)

    def resolve_paths(self, base_dir: Path) -> "SocialBrief":
        resolved: dict[str, MediaSpec] = {}
        for channel, media in self.media.items():
            path = Path(media.path)
            thumbnail = Path(media.thumbnail) if media.thumbnail else None
            resolved[channel] = MediaSpec(
                path=str(path if path.is_absolute() else (base_dir / path).resolve()),
                type=media.type,
                thumbnail=(str(thumbnail if thumbnail.is_absolute() else (base_dir / thumbnail).resolve()) if thumbnail else None),
            )
        return SocialBrief(
            headline=self.headline,
            hook=self.hook,
            body=self.body,
            cta=self.cta,
            key_points=self.key_points,
            keywords=self.keywords,
            url=self.url,
            topic_tag=self.topic_tag,
            conversation_question=self.conversation_question,
            chapters=self.chapters,
            contains_synthetic_media=self.contains_synthetic_media,
            channels=self.channels,
            media=resolved,
        )

    def validate(self) -> None:
        for name in ("headline", "hook", "body", "cta"):
            if not getattr(self, name).strip():
                raise PublishError(f"social brief {name} must not be empty")
        invalid = [channel for channel in self.channels if channel not in CHANNELS]
        if invalid:
            raise PublishError(f"unsupported social channels: {', '.join(invalid)}")
        if len(set(self.channels)) != len(self.channels):
            raise PublishError("social brief channels must not contain duplicates")

        for channel in self.channels:
            media = self.media.get(channel)
            if channel in {"youtube", "youtube_short", "instagram"} and media is None:
                raise PublishError(f"{channel} requires media")
            if media is None:
                continue
            if media.type not in {"video", "image"}:
                raise PublishError(f"media.{channel}.type must be video or image")
            if channel in {"youtube", "youtube_short"} and media.type != "video":
                raise PublishError(f"{channel} requires video media")
            if not Path(media.path).is_file():
                raise PublishError(f"media file not found for {channel}: {media.path}")
            if media.thumbnail and not Path(media.thumbnail).is_file():
                raise PublishError(f"thumbnail not found for {channel}: {media.thumbnail}")
            if channel == "youtube_short" and media.thumbnail:
                raise PublishError("YouTube Shorts custom thumbnails are not supported through the API")
        if self.topic_tag and (len(self.topic_tag) > 50 or "." in self.topic_tag or "&" in self.topic_tag):
            raise PublishError("Threads topic_tag must be 1-50 characters without '.' or '&'")


@dataclass(frozen=True)
class SocialDraft:
    channel: str
    platform: str
    profile: str
    account_id: str
    content: str
    title: str | None
    media: MediaSpec | None
    platform_specific_data: Mapping[str, Any]
    strategy: Mapping[str, str]
    status: str = "awaiting_review"

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SocialDraft":
        raw_media = value.get("media")
        media = MediaSpec(**raw_media) if isinstance(raw_media, dict) else None
        return cls(
            channel=str(value["channel"]),
            platform=str(value["platform"]),
            profile=str(value["profile"]),
            account_id=str(value["account_id"]),
            content=str(value["content"]),
            title=(str(value["title"]) if value.get("title") else None),
            media=media,
            platform_specific_data=dict(value.get("platform_specific_data", {})),
            strategy=dict(value.get("strategy", {})),
            status=str(value.get("status", "awaiting_review")),
        )


@dataclass(frozen=True)
class SocialPackage:
    status: str
    created_at: str
    source: str
    drafts: tuple[SocialDraft, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "created_at": self.created_at,
            "source": self.source,
            "drafts": [asdict(draft) for draft in self.drafts],
        }


def load_env_file(path: Path, environ: dict[str, str] | None = None) -> None:
    if not path.is_file():
        return
    target = os.environ if environ is None else environ
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        parsed = value.strip().strip("'\"")
        if parsed.startswith("${") and parsed.endswith("}"):
            parsed = target.get(parsed[2:-1], "")
        target.setdefault(key.strip(), parsed)


def _hashtags(keywords: tuple[str, ...], limit: int = 5) -> str:
    tags: list[str] = []
    for keyword in keywords:
        normalized = "".join(char for char in keyword if char.isalnum() or char == "_")
        if normalized and normalized.lower() not in {tag.lower() for tag in tags}:
            tags.append(normalized)
        if len(tags) == limit:
            break
    return " ".join(f"#{tag}" for tag in tags)


def _youtube_tags(keywords: tuple[str, ...]) -> list[str]:
    tags: list[str] = []
    total = 0
    for keyword in keywords:
        tag = keyword.strip()[:100]
        if not tag or tag.lower() in {item.lower() for item in tags}:
            continue
        added = len(tag) + (1 if tags else 0)
        if total + added > 500:
            break
        tags.append(tag)
        total += added
    return tags


def _split_posts(parts: list[str], limit: int) -> list[str]:
    posts: list[str] = []
    current = ""
    for raw in parts:
        part = raw.strip()
        if not part:
            continue
        while len(part) > limit:
            split_at = part.rfind(" ", 0, limit + 1)
            if split_at < limit // 2:
                split_at = limit
            head, part = part[:split_at].strip(), part[split_at:].strip()
            if current:
                posts.append(current)
                current = ""
            posts.append(head)
        candidate = f"{current}\n\n{part}" if current else part
        if len(candidate) <= limit:
            current = candidate
        else:
            posts.append(current)
            current = part
    if current:
        posts.append(current)
    return posts


def _account_id(channel: str, environ: Mapping[str, str]) -> str:
    key = _ACCOUNT_ENV[channel]
    value = environ.get(key, "").strip()
    if not value:
        raise PublishError(f"{key} is required for {channel}")
    return value


def _base_draft(channel: str, brief: SocialBrief, environ: Mapping[str, str], *, content: str, title: str | None = None, platform_data: Mapping[str, Any] | None = None) -> SocialDraft:
    return SocialDraft(
        channel=channel,
        platform=_CHANNEL_PLATFORM[channel],
        profile=_CHANNEL_PROFILE[channel],
        account_id=_account_id(channel, environ),
        content=content,
        title=title,
        media=brief.media.get(channel),
        platform_specific_data=dict(platform_data or {}),
        strategy=_STRATEGIES[channel],
    )


def _youtube_draft(brief: SocialBrief, environ: Mapping[str, str], *, short: bool) -> SocialDraft:
    channel = "youtube_short" if short else "youtube"
    title = (brief.hook if short else brief.headline).strip()[:100]
    if short:
        parts = [brief.hook, brief.body[:500], brief.cta, brief.url, _hashtags(brief.keywords, 3)]
    else:
        points = "\n".join(f"- {point}" for point in brief.key_points)
        chapters = "\n".join(brief.chapters)
        parts = [brief.hook, brief.body, points, chapters, brief.cta, brief.url, _hashtags(brief.keywords, 3)]
    content = "\n\n".join(part for part in parts if part).strip()[:5000]
    platform_data = {
        "title": title,
        "visibility": "public",
        "madeForKids": False,
        "categoryId": "27",
        "containsSyntheticMedia": brief.contains_synthetic_media,
        "tags": _youtube_tags(brief.keywords),
    }
    return _base_draft(channel, brief, environ, content=content, title=title, platform_data=platform_data)


def _instagram_draft(brief: SocialBrief, environ: Mapping[str, str]) -> SocialDraft:
    points = "\n".join(f"• {point}" for point in brief.key_points[:3])
    content = "\n\n".join(part for part in [brief.hook, brief.body[:1200], points, brief.cta, _hashtags(brief.keywords)] if part).strip()
    return _base_draft("instagram", brief, environ, content=content[:2200], platform_data={"shareToFeed": True})


def _threads_draft(brief: SocialBrief, environ: Mapping[str, str]) -> SocialDraft:
    ending = brief.conversation_question or brief.cta
    posts = _split_posts([brief.hook, brief.body, *brief.key_points, ending], 500)
    data: dict[str, Any] = {}
    if brief.topic_tag:
        data["topic_tag"] = brief.topic_tag
    if len(posts) > 1:
        data["threadItems"] = [{"content": post} for post in posts]
    return _base_draft("threads", brief, environ, content=posts[0], platform_data=data)


def _x_draft(brief: SocialBrief, environ: Mapping[str, str]) -> SocialDraft:
    ending = brief.conversation_question or brief.cta
    posts = _split_posts([brief.hook, brief.body, *brief.key_points, ending, brief.url], 280)
    data: dict[str, Any] = {}
    if len(posts) > 1:
        data["threadItems"] = [{"content": post} for post in posts]
    return _base_draft("x", brief, environ, content=posts[0], platform_data=data)


def create_social_package(brief: SocialBrief, output: Path, *, source: str, environ: Mapping[str, str]) -> Path:
    brief.validate()
    builders = {
        "youtube_short": lambda: _youtube_draft(brief, environ, short=True),
        "youtube": lambda: _youtube_draft(brief, environ, short=False),
        "instagram": lambda: _instagram_draft(brief, environ),
        "threads": lambda: _threads_draft(brief, environ),
        "x": lambda: _x_draft(brief, environ),
    }
    package = SocialPackage(
        status="awaiting_review",
        created_at=datetime.now(timezone.utc).isoformat(),
        source=source,
        drafts=tuple(builders[channel]() for channel in brief.channels),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(package.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def load_social_package(path: Path) -> SocialPackage:
    value = json.loads(path.read_text(encoding="utf-8"))
    return SocialPackage(
        status=str(value["status"]),
        created_at=str(value["created_at"]),
        source=str(value.get("source", "")),
        drafts=tuple(SocialDraft.from_dict(item) for item in value.get("drafts", [])),
    )


class ZernioClient:
    def __init__(self, token: str, api_root: str = "https://zernio.com/api/v1"):
        self.token = token
        self.api_root = api_root.rstrip("/")

    def request_json(self, method: str, path: str, payload: Mapping[str, Any] | None = None, *, request_id: str | None = None, timeout: int = 600) -> dict[str, Any]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        if request_id:
            headers["x-request-id"] = request_id
        request = urllib.request.Request(f"{self.api_root}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise PublishError(f"Zernio HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise PublishError(f"Zernio request failed: {exc}") from exc
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise PublishError("Zernio returned a non-JSON response") from exc

    def account_health(self, account_id: str) -> dict[str, Any]:
        response = self.request_json("GET", "/accounts/health", timeout=60)

        def find(value: Any) -> dict[str, Any] | None:
            if isinstance(value, dict):
                ids = {str(value.get(key, "")) for key in ("_id", "id", "accountId")}
                if account_id in ids:
                    return value
                for child in value.values():
                    match = find(child)
                    if match is not None:
                        return match
            elif isinstance(value, list):
                for child in value:
                    match = find(child)
                    if match is not None:
                        return match
            return None

        health = find(response)
        if health is None:
            raise PublishError(f"connected account not found in Zernio health response: {account_id}")
        capabilities = health.get("capabilities", {})
        can_post = health.get("canPost")
        if can_post is None and isinstance(capabilities, dict):
            can_post = capabilities.get("canPost")
        if can_post is False:
            raise PublishError(f"Zernio account cannot post: {account_id}")
        return health

    def upload(self, path: Path, media_type: str) -> str:
        content_type = mimetypes.guess_type(path.name)[0]
        if not content_type:
            content_type = "video/mp4" if media_type == "video" else "image/jpeg"
        response = self.request_json(
            "POST",
            "/media/presign",
            {"filename": path.name, "contentType": content_type, "size": path.stat().st_size},
            timeout=60,
        )
        value = response.get("data", response)
        request = urllib.request.Request(
            str(value["uploadUrl"]),
            data=path.read_bytes(),
            headers={"Content-Type": content_type},
            method="PUT",
        )
        try:
            with urllib.request.urlopen(request, timeout=1800):
                pass
        except urllib.error.URLError as exc:
            raise PublishError(f"Zernio media upload failed: {exc}") from exc
        return str(value["publicUrl"])

    def create_post(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self.request_json("POST", "/posts", payload, request_id=str(uuid.uuid4()))

    def get_post(self, post_id: str) -> dict[str, Any]:
        return self.request_json("GET", f"/posts/{post_id}", timeout=60)


def _post_value(response: Mapping[str, Any]) -> dict[str, Any]:
    value = response.get("data", response)
    if not isinstance(value, dict):
        return {}
    post = value.get("post", value)
    return post if isinstance(post, dict) else {}


def _platform_state(post: Mapping[str, Any], platform: str) -> tuple[str, str]:
    for item in post.get("platforms", []):
        if isinstance(item, dict) and item.get("platform") == platform:
            status = str(item.get("status", "unknown"))
            url = str(item.get("platformPostUrl") or item.get("url") or "")
            return status, url
    return str(post.get("status", "unknown")), str(post.get("platformPostUrl") or "")


def _public_payload(draft: SocialDraft, client: ZernioClient, upload_cache: dict[str, str]) -> dict[str, Any]:
    media_items: list[dict[str, Any]] = []
    media_url = ""
    if draft.media:
        media_url = upload_cache.get(draft.media.path, "")
        if not media_url:
            media_url = client.upload(Path(draft.media.path), draft.media.type)
            upload_cache[draft.media.path] = media_url
        media_item: dict[str, Any] = {"type": draft.media.type, "url": media_url}
        if draft.media.thumbnail:
            thumbnail_url = upload_cache.get(draft.media.thumbnail, "")
            if not thumbnail_url:
                thumbnail_url = client.upload(Path(draft.media.thumbnail), "image")
                upload_cache[draft.media.thumbnail] = thumbnail_url
            media_item["thumbnail"] = thumbnail_url
        media_items.append(media_item)

    platform_data = json.loads(json.dumps(draft.platform_specific_data))
    thread_items = platform_data.get("threadItems")
    if media_url and isinstance(thread_items, list) and thread_items:
        first = thread_items[0]
        if isinstance(first, dict):
            first["mediaItems"] = [{"type": draft.media.type, "url": media_url}]
        media_items = []

    payload: dict[str, Any] = {
        "content": draft.content,
        "platforms": [
            {
                "platform": draft.platform,
                "accountId": draft.account_id,
                "platformSpecificData": platform_data,
            }
        ],
        "publishNow": True,
        "isDraft": False,
        "crosspostingEnabled": False,
    }
    if draft.title:
        payload["title"] = draft.title
    if media_items:
        payload["mediaItems"] = media_items
    return payload


def publish_social_package(
    package: SocialPackage,
    *,
    environ: Mapping[str, str],
    confirm: bool,
    channels: tuple[str, ...] = (),
    wait_seconds: int = 120,
    poll_interval: int = 5,
) -> dict[str, Any]:
    if not confirm:
        raise PublishError("public publishing is blocked; pass --confirm-publish explicitly")
    selected = set(channels or (draft.channel for draft in package.drafts))
    invalid = selected - set(CHANNELS)
    if invalid:
        raise PublishError(f"unsupported social channels: {', '.join(sorted(invalid))}")

    clients: dict[str, ZernioClient] = {}
    upload_caches: dict[str, dict[str, str]] = {}
    results: list[dict[str, Any]] = []
    for draft in package.drafts:
        if draft.channel not in selected:
            continue
        endpoint, token = resolve_zernio_credentials((draft.platform,), environ)
        if not endpoint or not token:
            raise PublishError(f"Zernio credentials are missing for {draft.profile}")
        api_root = endpoint.rstrip("/")
        if api_root.endswith("/posts"):
            api_root = api_root[:-6]
        client = clients.setdefault(draft.profile, ZernioClient(token, api_root))
        health = client.account_health(draft.account_id)
        payload = _public_payload(draft, client, upload_caches.setdefault(draft.profile, {}))
        response = client.create_post(payload)
        post = _post_value(response)
        post_id = str(post.get("_id") or post.get("id") or "")
        if not post_id:
            raise PublishError(f"Zernio did not return a post id for {draft.channel}")
        status, url = _platform_state(post, draft.platform)
        deadline = time.monotonic() + max(0, wait_seconds)
        while not url and status not in {"failed", "error"} and time.monotonic() < deadline:
            time.sleep(max(1, poll_interval))
            post = _post_value(client.get_post(post_id))
            status, url = _platform_state(post, draft.platform)
        results.append(
            {
                "channel": draft.channel,
                "agent": draft.strategy.get("agent", ""),
                "post_id": post_id,
                "status": status,
                "url": url,
                "account_status": str(health.get("status") or health.get("connectionStatus") or "healthy"),
            }
        )
    if not results:
        raise PublishError("no matching drafts selected for publishing")
    return {"status": "submitted", "published_at": datetime.now(timezone.utc).isoformat(), "results": results}
