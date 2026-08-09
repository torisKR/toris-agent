from __future__ import annotations

import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import secrets
import sys

from .klipy import KlipyClient, KlipyError
from .media import MediaError, render_plan, validate_media
from .models import ReelPlan
from .publish import PublishError, PublishMetadata, create_draft, load_draft, publish_zernio, resolve_zernio_credentials
from .social_agents import (
    CHANNELS,
    SocialBrief,
    create_social_package,
    load_env_file,
    load_social_package,
    publish_social_package,
)
from .tiktok import DEFAULT_SCOPES, TikTokClient, TikTokError, generate_pkce
from .tts import FishAudioTTS, TtsError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI 숏폼을 FFmpeg로 렌더링하고 발행 초안을 관리합니다.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    draft = subparsers.add_parser("draft", aliases=["prepare-draft"], help="계획을 발행 초안 JSON으로 저장합니다. 외부 호출 없음")
    draft.add_argument("plan", type=Path)
    draft.add_argument("--output", type=Path, default=Path("output/draft.json"))
    draft.add_argument("--platform", action="append", default=["youtube", "instagram"])

    render = subparsers.add_parser("render", help="계획 JSON을 세로 MP4로 렌더링합니다.")
    render.add_argument("plan", type=Path)
    render.add_argument("--output", type=Path)
    render.add_argument("--duration", type=float, help="출력 목표 길이(15~60초). 계획의 target_duration을 덮어씁니다.")

    validate = subparsers.add_parser("validate", help="완성 MP4의 코덱·해상도·오디오를 검증합니다.")
    validate.add_argument("video", type=Path)

    tts = subparsers.add_parser("tts", help="외부 TTS로 나레이션 오디오를 생성합니다.")
    tts_subparsers = tts.add_subparsers(dest="tts_provider", required=True)
    fish = tts_subparsers.add_parser("fish-audio", help="Fish Audio S2.1 Pro Free로 MP3를 생성합니다.")
    fish.add_argument("text_file", type=Path)
    fish.add_argument("--output", type=Path, required=True)
    fish.add_argument("--model", default=os.environ.get("FISH_AUDIO_MODEL_ID", "s2.1-pro-free"))
    fish.add_argument("--reference-id", default=os.environ.get("FISH_AUDIO_REFERENCE_ID", ""))
    fish.add_argument("--speed", type=float, default=1.0)

    publish = subparsers.add_parser("publish", help="검토된 초안을 외부 발행 어댑터로 전송합니다.")
    publish.add_argument("draft", type=Path)
    publish.add_argument("--platform", choices=["zernio"], default="zernio")
    publish.add_argument("--confirm-publish", action="store_true", help="공개 발행을 명시적으로 승인")

    social = subparsers.add_parser("social", help="플랫폼별 전용 에이전트가 SNS 초안과 게시를 관리합니다.")
    social_subparsers = social.add_subparsers(dest="social_command", required=True)
    social_draft = social_subparsers.add_parser("draft", help="하나의 소재를 5개 플랫폼 전용 초안으로 변환합니다. 외부 호출 없음")
    social_draft.add_argument("brief", type=Path)
    social_draft.add_argument("--output", type=Path, default=Path("output/social-package.json"))
    social_draft.add_argument("--env-file", type=Path, default=Path(".env.zernio"))
    social_publish = social_subparsers.add_parser("publish", help="검토된 플랫폼별 초안을 해당 계정으로 게시합니다.")
    social_publish.add_argument("package", type=Path)
    social_publish.add_argument("--channel", action="append", choices=CHANNELS)
    social_publish.add_argument("--env-file", type=Path, default=Path(".env.zernio"))
    social_publish.add_argument("--result", type=Path, default=Path("output/social-publish-result.json"))
    social_publish.add_argument("--wait-seconds", type=int, default=120)
    social_publish.add_argument("--confirm-publish", action="store_true", help="선택한 SNS의 공개 게시를 명시적으로 승인")

    klipy = subparsers.add_parser("klipy", help="KLIPY Clip API에서 검색하고 MP4를 다운로드합니다.")
    klipy_subparsers = klipy.add_subparsers(dest="klipy_command", required=True)
    search = klipy_subparsers.add_parser("search", help="KLIPY 클립을 검색합니다.")
    search.add_argument("query")
    search.add_argument("--page", type=int, default=1)
    search.add_argument("--per-page", type=int, default=5)
    search.add_argument("--customer-id", default="auto_shorts")
    fetch = klipy_subparsers.add_parser("fetch", help="검색 결과 중 하나를 MP4로 저장합니다.")
    fetch.add_argument("query")
    fetch.add_argument("--index", type=int, default=0)
    fetch.add_argument("--output", type=Path, default=Path("output/klipy-clip.mp4"))
    fetch.add_argument("--per-page", type=int, default=5)
    fetch.add_argument("--customer-id", default="auto_shorts")

    tiktok = subparsers.add_parser("tiktok", help="TikTok Login Kit과 Content Posting API 경계를 실행합니다.")
    tiktok_subparsers = tiktok.add_subparsers(dest="tiktok_command", required=True)
    auth_url = tiktok_subparsers.add_parser("auth-url", help="TikTok OAuth 동의 URL을 생성합니다.")
    auth_url.add_argument("--client-key", default=os.environ.get("TIKTOK_CLIENT_KEY", ""))
    auth_url.add_argument("--redirect-uri", default=os.environ.get("TIKTOK_REDIRECT_URI", ""))
    auth_url.add_argument("--scope", dest="scopes", action="append")
    auth_url.add_argument("--state")
    auth_url.add_argument("--desktop", action="store_true", help="데스크톱 PKCE 파라미터를 포함합니다.")

    exchange = tiktok_subparsers.add_parser("exchange", help="OAuth authorization code를 토큰으로 교환합니다.")
    exchange.add_argument("code")
    exchange.add_argument("--redirect-uri", default=os.environ.get("TIKTOK_REDIRECT_URI", ""))
    exchange.add_argument("--code-verifier")

    upload = tiktok_subparsers.add_parser("upload", help="MP4를 TikTok 받은편지함 초안으로 업로드합니다.")
    upload.add_argument("video", type=Path)
    upload.add_argument("--chunk-size", type=int, default=None)
    upload.add_argument("--confirm-upload", action="store_true", help="TikTok 초안 업로드를 명시적으로 승인")

    status = tiktok_subparsers.add_parser("status", help="TikTok 업로드 상태를 조회합니다.")
    status.add_argument("publish_id")

    return parser


