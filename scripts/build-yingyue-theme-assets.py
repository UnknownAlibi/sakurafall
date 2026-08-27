#!/usr/bin/env python3
"""Build the runtime Yingyue theme assets from versioned transparent masters."""

from __future__ import annotations

import math
import io
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
MASTER_DIR = ROOT / "docs" / "theme-assets"
THEME_ROOT = ROOT / "extensions" / "bundled" / "themes"
THEME_DIR = THEME_ROOT / "sakurafall-default" / "assets"
BUILD_DIR = ROOT / "build"
PUBLIC_DIR = ROOT / "public"
RENDERER_ASSET_DIR = ROOT / "src" / "renderer" / "assets" / "generated"
QA_DIR = ROOT / "tmp" / "yingyue-assets"

RESAMPLE = Image.Resampling.LANCZOS

THEME_BACKGROUNDS = {
    "sakurafall-default": "screening-room-v3.png",
    "night-stage": "neon-night-flight-v3.png",
    "manga-ink": "manga-workshop-v3.png",
    "forest-fresh": "forest-festival-v3.png",
    "summer-splash": "sea-salt-holiday-v3.png",
    "snow-noel": "snowlight-night-v3.png",
}

THEME_MASCOTS = {
    "night-stage": "yingyue-outfit-night-stage-v1.png",
    "manga-ink": "yingyue-outfit-manga-ink-v1.png",
    "forest-fresh": "yingyue-outfit-forest-fresh-v1.png",
    "summer-splash": "yingyue-outfit-summer-splash-v1.png",
    "snow-noel": "yingyue-outfit-snow-noel-v1.png",
}


def alpha_bbox(image: Image.Image, threshold: int = 0) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    if threshold > 0:
        alpha = alpha.point(lambda value: 255 if value > threshold else 0)
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("source image is fully transparent")
    return bbox


