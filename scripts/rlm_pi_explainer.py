#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pillow>=10.0.0",
# ]
# ///
"""
rlm.pi architecture explainer animation.

No native Cairo dependency: this version uses Pillow plus ffmpeg.

Usage:
  uv run scripts/rlm_pi_explainer.py [output.mp4]
"""

import math
import os
import shutil
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageFont

W, H = 854, 480
FPS = 24
DURATION = 12.0
TOTAL_FRAMES = int(FPS * DURATION)

BG = (26, 26, 28)
PANEL = (38, 38, 43)
BLUE = (88, 196, 221)
GREEN = (131, 193, 103)
YELLOW = (255, 214, 0)
PURPLE = (158, 115, 242)
DIM = (108, 108, 114)
WHITE = (235, 235, 235)
RED = (255, 107, 107)
BLACK = (20, 20, 20)

FONT_CACHE: dict[tuple[int, bool, bool], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def font(size: int, bold: bool = True, mono: bool = False):
    key = (size, bold, mono)
    if key in FONT_CACHE:
        return FONT_CACHE[key]
    candidates = []
    if mono:
        candidates = [
            "/System/Library/Fonts/Menlo.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ]
    elif bold:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ]
    else:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    for path in candidates:
        if os.path.exists(path):
            FONT_CACHE[key] = ImageFont.truetype(path, size)
            return FONT_CACHE[key]
    FONT_CACHE[key] = ImageFont.load_default()
    return FONT_CACHE[key]


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def ease(t: float) -> float:
    t = clamp(t)
    return t * t * (3 - 2 * t)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * clamp(t)


def text(draw: ImageDraw.ImageDraw, s: str, x: float, y: float, fill=WHITE, size=22, center=True, bold=True, mono=False):
    f = font(size, bold, mono)
    box = draw.textbbox((0, 0), s, font=f)
    w = box[2] - box[0]
    h = box[3] - box[1]
    tx = x - w / 2 if center else x
    draw.text((tx, y - h / 2), s, fill=fill, font=f)


def round_rect(draw: ImageDraw.ImageDraw, xy, fill, outline=None, width=1, radius=10):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def circle(draw: ImageDraw.ImageDraw, x: float, y: float, r: float, fill, outline=WHITE, width=2):
    box = (x - r, y - r, x + r, y + r)
    draw.ellipse(box, fill=fill, outline=outline, width=width)


def arrow(draw: ImageDraw.ImageDraw, x1: float, y1: float, x2: float, y2: float, fill, width=3, head=10):
    draw.line((x1, y1, x2, y2), fill=fill, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    p1 = (x2 - head * math.cos(ang - 0.45), y2 - head * math.sin(ang - 0.45))
    p2 = (x2 - head * math.cos(ang + 0.45), y2 - head * math.sin(ang + 0.45))
    draw.line((x2, y2, p1[0], p1[1]), fill=fill, width=width)
    draw.line((x2, y2, p2[0], p2[1]), fill=fill, width=width)


def node(draw: ImageDraw.ImageDraw, x: float, y: float, w: float, h: float, color, title: str, subtitle: str = "", size=17):
    round_rect(draw, (x, y, x + w, y + h), PANEL, color, 3, 12)
    text(draw, title, x + w / 2, y + h / 2 - (10 if subtitle else 0), color, size)
    if subtitle:
        text(draw, subtitle, x + w / 2, y + h / 2 + 18, DIM, 12, bold=False)


def repo(draw: ImageDraw.ImageDraw, x: float, y: float, p: float):
    round_rect(draw, (x, y, x + 160, y + 210), (33, 33, 36), DIM, 2, 8)
    text(draw, "Repository", x + 80, y + 24, WHITE, 17)
    dirs = ["core/", "sandbox/", "bridge/", "tool/", "state/", "ui/"]
    for i, d in enumerate(dirs):
        yy = y + 52 + i * 24
        ww = lerp(0, 122, p)
        round_rect(draw, (x + 18, yy - 9, x + 18 + ww, yy + 7), BLUE if i < 2 else DIM, None, 1, 4)
        text(draw, d, x + 28, yy, WHITE, 11, center=False, bold=False, mono=True)


def render_frame(frame_num: int, out_dir: str):
    t = frame_num / FPS
    scene_t = t / 2.0
    p = t / DURATION
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    cx = W / 2

    text(draw, "rlm.pi — Recursive Language Model plugin for Pi", cx, 34, WHITE, 25)
    round_rect(draw, (120, 450, 734, 458), (46, 46, 49), None, 1, 4)
    round_rect(draw, (120, 450, 120 + 614 * p, 458), BLUE, None, 1, 4)

    if scene_t < 1.0:
        q = ease(scene_t)
        text(draw, "Root Pi stays the conductor", cx, 76, BLUE, 24)
        node(draw, 105, 145, 190, 105, BLUE, "Root Pi Agent", "commands + tools")
        node(draw, 560, 145, 190, 105, GREEN, "RLM Worker", "analyst model")
        arrow(draw, 302, 197, lerp(302, 552, q), 197, YELLOW, 3, 11)
        text(draw, "user task", 427, 173, YELLOW, 14)
        if q > 0.35:
            node(draw, 330, 285, 195, 55, PURPLE, "RLM mode", "one active run", 18)

    elif scene_t < 2.0:
        q = ease(scene_t - 1.0)
        text(draw, "Context seeds on first repl(), then grows", cx, 76, BLUE, 24)
        repo(draw, 80, 130, q)
        node(draw, 340, 155, 180, 92, BLUE, "walker", "resolveSource()")
        node(draw, 610, 150, 160, 105, GREEN, "Context", "starts empty")
        arrow(draw, 245, 232, lerp(245, 335, q), 202, BLUE)
        arrow(draw, 525, 202, lerp(525, 605, q), 202, GREEN)
        if q > 0.55:
            for i in range(3):
                x = 624 + i * 36
                y = 275 + math.sin(t * 8 + i) * 4
                round_rect(draw, (x, y, x + 86, y + 24), YELLOW, None, 1, 5)
                text(draw, "add_context", x + 43, y + 12, BLACK, 10)
            arrow(draw, 675, 275, 675, 258, YELLOW, 2, 8)
            text(draw, "docs → Markdown", 675, 330, DIM, 14, bold=False)

    elif scene_t < 3.0:
        q = ease(scene_t - 2.0)
        text(draw, "Engine loop: think → repl → execute → observe", cx, 76, BLUE, 24)
        steps = [("think", BLUE), ("```repl```", YELLOW), ("execute", GREEN), ("observe", PURPLE)]
        xs = [120, 310, 500, 690]
        for i, (label, col) in enumerate(steps):
            node(draw, xs[i] - 70, 160, 140, 70, col, label, size=17)
            if i < 3:
                arrow(draw, xs[i] + 74, 195, xs[i + 1] - 76, 195, col if q * 4 > i else DIM, 2, 9)
        draw.arc((217, 75, 637, 495), start=20, end=160, fill=DIM, width=3)
        text(draw, "persistent Python state", cx, 300, GREEN, 16)
        round_rect(draw, (280, 330, 280 + 294 * q, 374), YELLOW, None, 1, 8)
        if q > 0.25:
            text(draw, "until answer['ready'] == True", cx, 352, BLACK, 17, mono=True)

    elif scene_t < 4.0:
        q = ease(scene_t - 3.0)
        text(draw, "Sandbox is sealed; bridges run in the parent", cx, 76, BLUE, 24)
        node(draw, 90, 155, 210, 132, GREEN, "Python Sandbox", "worker.py + state")
        node(draw, 565, 135, 200, 60, PURPLE, "llm_query", "parent bridge")
        node(draw, 565, 220, 200, 60, PURPLE, "rlm_query", "recursive child")
        node(draw, 565, 305, 200, 60, PURPLE, "todo / ask user", "handlers")
        for i, y in enumerate([165, 250, 335]):
            a = clamp((q - i * 0.16) / 0.45)
            arrow(draw, 305, 220, lerp(305, 558, a), y, YELLOW, 2, 9)
            if a > 0.65:
                arrow(draw, 558, y + 18, 305, 238, DIM, 2, 7)
        text(draw, "JSONL interrupt protocol", cx, 407, DIM, 15, bold=False)
        text(draw, "API keys never enter the sandbox", 195, 320, RED, 14)

    elif scene_t < 5.0:
        q = ease(scene_t - 4.0)
        text(draw, "Guardrails: limits, audit trail, routing", cx, 76, BLUE, 24)
        node(draw, 90, 140, 175, 90, RED, "blocked", "bulk file reads")
        node(draw, 340, 125, 175, 120, YELLOW, "JSONL trail", "resume state")
        node(draw, 590, 140, 175, 90, GREEN, "limits", "turns/time/depth")
        for i in range(7):
            yy = 150 + i * 14
            draw.line((370, yy, 485, yy), fill=DIM if i > q * 8 else YELLOW, width=3)
        if q > 0.35:
            arrow(draw, 265, 185, 335, 185, RED, 2, 8)
            arrow(draw, 520, 185, 585, 185, GREEN, 2, 8)
            text(draw, "RlmController routes input", cx, 295, BLUE, 19)
            text(draw, "SandboxManager serializes execution", cx, 325, GREEN, 17)
            text(draw, "State layer can reconstruct a run", cx, 355, YELLOW, 17)

    else:
        q = ease(scene_t - 5.0)
        text(draw, "Final synthesis returns to Pi", cx, 76, BLUE, 24)
        circle(draw, 170, 200, 46, BLUE)
        text(draw, "ROOT", 170, 190, BLACK, 15)
        text(draw, "Pi", 170, 212, BLACK, 18)
        circle(draw, 427, 180, 54, GREEN)
        text(draw, "RLM", 427, 168, BLACK, 20)
        text(draw, "Worker", 427, 194, BLACK, 15)
        round_rect(draw, (595, 165, 595 + lerp(70, 195, q), 235), YELLOW, None, 1, 12)
        text(draw, "FINAL ANSWER", 692, 200, BLACK, 20)
        arrow(draw, 224, 198, 368, 184, BLUE, 3, 10)
        arrow(draw, 484, 187, 590, 197, YELLOW, 3, 11)
        if q > 0.4:
            text(draw, "deep repo reasoning without flooding the root context", cx, 305, WHITE, 20)
            text(draw, "Persistent REPL • Delegated subcalls • Auditable resume", cx, 345, DIM, 16, bold=False)

    img.save(os.path.join(out_dir, f"frame_{frame_num:04d}.png"))


def main():
    output = sys.argv[1] if len(sys.argv) > 1 else "rlm_pi_explainer.mp4"
    out_dir = tempfile.mkdtemp(prefix="rlm_pi_frames_")
    try:
        print(f"Rendering {TOTAL_FRAMES} frames...")
        for i in range(TOTAL_FRAMES):
            render_frame(i, out_dir)
            if (i + 1) % FPS == 0:
                print(f"  {i + 1}/{TOTAL_FRAMES}")
        cmd = [
            "ffmpeg", "-y", "-framerate", str(FPS),
            "-i", os.path.join(out_dir, "frame_%04d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "medium", "-crf", "18", output,
        ]
        print("Encoding video...")
        subprocess.run(cmd, check=True)
        print(f"Video saved to {output}")
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