def command_draft(args: argparse.Namespace) -> int:
    plan = ReelPlan.from_json(args.plan)
    metadata = PublishMetadata(plan.title, plan.description, plan.output, tuple(args.platform))
    output = create_draft(metadata, args.output)
    print(json.dumps({"status": "awaiting_review", "draft": str(output)}, ensure_ascii=False))
    return 0


def command_render(args: argparse.Namespace) -> int:
    plan = ReelPlan.from_json(args.plan).resolve_paths(args.plan.parent)
    if args.duration is not None:
        plan = replace(plan, target_duration=args.duration)
        plan.validate()
    output = args.output or Path(plan.output)
    result = render_plan(plan, output)
    print(json.dumps({"status": "rendered", "output": str(result.output), "duration": result.duration, "segments": result.segment_count}, ensure_ascii=False))
    return 0


def command_validate(args: argparse.Namespace) -> int:
    print(json.dumps({"status": "validated", **validate_media(args.video)}, ensure_ascii=False))
    return 0


def command_tts(args: argparse.Namespace) -> int:
    if args.tts_provider != "fish-audio":
        raise TtsError(f"unsupported TTS provider: {args.tts_provider}")
    text = args.text_file.read_text(encoding="utf-8")
    output = FishAudioTTS(
        os.environ.get("FISHAUDIO_API_KEY") or os.environ.get("FISH_AUDIO_API_KEY", ""),
        model_id=args.model,
        reference_id=args.reference_id or None,
    ).synthesize(text, args.output, speed=args.speed)
    print(json.dumps({"status": "synthesized", "provider": "fish-audio", "model": args.model, "output": str(output)}, ensure_ascii=False))
    return 0


def command_publish(args: argparse.Namespace) -> int:
    draft = load_draft(args.draft)
    if args.platform != "zernio":
        raise PublishError(f"unsupported platform: {args.platform}")
    endpoint, token = resolve_zernio_credentials(draft.metadata.platforms, os.environ)
    response = publish_zernio(
        draft,
        endpoint=endpoint,
        token=token,
        confirm=args.confirm_publish,
    )
    print(json.dumps({"status": "submitted", "response": response}, ensure_ascii=False))
    return 0