def fit_transparent(
    image: Image.Image,
    size: tuple[int, int],
    margin: int = 0,
    *,
    crop: bool = True,
    alpha_threshold: int = 0,
) -> Image.Image:
    source = image.convert("RGBA")
    if crop:
        source = source.crop(alpha_bbox(source, alpha_threshold))

    available = (size[0] - margin * 2, size[1] - margin * 2)
    scale = min(available[0] / source.width, available[1] / source.height)
    resized = source.resize(
        (max(1, round(source.width * scale)), max(1, round(source.height * scale))),
        RESAMPLE,
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    position = ((size[0] - resized.width) // 2, (size[1] - resized.height) // 2)
    canvas.alpha_composite(resized, position)
    return canvas


def build_app_icon_layer(source: Image.Image, size: int) -> Image.Image:
    """Render one native ICO layer from the clean master artwork."""
    margin = max(0, round(size * 0.025))
    layer = fit_transparent(
        source,
        (size, size),
        margin=margin,
        alpha_threshold=8,
    )

    # Small Windows icon layers need their own edge treatment. Sharpening the
    # 512px export before downscaling leaves the 16-48px layers visibly soft.
    if size <= 24:
        layer = layer.filter(ImageFilter.UnsharpMask(radius=0.55, percent=185, threshold=2))
    elif size <= 48:
        layer = layer.filter(ImageFilter.UnsharpMask(radius=0.7, percent=145, threshold=2))
    elif size <= 64:
        layer = layer.filter(ImageFilter.UnsharpMask(radius=0.85, percent=110, threshold=2))
    elif size <= 128:
        layer = layer.filter(ImageFilter.UnsharpMask(radius=1.0, percent=75, threshold=2))
    return layer


def save_png_ico(path: Path, layers: list[Image.Image]) -> None:
    """Write an ICO whose PNG-compressed layers were rendered independently."""
    payloads: list[bytes] = []
    for layer in layers:
        buffer = io.BytesIO()
        layer.save(buffer, format="PNG", optimize=True)
        payloads.append(buffer.getvalue())

    header_size = 6 + 16 * len(layers)
    offset = header_size
    entries = []
    for layer, payload in zip(layers, payloads):
        width = 0 if layer.width == 256 else layer.width
        height = 0 if layer.height == 256 else layer.height
        entries.append(
            struct.pack(
                "<BBBBHHII",
                width,
                height,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        offset += len(payload)

    with path.open("wb") as icon_file:
        icon_file.write(struct.pack("<HHH", 0, 1, len(layers)))
        icon_file.write(b"".join(entries))
        icon_file.write(b"".join(payloads))


def cover_crop(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    source = image.convert("RGB")
    scale = max(size[0] / source.width, size[1] / source.height)
    resized = source.resize(
        (max(1, round(source.width * scale)), max(1, round(source.height * scale))),
        RESAMPLE,
    )
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def build_theme_backgrounds() -> None:
    source_dir = MASTER_DIR / "backgrounds"
    for theme_id, filename in THEME_BACKGROUNDS.items():
        with Image.open(source_dir / filename) as source:
            background = cover_crop(source, (1672, 941))
            preview = cover_crop(source, (480, 270))

        asset_dir = THEME_ROOT / theme_id / "assets"
        asset_dir.mkdir(parents=True, exist_ok=True)
        background.save(asset_dir / "background.webp", format="WEBP", quality=90, method=6)
        preview.save(
            RENDERER_ASSET_DIR / f"theme-preview-{theme_id}.webp",
            format="WEBP",
            quality=82,
            method=6,
        )


def build_theme_mascots(default_mascot: Image.Image) -> dict[str, Image.Image]:
    mascots = {"sakurafall-default": default_mascot}
    for theme_id, filename in THEME_MASCOTS.items():
        with Image.open(MASTER_DIR / filename) as source:
            mascot = fit_transparent(source, (627, 720), margin=10)
        asset_dir = THEME_ROOT / theme_id / "assets"
        asset_dir.mkdir(parents=True, exist_ok=True)
        mascot.save(asset_dir / "mascot.webp", format="WEBP", lossless=True, method=6)
        mascots[theme_id] = mascot
    return mascots


def build_theme_qa(mascots: dict[str, Image.Image]) -> None:
    QA_DIR.mkdir(parents=True, exist_ok=True)
    card_size = (480, 270)
    sheet = Image.new("RGB", (card_size[0] * 2, card_size[1] * 3), (20, 22, 30))
    for index, theme_id in enumerate(THEME_BACKGROUNDS):
        with Image.open(THEME_ROOT / theme_id / "assets" / "background.webp") as source:
            card = source.convert("RGBA").resize(card_size, RESAMPLE)
        shade = Image.new("RGBA", card_size, (12, 15, 24, 82))
        card.alpha_composite(shade)
        mascot = mascots[theme_id].copy()
        mascot.thumbnail((180, 250), RESAMPLE)
        card.alpha_composite(mascot, (card_size[0] - mascot.width - 12, card_size[1] - mascot.height))
        sheet.paste(card.convert("RGB"), ((index % 2) * card_size[0], (index // 2) * card_size[1]))
    sheet.save(QA_DIR / "theme-worlds-qa.jpg", quality=94, optimize=True)


def loading_ring_frame(size: tuple[int, int], angle: float) -> Image.Image:
    scale = 4
    width, height = size
    layer = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    center = (102 * scale, 151 * scale)
    radius = 22 * scale
    box = (
        center[0] - radius,
        center[1] - radius,
        center[0] + radius,
        center[1] + radius,
    )

    draw.ellipse(box, outline=(210, 230, 220, 105), width=3 * scale)
    draw.arc(box, start=angle, end=angle + 112, fill=(92, 205, 184, 255), width=5 * scale)
    draw.arc(box, start=angle + 126, end=angle + 170, fill=(244, 118, 147, 235), width=3 * scale)

    lead_angle = math.radians(angle + 112)
    lead = (
        center[0] + math.cos(lead_angle) * radius,
        center[1] + math.sin(lead_angle) * radius,
    )
    bead_radius = 3 * scale
    draw.ellipse(
        (
            lead[0] - bead_radius,
            lead[1] - bead_radius,
            lead[0] + bead_radius,
            lead[1] + bead_radius,
        ),
        fill=(255, 230, 218, 255),
        outline=(244, 118, 147, 255),
        width=scale,
    )
    return layer.resize(size, RESAMPLE)


def build_loading(source: Image.Image) -> tuple[Image.Image, Image.Image]:
    mascot = fit_transparent(source, (192, 270), margin=6, crop=False)
    frames: list[Image.Image] = []
    for index in range(32):
        frame = mascot.copy()
        frame.alpha_composite(loading_ring_frame(frame.size, index * 360 / 32))
        frames.append(frame)

    sprite = Image.new("RGBA", (192 * len(frames), 270), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        sprite.alpha_composite(frame, (index * 192, 0))
    return frames[0], sprite


def checkerboard(size: tuple[int, int], cell: int = 16) -> Image.Image:
    result = Image.new("RGBA", size, (0, 0, 0, 255))
    draw = ImageDraw.Draw(result)
    colors = ((31, 34, 47, 255), (63, 68, 84, 255))
    for top in range(0, size[1], cell):
        for left in range(0, size[0], cell):
            color = colors[(left // cell + top // cell) % 2]
            draw.rectangle((left, top, left + cell - 1, top + cell - 1), fill=color)
    return result


def build_qa(
    brand: Image.Image,
    mascot: Image.Image,
    cursor_default: Image.Image,
    cursor_pointer: Image.Image,
    loading_sprite: Image.Image,
) -> None:
    QA_DIR.mkdir(parents=True, exist_ok=True)
    qa = checkerboard((1120, 760), 20)
    draw = ImageDraw.Draw(qa)

    mascot_preview = mascot.copy()
    mascot_preview.thumbnail((420, 700), RESAMPLE)
    qa.alpha_composite(mascot_preview, (20, 30))

    qa.alpha_composite(brand, (470, 28))
    brand_small = brand.resize((32, 32), RESAMPLE).resize((128, 128), Image.Resampling.NEAREST)
    qa.alpha_composite(brand_small, (742, 92))

    qa.alpha_composite(cursor_default, (900, 30))
    qa.alpha_composite(cursor_pointer, (900, 178))
    qa.alpha_composite(cursor_default.resize((40, 40), RESAMPLE), (1040, 70))
    qa.alpha_composite(cursor_pointer.resize((40, 40), RESAMPLE), (1040, 218))

    for column, frame_index in enumerate((0, 8, 16, 24)):
        frame = loading_sprite.crop((frame_index * 192, 0, (frame_index + 1) * 192, 270))
        qa.alpha_composite(frame, (460 + column * 164, 450))

    draw.text((470, 300), "brand 256 / 32px nearest preview", fill=(240, 242, 248, 255))
    draw.text((900, 330), "cursor 128 / 40px", fill=(240, 242, 248, 255))
    draw.text((460, 728), "loading frames 0 / 8 / 16 / 24", fill=(240, 242, 248, 255))
    qa.convert("RGB").save(QA_DIR / "runtime-qa.jpg", quality=94, optimize=True)


def validate_runtime_assets(loading_sprite: Image.Image) -> None:
    expected = {
        "brand-mark.png": (256, 256),
        "cursor-default.png": (128, 128),
        "cursor-pointer.png": (128, 128),
        "loading-animation.webp": (6144, 270),
        "loading-static.webp": (192, 270),
        "mascot.webp": (627, 720),
    }
    for filename, size in expected.items():
        path = THEME_DIR / filename
        with Image.open(path) as image:
            if image.size != size or "A" not in image.getbands():
                raise ValueError(f"invalid runtime asset: {filename}")
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"runtime asset exceeds 2MB: {filename}")

    frames = [
        loading_sprite.crop((index * 192, 0, (index + 1) * 192, 270))
        for index in range(32)
    ]
    if len({frame.tobytes() for frame in frames}) != 32:
        raise ValueError("loading sprite does not contain 32 distinct frames")
    changed_bounds = [ImageChops.difference(frames[0], frame).getbbox() for frame in frames[1:]]
    if any(bounds is None or bounds[0] < 74 or bounds[1] < 130 or bounds[2] > 126 or bounds[3] > 178
           for bounds in changed_bounds):
        raise ValueError("loading animation changes pixels outside the centered ring")

    for theme_id in THEME_BACKGROUNDS:
        path = THEME_ROOT / theme_id / "assets" / "background.webp"
        with Image.open(path) as image:
            if image.size != (1672, 941) or image.mode != "RGB":
                raise ValueError(f"invalid theme background: {theme_id}")
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"theme background exceeds 2MB: {theme_id}")

    for theme_id in THEME_MASCOTS:
        path = THEME_ROOT / theme_id / "assets" / "mascot.webp"
        with Image.open(path) as image:
            if image.size != (627, 720) or "A" not in image.getbands():
                raise ValueError(f"invalid theme mascot: {theme_id}")
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"theme mascot exceeds 2MB: {theme_id}")


def main() -> None:
    sources = {
        "mascot": Image.open(MASTER_DIR / "yingyue-transparent-master-v1.png").convert("RGBA"),
        "brand": Image.open(MASTER_DIR / "yingyue-brand-mark-master-v1.png").convert("RGBA"),
        "loading": Image.open(MASTER_DIR / "yingyue-loading-master-v1.png").convert("RGBA"),
        "cursor_default": Image.open(MASTER_DIR / "yingyue-cursor-default-master-v1.png").convert("RGBA"),
        "cursor_pointer": Image.open(MASTER_DIR / "yingyue-cursor-pointer-master-v1.png").convert("RGBA"),
    }

    THEME_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    RENDERER_ASSET_DIR.mkdir(parents=True, exist_ok=True)

    mascot = fit_transparent(sources["mascot"], (627, 720), margin=10)
    brand = fit_transparent(
        sources["brand"],
        (256, 256),
        margin=7,
        alpha_threshold=8,
    )
    cursor_default = fit_transparent(sources["cursor_default"], (128, 128))
    cursor_pointer = fit_transparent(sources["cursor_pointer"], (128, 128))
    loading_static, loading_sprite = build_loading(sources["loading"])

    mascot.save(THEME_DIR / "mascot.webp", format="WEBP", lossless=True, method=6)
    brand.save(THEME_DIR / "brand-mark.png", optimize=True)
    cursor_default.save(THEME_DIR / "cursor-default.png", optimize=True)
    cursor_pointer.save(THEME_DIR / "cursor-pointer.png", optimize=True)
    loading_static.save(THEME_DIR / "loading-static.webp", format="WEBP", lossless=True, method=6)
    loading_sprite.save(THEME_DIR / "loading-animation.webp", format="WEBP", lossless=True, method=6)
    loading_static.save(RENDERER_ASSET_DIR / "yingyue-loading-static.webp", format="WEBP", lossless=True, method=6)
    loading_sprite.save(RENDERER_ASSET_DIR / "yingyue-loading-animation.webp", format="WEBP", lossless=True, method=6)
    build_theme_backgrounds()
    theme_mascots = build_theme_mascots(mascot)

    icon_sizes = (16, 24, 32, 48, 64, 128, 256)
    icon_layers = [build_app_icon_layer(sources["brand"], size) for size in icon_sizes]
    app_icon = build_app_icon_layer(sources["brand"], 512)
    app_icon.save(BUILD_DIR / "icon-v4.png", optimize=True)
    app_icon.save(PUBLIC_DIR / "sakurafall-mark-v4.png", optimize=True)
    save_png_ico(BUILD_DIR / "icon-v4.ico", icon_layers)
    save_png_ico(PUBLIC_DIR / "favicon-v4.ico", icon_layers)

    validate_runtime_assets(loading_sprite)
    build_qa(brand, mascot, cursor_default, cursor_pointer, loading_sprite)
    build_theme_qa(theme_mascots)


if __name__ == "__main__":
    main()
