import json
from pathlib import Path

import pytest

from auto_shorts.models import ReelPlan


def test_plan_loads_and_resolves_relative_paths(tmp_path: Path):
    source = tmp_path / "clip.mp4"
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({"title": "테스트", "segments": [{"text": "장면", "source": "clip.mp4", "end": 1.5}]}), encoding="utf-8")

    plan = ReelPlan.from_json(plan_file).resolve_paths(plan_file.parent)

    assert plan.segments[0].source == str(source.resolve())
    assert plan.segments[0].requested_duration == 1.5


def test_plan_rejects_invalid_segment_duration():
    with pytest.raises(ValueError, match="greater than start"):
        ReelPlan.from_dict({"title": "테스트", "segments": [{"text": "장면", "source": "clip.mp4", "start": 2, "end": 1}]})


def test_plan_requires_segments():
    with pytest.raises(ValueError, match="non-empty list"):
        ReelPlan.from_dict({"title": "테스트", "segments": []})


def test_plan_requires_short_form_target_duration_range():
    with pytest.raises(ValueError, match="between 15 and 60"):
        ReelPlan.from_dict(
            {"title": "테스트", "target_duration": 14, "segments": [{"text": "장면", "source": "clip.mp4"}]}
        )


def test_plan_accepts_fifty_second_target_duration():
    plan = ReelPlan.from_dict(
        {"title": "긴 카드뉴스", "target_duration": 50, "segments": [{"text": "카드", "source": "card.png"}]}
    )

    assert plan.target_duration == 50


def test_plan_loads_voiceover_path():
    plan = ReelPlan.from_dict(
        {"title": "음성", "voiceover": "voice.mp3", "segments": [{"text": "장면", "source": "clip.mp4"}]}
    )

    assert plan.voiceover == "voice.mp3"
