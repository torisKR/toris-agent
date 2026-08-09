from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import shutil
import subprocess
from typing import Sequence

from .captions import render_caption_overlay
from .models import ReelPlan, Segment


class MediaError(RuntimeError):
    pass


@dataclass(frozen=True)
class MediaTools:
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"

    @classmethod
    def discover(cls) -> "MediaTools":
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            missing = ", ".join(name for name, value in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if not value)
            raise MediaError(f"required media tools not found: {missing}")
        return cls(ffmpeg=ffmpeg, ffprobe=ffprobe)


@dataclass(frozen=True)
class RenderResult:
    output: Path
    duration: float
    segment_count: int


def _frame_rate(value: object) -> float:
    try:
        numerator, denominator = str(value).split('/', 1)
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _inspect_media(path: Path, tools: MediaTools) -> dict[str, object]:
    result = run_command(
        [
            tools.ffprobe,
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration',
            '-of',
            'json',
            str(path),
        ]
    )
    try:
        value = json.loads(result.stdout)
        streams = value['streams']
        video = next(stream for stream in streams if stream.get('codec_type') == 'video')
        audio = next(stream for stream in streams if stream.get('codec_type') == 'audio')
        duration = float(value['format']['duration'])
    except (KeyError, StopIteration, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MediaError(f'invalid media probe result: {path}') from exc
    return {
        'path': str(path),
        'duration': duration,
        'width': int(video.get('width') or 0),
        'height': int(video.get('height') or 0),
        'video_codec': str(video.get('codec_name') or ''),
        'audio_codec': str(audio.get('codec_name') or ''),
        'frame_rate': _frame_rate(video.get('avg_frame_rate')),
    }


def quality_report(path: Path, *, tools: MediaTools | None = None, width: int = 1080, height: int = 1920, min_duration: float = 15, max_duration: float = 60) -> dict[str, object]:
    tools = tools or MediaTools.discover()
    metrics = _inspect_media(path, tools)
    rules = [
        {'name': 'video_codec', 'measured': metrics['video_codec'], 'expected': 'h264', 'passed': metrics['video_codec'] == 'h264'},
        {'name': 'audio_codec', 'measured': metrics['audio_codec'], 'expected': 'aac', 'passed': metrics['audio_codec'] == 'aac'},
        {'name': 'resolution', 'measured': f"{metrics['width']}x{metrics['height']}", 'expected': f'{width}x{height}', 'passed': metrics['width'] == width and metrics['height'] == height},
        {'name': 'duration', 'measured': metrics['duration'], 'expected': f'{min_duration}-{max_duration}s', 'passed': min_duration <= metrics['duration'] <= max_duration},
        {'name': 'frame_rate', 'measured': metrics['frame_rate'], 'expected': '>0', 'passed': metrics['frame_rate'] > 0},
    ]
    return {'path': str(path), 'passed': all(rule['passed'] for rule in rules), 'metrics': metrics, 'rules': rules}


def validate_media(path: Path, *, tools: MediaTools | None = None, width: int = 1080, height: int = 1920) -> dict[str, object]:
    tools = tools or MediaTools.discover()
    metrics = _inspect_media(path, tools)
    if metrics['video_codec'] != 'h264' or metrics['width'] != width or metrics['height'] != height:
        raise MediaError(f"video must be H.264 {width}x{height}: {path}")
    if metrics['audio_codec'] != 'aac':
        raise MediaError(f"audio must be AAC: {path}")
    if metrics['duration'] <= 0:
        raise MediaError(f"media duration must be positive: {path}")
    return metrics


def run_command(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        tail = result.stderr[-3000:]
        raise MediaError(f"command failed ({result.returncode}): {' '.join(command)}\n{tail}")
    return result


def probe_duration(path: Path, tools: MediaTools | None = None) -> float:
    tools = tools or MediaTools.discover()
    result = run_command(
        [tools.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]
    )
    try:
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MediaError(f"could not read media duration: {path}") from exc
    if duration <= 0:
        raise MediaError(f"media has no positive duration: {path}")
    return duration


def _segment_duration(segment: Segment, tools: MediaTools) -> float:
    requested = segment.requested_duration
    if requested is not None:
        return requested
    source_duration = probe_duration(Path(segment.source), tools)
    if segment.start >= source_duration:
        raise MediaError(f"segment starts after source duration: {segment.source}")
    return source_duration - segment.start


def _render_segment(
    segment: Segment,
    destination: Path,
    *,
    plan: ReelPlan,
    work_dir: Path,
    tools: MediaTools,
    duration: float,
) -> float:
    source = Path(segment.source)
    if not source.exists():
        raise MediaError(f"source clip not found: {source}")
    overlay = work_dir / f"caption-{len(list(work_dir.glob('caption-*.png'))):04d}.png"
    render_caption_overlay(segment.text, overlay, width=plan.width, height=plan.height, font_size=60)

    # 자막/스티커 입력은 모두 베이스 영상 길이로 제한한다. -t가 없으면 loop 입력이 렌더를 끝내지 못한다.
    filter_parts = [
        f"[0:v]scale={plan.width}:{plan.height}:force_original_aspect_ratio=increase,crop={plan.width}:{plan.height},fps={plan.fps},format=yuv420p[base]",
        "[2:v]format=rgba[caption]",
        "[base][caption]overlay=0:0:shortest=1[captioned]",
    ]
    inputs = [tools.ffmpeg, "-y", "-stream_loop", "-1", "-ss", str(segment.start), "-t", str(duration), "-i", str(source)]
    if segment.narration:
        narration = Path(segment.narration)
        if not narration.exists():
            raise MediaError(f"narration file not found: {narration}")
        inputs += ["-i", str(narration)]
        audio_index = 1
    else:
        inputs += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
        audio_index = 1
    inputs += ["-loop", "1", "-t", str(duration), "-i", str(overlay)]
    if segment.sticker:
        sticker = Path(segment.sticker)
        if not sticker.exists():
            raise MediaError(f"sticker file not found: {sticker}")
        inputs += ["-stream_loop", "-1", "-t", str(duration), "-i", str(sticker)]
        filter_parts += [
            "[3:v]scale=220:-1,format=rgba[sticker]",
            "[captioned][sticker]overlay=W-w-72:H-h-650:shortest=1[v]",
        ]
    else:
        filter_parts.append("[captioned]null[v]")
    filter_parts.append(f"[{audio_index}:a]aresample=44100,apad=pad_dur={duration},atrim=duration={duration},asetpts=N/SR/TB[a]")
    command = inputs + [
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        str(duration),
        "-r",
        str(plan.fps),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(destination),
    ]
    run_command(command)
    return duration


def _concat_segments(segment_files: list[Path], destination: Path, tools: MediaTools) -> None:
    list_file = destination.with_suffix(".txt")
    list_file.write_text(
        "\n".join(
            f"file '{path.resolve().as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'"
            for path in segment_files
        ),
        encoding="utf-8",
    )
    try:
        run_command(
            [
                tools.ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(destination),
            ]
        )
    finally:
        list_file.unlink(missing_ok=True)


def _mix_bgm(base: Path, bgm: Path, destination: Path, duration: float, tools: MediaTools) -> None:
    run_command(
        [
            tools.ffmpeg,
            "-y",
            "-i",
            str(base),
            "-stream_loop",
            "-1",
            "-i",
            str(bgm),
            "-filter_complex",
            f"[1:a]volume=0.12,atrim=duration={duration},asetpts=N/SR/TB[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]",
            "-map",
            "0:v:0",
            "-map",
            "[a]",
            "-t",
            str(duration),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )


def _replace_voiceover(base: Path, voiceover: Path, destination: Path, duration: float, tools: MediaTools) -> None:
    run_command(
        [
            tools.ffmpeg,
            "-y",
            "-i",
            str(base),
            "-stream_loop",
            "-1",
            "-i",
            str(voiceover),
            "-filter_complex",
            f"[1:a]apad=pad_dur={duration},atrim=duration={duration},asetpts=N/SR/TB[voice]",
            "-map",
            "0:v:0",
            "-map",
            "[voice]",
            "-t",
            str(duration),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )


def render_plan(plan: ReelPlan, output: Path | None = None, *, tools: MediaTools | None = None) -> RenderResult:
    """계획을 세로 MP4로 렌더링한다."""
    tools = tools or MediaTools.discover()
    output = output or Path(plan.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    work_dir = output.parent / f".{output.stem}-work"
    work_dir.mkdir(parents=True, exist_ok=True)
    segment_files: list[Path] = []
    durations = [_segment_duration(segment, tools) for segment in plan.segments]
    if plan.target_duration is not None:
        current_duration = sum(durations)
        if current_duration > plan.target_duration:
            raise MediaError(
                f"segment durations ({current_duration:.2f}s) exceed target_duration ({plan.target_duration:.2f}s)"
            )
        durations[-1] += plan.target_duration - current_duration
    try:
        for index, segment in enumerate(plan.segments):
            destination = work_dir / f"segment-{index:04d}.mp4"
            _render_segment(segment, destination, plan=plan, work_dir=work_dir, tools=tools, duration=durations[index])
            segment_files.append(destination)
        concatenated = work_dir / "concatenated.mp4"
        _concat_segments(segment_files, concatenated, tools)
        total_duration = sum(durations)
        if plan.voiceover:
            voiceover = Path(plan.voiceover)
            if not voiceover.exists():
                raise MediaError(f"voiceover file not found: {voiceover}")
            _replace_voiceover(concatenated, voiceover, output, total_duration, tools)
        elif plan.bgm:
            bgm = Path(plan.bgm)
            if not bgm.exists():
                raise MediaError(f"background music file not found: {bgm}")
            _mix_bgm(concatenated, bgm, output, total_duration, tools)
        else:
            shutil.copy2(concatenated, output)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
    return RenderResult(output=output, duration=sum(durations), segment_count=len(segment_files))
