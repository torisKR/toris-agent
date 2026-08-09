from pathlib import Path
import shutil
import subprocess

import pytest

from auto_shorts.media import MediaTools, probe_duration, quality_report, render_plan, validate_media
from auto_shorts.models import ReelPlan


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg/ffprobe not installed")
def test_render_plan_produces_vertical_mp4(tmp_path: Path):
    source = tmp_path / "source.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x172554:s=640x360:d=1.2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(source)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    plan = ReelPlan.from_dict({"title": "스모크", "segments": [{"text": "렌더 성공", "source": str(source), "start": 0, "end": 1.0}]})
    output = tmp_path / "reel.mp4"

    result = render_plan(plan, output, tools=MediaTools.discover())

    assert result.output == output
    assert output.exists()
    assert 0.8 <= probe_duration(output) <= 1.2
    assert validate_media(output)["video_codec"] == "h264"
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,codec_name", "-of", "json", str(output)], check=True, capture_output=True, text=True)
    assert '"width": 1080' in probe.stdout
    assert '"height": 1920' in probe.stdout
    assert '"codec_name": "h264"' in probe.stdout


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg/ffprobe not installed")
def test_render_plan_loops_short_source_to_target_duration(tmp_path: Path):
    source = tmp_path / "short-source.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x7f1d1d:s=640x360:d=0.8", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(source)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    plan = ReelPlan.from_dict(
        {
            "title": "15초 스모크",
            "target_duration": 15,
            "segments": [{"text": "짧은 원본 반복", "source": str(source)}],
        }
    )
    output = tmp_path / "target.mp4"

    result = render_plan(plan, output, tools=MediaTools.discover())

    assert result.duration == 15
    assert 14.7 <= probe_duration(output) <= 15.3
    report = quality_report(output)
    assert report['passed'] is True
    assert {rule['name'] for rule in report['rules']} == {'video_codec', 'audio_codec', 'resolution', 'duration', 'frame_rate'}
    assert all(rule['passed'] for rule in report['rules'])
