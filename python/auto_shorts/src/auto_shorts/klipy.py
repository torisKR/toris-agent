from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


class KlipyError(RuntimeError):
    pass


@dataclass(frozen=True)
class KlipyClip:
    id: str
    title: str
    slug: str
    mp4_url: str
    gif_url: str | None = None
    webp_url: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "KlipyClip":
        files = value.get("file")
        if not isinstance(files, dict) or not isinstance(files.get("mp4"), str) or not files["mp4"]:
            raise KlipyError("KLIPY clip does not contain an MP4 file")
        return cls(
            id=str(value.get("id", "")),
            title=str(value.get("title", "")),
            slug=str(value.get("slug", "")),
            mp4_url=files["mp4"],
            gif_url=files.get("gif") if isinstance(files.get("gif"), str) else None,
            webp_url=files.get("webp") if isinstance(files.get("webp"), str) else None,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "slug": self.slug,
            "mp4_available": bool(self.mp4_url),
            "gif_available": bool(self.gif_url),
            "webp_available": bool(self.webp_url),
        }


class KlipyClient:
    def __init__(self, api_key: str, *, base_url: str = "https://api.klipy.com/api/v1", timeout: float = 60.0):
        if not api_key:
            raise KlipyError("KLIPY_API_KEY is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def search_clips(self, query: str, *, page: int = 1, per_page: int = 5, customer_id: str = "auto_shorts") -> list[KlipyClip]:
        if not query.strip():
            raise KlipyError("KLIPY search query must not be empty")
        if page < 1 or not 1 <= per_page <= 50:
            raise KlipyError("KLIPY page must be positive and per_page must be between 1 and 50")

        encoded_key = urllib.parse.quote(self.api_key, safe="")
        params = urllib.parse.urlencode({"page": page, "per_page": per_page, "q": query, "customer_id": customer_id})
        url = f"{self.base_url}/{encoded_key}/clips/search?{params}"
        body = self._get_json(url)
        data = body.get("data")
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise KlipyError("KLIPY returned an invalid search response")
        clips: list[KlipyClip] = []
        for row in rows:
            if isinstance(row, dict):
                try:
                    clips.append(KlipyClip.from_dict(row))
                except KlipyError:
                    continue
        return clips

    def download_clip(self, clip: KlipyClip, output: Path) -> Path:
        request = urllib.request.Request(clip.mp4_url, headers={"User-Agent": "auto-shorts/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                content = response.read()
        except urllib.error.URLError as exc:
            raise KlipyError(f"KLIPY clip download failed: {exc.reason}") from exc
        if not content:
            raise KlipyError("KLIPY clip download returned an empty response")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        return output

    def _get_json(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "auto-shorts/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise KlipyError(f"KLIPY request failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            reason = getattr(exc, "reason", str(exc))
            raise KlipyError(f"KLIPY request failed: {reason}") from exc
        if not isinstance(body, dict) or body.get("result") is False:
            raise KlipyError("KLIPY request returned an error response")
        return body
