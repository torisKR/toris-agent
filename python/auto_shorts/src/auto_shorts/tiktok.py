from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import secrets
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/"
TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
TIKTOK_UPLOAD_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/"
TIKTOK_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"

DEFAULT_SCOPES = ("user.info.basic", "video.upload")
DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
MIN_CHUNK_SIZE = 5 * 1024 * 1024
MAX_CHUNK_SIZE = 64 * 1024 * 1024


class TikTokError(RuntimeError):
    pass


@dataclass(frozen=True)
class TikTokToken:
    access_token: str
    refresh_token: str
    open_id: str
    scope: str
    expires_in: int
    refresh_expires_in: int
    token_type: str = "Bearer"

    @classmethod
    def from_dict(cls, value: dict) -> "TikTokToken":
        error = value.get("error")
        if error:
            description = str(value.get("error_description", error))
            raise TikTokError(f"TikTok token request failed: {description}")
        required = ("access_token", "refresh_token", "open_id", "scope")
        missing = [key for key in required if not value.get(key)]
        if missing:
            raise TikTokError(f"TikTok token response missing: {', '.join(missing)}")
        return cls(
            access_token=str(value["access_token"]),
            refresh_token=str(value["refresh_token"]),
            open_id=str(value["open_id"]),
            scope=str(value["scope"]),
            expires_in=int(value.get("expires_in", 0)),
            refresh_expires_in=int(value.get("refresh_expires_in", 0)),
            token_type=str(value.get("token_type", "Bearer")),
        )

    def public_dict(self) -> dict[str, int | str]:
        return {
            "open_id": self.open_id,
            "scope": self.scope,
            "expires_in": self.expires_in,
            "refresh_expires_in": self.refresh_expires_in,
            "token_type": self.token_type,
        }


def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = hashlib.sha256(verifier.encode("ascii")).hexdigest()
    return verifier, challenge