def command_social(args: argparse.Namespace) -> int:
    load_env_file(args.env_file)
    if args.social_command == "draft":
        brief = SocialBrief.from_json(args.brief)
        output = create_social_package(brief, args.output, source=str(args.brief.resolve()), environ=os.environ)
        package = load_social_package(output)
        print(
            json.dumps(
                {
                    "status": package.status,
                    "package": str(output),
                    "drafts": [
                        {"channel": draft.channel, "agent": draft.strategy.get("agent", ""), "profile": draft.profile}
                        for draft in package.drafts
                    ],
                },
                ensure_ascii=False,
            )
        )
        return 0

    package = load_social_package(args.package)
    result = publish_social_package(
        package,
        environ=os.environ,
        confirm=args.confirm_publish,
        channels=tuple(args.channel or ()),
        wait_seconds=args.wait_seconds,
    )
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result["status"], "result": str(args.result), "posts": result["results"]}, ensure_ascii=False))
    return 0


def _klipy_client() -> KlipyClient:
    return KlipyClient(
        os.environ.get("KLIPY_API_KEY", ""),
        base_url=os.environ.get("KLIPY_API_BASE_URL", "https://api.klipy.com/api/v1"),
    )


def command_klipy(args: argparse.Namespace) -> int:
    client = _klipy_client()
    clips = client.search_clips(args.query, page=getattr(args, "page", 1), per_page=args.per_page, customer_id=args.customer_id)
    if args.klipy_command == "search":
        print(json.dumps({"status": "searched", "count": len(clips), "clips": [clip.to_dict() for clip in clips]}, ensure_ascii=False))
        return 0
    if not 0 <= args.index < len(clips):
        raise KlipyError(f"KLIPY result index out of range: {args.index}")
    clip = clips[args.index]
    output = client.download_clip(clip, args.output)
    print(json.dumps({"status": "downloaded", "output": str(output), "clip": clip.to_dict()}, ensure_ascii=False))
    return 0


def _tiktok_client() -> TikTokClient:
    return TikTokClient(
        os.environ.get("TIKTOK_CLIENT_KEY", ""),
        os.environ.get("TIKTOK_CLIENT_SECRET", ""),
    )


def command_tiktok(args: argparse.Namespace) -> int:
    if args.tiktok_command == "auth-url":
        client = TikTokClient(args.client_key)
        verifier = generate_pkce()[0] if args.desktop else None
        state = args.state or secrets.token_urlsafe(24)
        scopes = tuple(args.scopes or DEFAULT_SCOPES)
        result = {
            "status": "authorization_url",
            "state": state,
            "url": client.authorization_url(
                args.redirect_uri,
                scopes=scopes,
                state=state,
                code_verifier=verifier,
            ),
        }
        if verifier:
            result["code_verifier"] = verifier
        print(json.dumps(result, ensure_ascii=False))
        return 0

    client = _tiktok_client()
    if args.tiktok_command == "exchange":
        token = client.exchange_code(args.code, args.redirect_uri, code_verifier=args.code_verifier)
        print(json.dumps({"status": "token_received", **token.public_dict()}, ensure_ascii=False))
        return 0
    access_token = os.environ.get("TIKTOK_ACCESS_TOKEN", "")
    if args.tiktok_command == "upload":
        publish_id = client.upload_video_to_draft(
            args.video,
            access_token,
            chunk_size=args.chunk_size or 10 * 1024 * 1024,
            confirm=args.confirm_upload,
        )
        print(json.dumps({"status": "uploaded_to_tiktok_draft", "publish_id": publish_id}, ensure_ascii=False))
        return 0
    if args.tiktok_command == "status":
        response = client.fetch_status(args.publish_id, access_token)
        print(json.dumps({"status": "status_fetched", "response": response}, ensure_ascii=False))
        return 0
    return 1


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command in {"draft", "prepare-draft"}:
            return command_draft(args)
        if args.command == "render":
            return command_render(args)
        if args.command == "validate":
            return command_validate(args)
        if args.command == "tts":
            return command_tts(args)
        if args.command == "publish":
            return command_publish(args)
        if args.command == "social":
            return command_social(args)
        if args.command == "klipy":
            return command_klipy(args)
        if args.command == "tiktok":
            return command_tiktok(args)
    except (KlipyError, MediaError, PublishError, TikTokError, TtsError, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
