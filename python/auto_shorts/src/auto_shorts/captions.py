from __future__ import annotations

from pathlib import Path
import textwrap

from PIL import Image, ImageDraw, ImageFont


FONT_CANDIDATES = (
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def find_font(size: int, font_path: str | None = None) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (font_path,) if font_path else FONT_CANDIDATES
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def wrap_text(text: str, font: ImageFont.ImageFont, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    """글자 폭을 실제로 측정해 한국어/영어가 섞인 문장을 줄바꿈한다."""
    lines: list[str] = []
    current = ""
    for word in text.strip().split():
        candidate = word if not current else f"{current} {word}"
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current and draw.textlength(current, font=font) > max_width:
        remainder = current
        current = ""
        for char in remainder:
            candidate = current + char
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
    if current:
        lines.append(current)
    return lines or [""]


def render_caption_overlay(
    text: str,
    output: Path,
    *,
    width: int = 1080,
    height: int = 1920,
    font_size: int = 76,
    font_path: str | None = None,
) -> Path:
    """세로 영상의 하단 안전영역에 자막 PNG를 만든다."""
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = find_font(font_size, font_path)
    max_text_width = int(width * 0.82)
    lines = wrap_text(text, font, max_text_width, draw)
    line_gap = max(12, font_size // 5)
    boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=2) for line in lines]
    text_height = sum(box[3] - box[1] for box in boxes) + line_gap * (len(lines) - 1)
    padding_x, padding_y = 36, 24
    box_width = min(width - 72, max(max_text_width, max(box[2] - box[0] for box in boxes) + padding_x * 2))
    box_height = text_height + padding_y * 2
    x = (width - box_width) // 2
    y = int(height * 0.79) - box_height // 2

    shadow_offset = 8
    draw.rounded_rectangle(
        (x + shadow_offset, y + shadow_offset, x + box_width + shadow_offset, y + box_height + shadow_offset),
        radius=28,
        fill=(0, 0, 0, 120),
    )
    draw.rounded_rectangle((x, y, x + box_width, y + box_height), radius=28, fill=(15, 18, 25, 218))

    cursor_y = y + padding_y
    for line, box in zip(lines, boxes):
        line_width = box[2] - box[0]
        cursor_x = (width - line_width) // 2
        draw.text(
            (cursor_x, cursor_y),
            line,
            font=font,
            fill=(255, 255, 255, 255),
            stroke_width=2,
            stroke_fill=(0, 0, 0, 220),
        )
        cursor_y += box[3] - box[1] + line_gap

    image.save(output, format="PNG")
    return output