def _json_body(response) -> dict:
    try:
        value = json.loads(response.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TikTokError("TikTok returned an invalid JSON response") from exc
    if not isinstance(value, dict):
        raise TikTokError("TikTok returned a non-object response")
    return value


def _request_error(operation: str, exc: HTTPError | URLError) -> TikTokError:
    if isinstance(exc, HTTPError):
        try:
            body = json.loads(exc.read().decode("utf-8"))
            detail = body.get("error_description") or body.get("message") or body.get("error")
            if detail:
                return TikTokError(f"{operation} failed: {detail}")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
        return TikTokError(f"{operation} failed with HTTP {exc.code}")
    return TikTokError(f"{operation} failed: network error")


class TikTokClient:
    def __init__(self, client_key: str, client_secret: str = "", *, timeout: float = 60.0):
        if not client_key:
            raise TikTokError("TIKTOK_CLIENT_KEY is required")
        self.client_key = client_key
        self.client_secret = client_secret
        self.timeout = timeout

    def authorization_url(
        self,
        redirect_uri: str,
        *,
        scopes: tuple[str, ...] = DEFAULT_SCOPES,
        state: str | None = None,
        code_verifier: str | None = None,
    ) -> str:
        if not redirect_uri:
            raise TikTokError("TIKTOK_REDIRECT_URI is required")
        if not scopes:
            raise TikTokError("at least one TikTok scope is required")
        params: dict[str, str] = {
            "client_key": self.client_key,
            "scope": ",".join(scopes),
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "state": state or secrets.token_urlsafe(24),
        }
        if code_verifier:
            if not 43 <= len(code_verifier) <= 128:
                raise TikTokError("TikTok PKCE code_verifier must be 43 to 128 characters")
            params["code_challenge"] = hashlib.sha256(code_verifier.encode("ascii")).hexdigest()
            params["code_challenge_method"] = "S256"
        return f"{TIKTOK_AUTHORIZE_URL}?{urlencode(params)}"

    def exchange_code(self, code: str, redirect_uri: str, *, code_verifier: str | None = None) -> TikTokToken:
        if not code:
            raise TikTokError("TikTok authorization code is required")
        if not redirect_uri:
            raise TikTokError("TIKTOK_REDIRECT_URI is required")
        fields = {
            "client_key": self.client_key,
            "client_secret": self.client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
        if code_verifier:
            fields["code_verifier"] = code_verifier
        return self._token_request(fields)

    def refresh_token(self, refresh_token: str) -> TikTokToken:
        if not refresh_token:
            raise TikTokError("TikTok refresh token is required")
        return self._token_request(
            {
                "client_key": self.client_key,
                "client_secret": self.client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            }
        )

    def _token_request(self, fields: dict[str, str]) -> TikTokToken:
        if not self.client_secret:
            raise TikTokError("TIKTOK_CLIENT_SECRET is required")
        request = Request(
            TIKTOK_TOKEN_URL,
            data=urlencode(fields).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return TikTokToken.from_dict(_json_body(response))
        except (HTTPError, URLError) as exc:
            raise _request_error("TikTok token request", exc) from exc

    def upload_video_to_draft(
        self,
        video: Path,
        access_token: str,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        confirm: bool = False,
    ) -> str:
        if not confirm:
            raise TikTokError("TikTok upload is blocked; pass --confirm-upload explicitly")
        if not access_token:
            raise TikTokError("TIKTOK_ACCESS_TOKEN is required")
        if not video.is_file():
            raise TikTokError(f"video not found: {video}")
        if video.suffix.lower() != ".mp4":
            raise TikTokError("TikTok upload requires an MP4 file")
        size = video.stat().st_size
        if size <= 0:
            raise TikTokError("TikTok upload video must not be empty")
        if chunk_size <= 0:
            raise TikTokError("TikTok chunk_size must be positive")
        if size >= MIN_CHUNK_SIZE and not MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE:
            raise TikTokError("TikTok chunk_size must be between 5 MiB and 64 MiB")
        effective_chunk_size = size if size < MIN_CHUNK_SIZE else chunk_size
        total_chunk_count = math.ceil(size / effective_chunk_size)
        init_payload = {
            "source_info": {
                "source": "FILE_UPLOAD",
                "video_size": size,
                "chunk_size": effective_chunk_size,
                "total_chunk_count": total_chunk_count,
            }
        }
        init_response = self._json_api_request(
            TIKTOK_UPLOAD_INIT_URL,
            access_token,
            init_payload,
            "TikTok upload initialization",
        )
        data = init_response.get("data") or {}
        publish_id = data.get("publish_id")
        upload_url = data.get("upload_url")
        if not publish_id or not upload_url:
            raise TikTokError("TikTok upload initialization response missing publish_id or upload_url")

        with video.open("rb") as stream:
            for chunk_index in range(total_chunk_count):
                chunk = stream.read(effective_chunk_size)
                first_byte = chunk_index * effective_chunk_size
                last_byte = first_byte + len(chunk) - 1
                request = Request(
                    str(upload_url),
                    data=chunk,
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Length": str(len(chunk)),
                        "Content-Range": f"bytes {first_byte}-{last_byte}/{size}",
                    },
                    method="PUT",
                )
                try:
                    with urlopen(request, timeout=self.timeout) as response:
                        response.read()
                except (HTTPError, URLError) as exc:
                    raise _request_error("TikTok video upload", exc) from exc
        return str(publish_id)

    def fetch_status(self, publish_id: str, access_token: str) -> dict:
        if not publish_id:
            raise TikTokError("TikTok publish_id is required")
        if not access_token:
            raise TikTokError("TIKTOK_ACCESS_TOKEN is required")
        return self._json_api_request(TIKTOK_STATUS_URL, access_token, {"publish_id": publish_id}, "TikTok status request")

    def _json_api_request(self, url: str, access_token: str, payload: dict, operation: str) -> dict:
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json; charset=UTF-8"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                value = _json_body(response)
        except (HTTPError, URLError) as exc:
            raise _request_error(operation, exc) from exc
        error = value.get("error") or {}
        if isinstance(error, dict) and error.get("code") not in (None, "ok"):
            raise TikTokError(f"{operation} failed: {error.get('message') or error.get('code')}")
        return value
