from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
import json


@dataclass(frozen=True)
class Segment:
    """완성 영상의 한 구간.

    source는 원본 클립의 경로이고 start/end는 초 단위입니다.
    narration과 sticker는 선택값이며, 없으면 각각 무음/미사용으로 렌더링됩니다.
    """

    text: str
    source: str
    start: float = 0.0
    end: float | None = None
    narration: str | None = None
    sticker: str | None = None

    @property
    def requested_duration(self) -> float | None:
        if self.end is None:
            return None
        duration = self.end - self.start
        if duration <= 0:
            raise ValueError(f"segment end must be greater than start: {self.start}, {self.end}")
        return duration


@dataclass(frozen=True)
class ReelPlan:
    title: str
    description: str = ""
    segments: tuple[Segment, ...] = field(default_factory=tuple)
    width: int = 1080
    height: int = 1920
    fps: int = 30
    target_duration: float | None = None
    voiceover: str | None = None
    bgm: str | None = None
    output: str = "output/reel.mp4"

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ReelPlan":
        raw_segments = value.get("segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            raise ValueError("plan.segments must be a non-empty list")

        segments: list[Segment] = []
        for index, raw in enumerate(raw_segments):
            if not isinstance(raw, dict):
                raise ValueError(f"segments[{index}] must be an object")
            try:
                segments.append(Segment(**raw))
            except TypeError as exc:
                raise ValueError(f"invalid segments[{index}]: {exc}") from exc

        plan = cls(
            title=str(value.get("title", "")),
            description=str(value.get("description", "")),
            segments=tuple(segments),
            width=int(value.get("width", 1080)),
            height=int(value.get("height", 1920)),
            fps=int(value.get("fps", 30)),
            target_duration=(float(value["target_duration"]) if value.get("target_duration") is not None else None),
            voiceover=value.get("voiceover"),
            bgm=value.get("bgm"),
            output=str(value.get("output", "output/reel.mp4")),
        )
        plan.validate()
        return plan

    @classmethod
    def from_json(cls, path: Path) -> "ReelPlan":
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid plan JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise ValueError("plan JSON must contain an object")
        return cls.from_dict(value)

    def validate(self) -> None:
        if not self.title.strip():
            raise ValueError("plan.title must not be empty")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("plan dimensions must be positive")
        if self.fps <= 0:
            raise ValueError("plan.fps must be positive")
        if self.target_duration is not None and not 15 <= self.target_duration <= 60:
            raise ValueError("plan.target_duration must be between 15 and 60 seconds")
        for index, segment in enumerate(self.segments):
            if not segment.text.strip():
                raise ValueError(f"segments[{index}].text must not be empty")
            if not segment.source.strip():
                raise ValueError(f"segments[{index}].source must not be empty")
            if segment.start < 0:
                raise ValueError(f"segments[{index}].start must not be negative")
            segment.requested_duration

    def resolve_paths(self, base_dir: Path) -> "ReelPlan":
        def resolve(value: str | None) -> str | None:
            if value is None:
                return None
            path = Path(value)
            return str(path if path.is_absolute() else (base_dir / path).resolve())

        return ReelPlan(
            title=self.title,
            description=self.description,
            segments=tuple(
                Segment(
                    text=segment.text,
                    source=resolve(segment.source) or segment.source,
                    start=segment.start,
                    end=segment.end,
                    narration=resolve(segment.narration),
                    sticker=resolve(segment.sticker),
                )
                for segment in self.segments
            ),
            width=self.width,
            height=self.height,
            fps=self.fps,
            target_duration=self.target_duration,
            voiceover=resolve(self.voiceover),
            bgm=resolve(self.bgm),
            output=self.output,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self) | {"segments": [asdict(segment) for segment in self.segments]}
