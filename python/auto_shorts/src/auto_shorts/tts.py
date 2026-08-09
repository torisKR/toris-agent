from __future__ import annotations

import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request


class TtsError(RuntimeError):
    pass


class ElevenLabsTTS:
    """ElevenLabs TTS의 얇은 클라이언트. 캐시 적중 시 네트워크를 호출하지 않는다."""

    def __init__(self, api_key: str, cache_dir: Path = Path(".cache/tts"), model_id: str = "eleven_multilingual_v2"):
        if not api_key:
            raise TtsError("ELEVENLABS_API_KEY is required")
        self.api_key = api_key
        self.cache_dir = cache_dir
        self.model_id = model_id

    def synthesize(self, text: str, voice_id: str, output: Path, *, speed: float = 1.0) -> Path:
        if not text.strip() or not voice_id:
            raise TtsError("text and voice_id are required")
        key = hashlib.sha256(
            json.dumps({"text": text, "voice_id": voice_id, "model_id": self.model_id, "speed": speed}, sort_keys=True).encode()
        ).hexdigest()
        cached = self.cache_dir / f"{key}.mp3"
        output.parent.mkdir(parents=True, exist_ok=True)
        if cached.exists():
            output.write_bytes(cached.read_bytes())
            return output

        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        payload = json.dumps({"text": text, "model_id": self.model_id, "voice_settings": {"speed": speed}}).encode()
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"xi-api-key": self.api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                audio = response.read()
        except urllib.error.URLError as exc:
            raise TtsError(f"ElevenLabs request failed: {exc}") from exc
        if not audio:
            raise TtsError("ElevenLabs returned an empty audio response")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(audio)
        output.write_bytes(audio)
        return output


class FishAudioTTS:
    def __init__(
        self,
        api_key: str,
        cache_dir: Path = Path(".cache/tts"),
        model_id: str = "s2.1-pro-free",
        reference_id: str | None = None,
    ):
        if not api_key:
            raise TtsError("FISHAUDIO_API_KEY is required")
        self.api_key = api_key
        self.cache_dir = cache_dir
        self.model_id = model_id
        self.reference_id = reference_id

    def synthesize(self, text: str, output: Path, *, speed: float = 1.0) -> Path:
        if not text.strip():
            raise TtsError("text is required")
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "provider": "fish-audio",
                    "text": text,
                    "model_id": self.model_id,
                    "reference_id": self.reference_id,
                    "speed": speed,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        cached = self.cache_dir / f"{cache_key}.mp3"
        output.parent.mkdir(parents=True, exist_ok=True)
        if cached.exists():
            output.write_bytes(cached.read_bytes())
            return output

        body = {
            "text": text,
            "temperature": 0.7,
            "top_p": 0.7,
            "prosody": {"speed": speed, "volume": 0, "normalize_loudness": True},
            "normalize": True,
            "format": "mp3",
            "sample_rate": 44100,
            "mp3_bitrate": 128,
            "latency": "normal",
        }
        if self.reference_id:
            body["reference_id"] = self.reference_id
        request = urllib.request.Request(
            "https://api.fish.audio/v1/tts",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
                "model": self.model_id,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                audio = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise TtsError(f"Fish Audio request failed ({exc.code}): {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise TtsError(f"Fish Audio request failed: {exc}") from exc
        if not audio:
            raise TtsError("Fish Audio returned an empty audio response")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(audio)
        output.write_bytes(audio)
        return output
