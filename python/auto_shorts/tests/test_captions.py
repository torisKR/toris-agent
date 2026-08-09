from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from auto_shorts.captions import render_caption_overlay, wrap_text


def test_wrap_text_respects_width():
    image = Image.new("RGB", (300, 100))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    lines = wrap_text("가나다라마바사아자차카타파하", font, 60, draw)

    assert len(lines) > 1


def test_render_caption_overlay_creates_transparent_png(tmp_path: Path):
    output = render_caption_overlay("자동 자막 테스트", tmp_path / "caption.png", width=360, height=640, font_size=30)
    image = Image.open(output)

    assert image.size == (360, 640)
    assert image.mode == "RGBA"
    assert image.getbbox() is not None
