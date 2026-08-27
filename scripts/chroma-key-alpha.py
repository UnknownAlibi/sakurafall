#!/usr/bin/env python3
"""Convert a flat chroma-key image into a decontaminated RGBA PNG."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def parse_color(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) != 6:
        raise argparse.ArgumentTypeError("key color must be RRGGBB")
    try:
        return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("key color must be hexadecimal") from exc


def extract_alpha(
    source: Image.Image,
    key: tuple[int, int, int],
    threshold: float,
) -> Image.Image:
    output = Image.new("RGBA", source.size)
    pixels = []

    key_spill = max(1, key[1] - max(key[0], key[2]))

    for red, green, blue in source.convert("RGB").getdata():
        channels = (red, green, blue)
        green_spill = max(0, green - max(red, blue))
        raw_alpha = max(0.0, min(1.0, 1.0 - green_spill / key_spill))

        if raw_alpha <= threshold:
            pixels.append((0, 0, 0, 0))
            continue

        alpha = min(1.0, (raw_alpha - threshold) / (1.0 - threshold))
        foreground = []
        for channel, key_channel in zip(channels, key):
            value = (channel - (1.0 - raw_alpha) * key_channel) / raw_alpha
            foreground.append(round(max(0.0, min(255.0, value))))
        pixels.append((*foreground, round(alpha * 255)))

    output.putdata(pixels)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--key", type=parse_color, default=(9, 235, 18))
    parser.add_argument("--threshold", type=float, default=0.09)
    args = parser.parse_args()

    if not 0 <= args.threshold < 1:
        parser.error("threshold must be in [0, 1)")

    source = Image.open(args.input)
    result = extract_alpha(source, args.key, args.threshold)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, optimize=True)


if __name__ == "__main__":
    main()
