#!/usr/bin/env python3
"""Generate a 384x384 pixel art sprite sheet for the dashboard character.

6 rows (animation states) x 6 columns (frames) = 36 frames, each 64x64px.
Stardew Valley style: hooded trader at desk with 2 monitors.

Row 0: idle       - breathing, occasional mouse click
Row 1: working    - fast typing, monitor flicker
Row 2: sleeping   - slumped on desk, Zzz
Row 3: celebrating - arms up, sparkles
Row 4: worried    - sweat drops, hunched
Row 5: warmup     - monitors turning on, stretching
"""

from PIL import Image, ImageDraw
import base64
import sys
import os

W, H = 64, 64
COLS, ROWS = 6, 6
SHEET_W, SHEET_H = W * COLS, H * ROWS

# Color palette (brighter for dark dashboard background #111a2b)
TRANSPARENT = (0, 0, 0, 0)
SKIN = (255, 210, 170, 255)
SKIN_SHADOW = (230, 180, 140, 255)
HAIR = (90, 60, 40, 255)
HOODIE = (100, 130, 200, 255)
HOODIE_DARK = (75, 100, 170, 255)
HOODIE_LIGHT = (130, 160, 220, 255)
DESK = (160, 120, 80, 255)
DESK_TOP = (185, 145, 100, 255)
DESK_DARK = (130, 95, 65, 255)
CHAIR = (90, 90, 110, 255)
CHAIR_BACK = (105, 105, 125, 255)
MONITOR_FRAME = (70, 75, 95, 255)
MONITOR_SCREEN = (30, 45, 75, 255)
MONITOR_GREEN = (16, 220, 150, 255)
MONITOR_BLUE = (80, 150, 255, 255)
MONITOR_RED = (255, 90, 90, 255)
SCREEN_LINE = (100, 150, 200, 220)
EYE_WHITE = (255, 255, 255, 255)
EYE_PUPIL = (40, 30, 25, 255)
MOUTH = (200, 120, 100, 255)
ZZZ = (170, 190, 240, 230)
SPARKLE = (255, 230, 110, 255)
SWEAT = (160, 220, 255, 240)
OUTLINE = (50, 40, 35, 255)


def px(draw, x, y, color):
    """Draw a single pixel."""
    if 0 <= x < W and 0 <= y < H and color[3] > 0:
        draw.point((x, y), fill=color)


def rect(draw, x, y, w, h, color):
    """Draw a filled rectangle."""
    for dy in range(h):
        for dx in range(w):
            px(draw, x + dx, y + dy, color)


def draw_desk(draw):
    """Draw the desk - bottom portion of frame."""
    # Desk top surface
    rect(draw, 8, 44, 48, 3, DESK_TOP)
    # Desk front
    rect(draw, 8, 47, 48, 8, DESK)
    # Desk shadow line
    rect(draw, 8, 47, 48, 1, DESK_DARK)
    # Desk legs
    rect(draw, 10, 55, 3, 9, DESK_DARK)
    rect(draw, 51, 55, 3, 9, DESK_DARK)


def draw_chair(draw):
    """Draw the chair behind character."""
    # Chair back
    rect(draw, 24, 28, 16, 2, CHAIR_BACK)
    rect(draw, 23, 30, 1, 12, CHAIR_BACK)
    rect(draw, 40, 30, 1, 12, CHAIR_BACK)


def draw_monitors(draw, left_glow=MONITOR_BLUE, right_glow=MONITOR_GREEN, flicker=0):
    """Draw two monitors on the desk."""
    # Left monitor
    rect(draw, 11, 30, 14, 12, MONITOR_FRAME)
    rect(draw, 12, 31, 12, 10, MONITOR_SCREEN)
    # Monitor stand
    rect(draw, 16, 42, 4, 2, MONITOR_FRAME)

    # Right monitor
    rect(draw, 39, 30, 14, 12, MONITOR_FRAME)
    rect(draw, 40, 31, 12, 10, MONITOR_SCREEN)
    # Monitor stand
    rect(draw, 44, 42, 4, 2, MONITOR_FRAME)

    # Screen content - chart lines
    if flicker != 2:  # not off
        # Left screen - green line chart
        for i in range(10):
            y_off = [3, 2, 4, 1, 3, 2, 5, 3, 1, 2][i]
            if flicker == 1 and i % 3 == 0:
                continue
            px(draw, 13 + i, 35 + y_off, left_glow)
            px(draw, 13 + i, 36 + y_off, (*left_glow[:3], 80))

        # Right screen - candles
        for i in range(5):
            h_val = [4, 6, 3, 7, 5][i]
            c = right_glow if h_val > 4 else ((*right_glow[:3], 150))
            rect(draw, 41 + i * 2, 38 - h_val, 1, h_val, c)


def draw_body_sitting(draw, y_off=0, arms='desk'):
    """Draw character body sitting at desk."""
    y = y_off

    # Hoodie body (torso)
    rect(draw, 27, 36 + y, 10, 8, HOODIE)
    rect(draw, 26, 37 + y, 1, 6, HOODIE_DARK)
    rect(draw, 37, 37 + y, 1, 6, HOODIE_DARK)
    # Hoodie middle line
    rect(draw, 32, 37 + y, 1, 7, HOODIE_DARK)

    if arms == 'desk':
        # Arms on desk - reaching toward keyboard area
        rect(draw, 24, 42 + y, 4, 2, HOODIE)
        rect(draw, 36, 42 + y, 4, 2, HOODIE)
        # Hands
        rect(draw, 23, 42 + y, 2, 2, SKIN)
        rect(draw, 39, 42 + y, 2, 2, SKIN)
    elif arms == 'up':
        # Arms raised in celebration
        rect(draw, 23, 33 + y, 3, 2, HOODIE)
        rect(draw, 38, 33 + y, 3, 2, HOODIE)
        rect(draw, 22, 31 + y, 2, 3, HOODIE)
        rect(draw, 40, 31 + y, 2, 3, HOODIE)
        # Hands up
        rect(draw, 22, 30 + y, 2, 2, SKIN)
        rect(draw, 40, 30 + y, 2, 2, SKIN)
    elif arms == 'typing_l':
        # Left hand raised, right on desk
        rect(draw, 24, 40 + y, 4, 2, HOODIE)
        rect(draw, 36, 42 + y, 4, 2, HOODIE)
        rect(draw, 23, 40 + y, 2, 2, SKIN)
        rect(draw, 39, 42 + y, 2, 2, SKIN)
    elif arms == 'typing_r':
        # Right hand raised, left on desk
        rect(draw, 24, 42 + y, 4, 2, HOODIE)
        rect(draw, 36, 40 + y, 4, 2, HOODIE)
        rect(draw, 23, 42 + y, 2, 2, SKIN)
        rect(draw, 39, 40 + y, 2, 2, SKIN)
    elif arms == 'slumped':
        # Arms flat on desk (sleeping)
        rect(draw, 22, 43 + y, 6, 2, HOODIE)
        rect(draw, 36, 43 + y, 6, 2, HOODIE)
        rect(draw, 21, 43 + y, 2, 2, SKIN)
        rect(draw, 41, 43 + y, 2, 2, SKIN)


def draw_head(draw, y_off=0, eyes='open', blink=False, look_dir=0, mouth='smile'):
    """Draw the character's head."""
    y = y_off

    # Hair back
    rect(draw, 28, 24 + y, 8, 3, HAIR)

    # Face
    rect(draw, 28, 26 + y, 8, 9, SKIN)
    rect(draw, 29, 25 + y, 6, 1, SKIN)
    # Face shadow
    rect(draw, 28, 33 + y, 8, 2, SKIN_SHADOW)

    # Hood
    rect(draw, 27, 24 + y, 10, 3, HOODIE)
    rect(draw, 26, 26 + y, 2, 4, HOODIE)
    rect(draw, 36, 26 + y, 2, 4, HOODIE)
    # Hood top highlight
    rect(draw, 28, 24 + y, 8, 1, HOODIE_LIGHT)

    # Hair strands visible under hood
    rect(draw, 28, 26 + y, 2, 2, HAIR)
    rect(draw, 34, 26 + y, 2, 2, HAIR)

    # Eyes
    if eyes == 'open' and not blink:
        # Left eye
        px(draw, 30 + look_dir, 29 + y, EYE_WHITE)
        px(draw, 30 + look_dir, 30 + y, EYE_PUPIL)
        # Right eye
        px(draw, 33 + look_dir, 29 + y, EYE_WHITE)
        px(draw, 33 + look_dir, 30 + y, EYE_PUPIL)
    elif eyes == 'closed' or blink:
        # Closed eyes (sleeping or blink)
        px(draw, 30, 30 + y, OUTLINE)
        px(draw, 31, 30 + y, OUTLINE)
        px(draw, 33, 30 + y, OUTLINE)
        px(draw, 34, 30 + y, OUTLINE)
    elif eyes == 'wide':
        # Wide worried eyes
        px(draw, 30, 29 + y, EYE_WHITE)
        px(draw, 31, 29 + y, EYE_WHITE)
        px(draw, 30, 30 + y, EYE_PUPIL)
        px(draw, 31, 30 + y, EYE_WHITE)
        px(draw, 33, 29 + y, EYE_WHITE)
        px(draw, 34, 29 + y, EYE_WHITE)
        px(draw, 33, 30 + y, EYE_WHITE)
        px(draw, 34, 30 + y, EYE_PUPIL)

    # Mouth
    if mouth == 'smile':
        px(draw, 31, 32 + y, MOUTH)
        px(draw, 32, 33 + y, MOUTH)
        px(draw, 33, 32 + y, MOUTH)
    elif mouth == 'open':
        px(draw, 31, 32 + y, MOUTH)
        px(draw, 32, 32 + y, (100, 50, 40, 255))
        px(draw, 33, 32 + y, MOUTH)
        px(draw, 32, 33 + y, MOUTH)
    elif mouth == 'flat':
        px(draw, 31, 32 + y, MOUTH)
        px(draw, 32, 32 + y, MOUTH)
        px(draw, 33, 32 + y, MOUTH)
    elif mouth == 'none':
        pass  # sleeping, face hidden


def draw_zzz(draw, frame):
    """Draw floating Zzz particles."""
    offsets = [(36, 22), (40, 18), (44, 14)]
    sizes = [1, 1, 2]
    for i, (bx, by) in enumerate(offsets):
        f = (frame + i) % 6
        if f < 3 + i:
            s = sizes[min(i, len(sizes) - 1)]
            alpha = max(0, 255 - f * 40)
            color = (*ZZZ[:3], alpha)
            # Z shape
            if s == 1:
                px(draw, bx, by - f, color)
            else:
                rect(draw, bx, by - f, 3, 1, color)
                px(draw, bx + 2, by + 1 - f, color)
                rect(draw, bx, by + 2 - f, 3, 1, color)


def draw_sparkle(draw, frame):
    """Draw celebration sparkles."""
    positions = [(18, 28), (44, 26), (22, 20), (40, 18), (32, 16)]
    for i, (sx, sy) in enumerate(positions):
        f = (frame + i * 2) % 6
        if f < 3:
            alpha = [255, 180, 100][f]
            c = (*SPARKLE[:3], alpha)
            # Cross sparkle
            px(draw, sx, sy, c)
            px(draw, sx - 1, sy, c)
            px(draw, sx + 1, sy, c)
            px(draw, sx, sy - 1, c)
            px(draw, sx, sy + 1, c)


def draw_sweat(draw, frame):
    """Draw sweat drops for worried state."""
    drops = [(26, 28), (38, 27)]
    for i, (sx, sy) in enumerate(drops):
        f = (frame + i * 3) % 6
        dy = f % 3
        if f < 4:
            px(draw, sx, sy + dy, SWEAT)
            if dy > 0:
                px(draw, sx, sy + dy - 1, (*SWEAT[:3], 100))


def draw_frame(row, col):
    """Generate a single 64x64 frame."""
    img = Image.new('RGBA', (W, H), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    frame = col  # 0-5

    if row == 0:  # idle
        breath = [0, 0, -1, -1, 0, 0][frame]
        blink = frame == 3

        draw_desk(draw)
        draw_monitors(draw)
        draw_chair(draw)
        draw_body_sitting(draw, y_off=breath, arms='desk')
        # Mouse click on frame 2
        arm_state = 'typing_r' if frame == 2 else 'desk'
        if arm_state != 'desk':
            draw_body_sitting(draw, y_off=breath, arms=arm_state)
        draw_head(draw, y_off=breath, blink=blink, look_dir=[0, 0, 1, 0, -1, 0][frame])

    elif row == 1:  # working
        draw_desk(draw)
        flicker = 1 if frame in [2, 5] else 0
        draw_monitors(draw, flicker=flicker)
        draw_chair(draw)
        arms = ['typing_l', 'typing_r', 'typing_l', 'typing_r', 'typing_l', 'typing_r'][frame]
        draw_body_sitting(draw, arms=arms)
        blink = frame == 4
        draw_head(draw, blink=blink, look_dir=[0, 1, 0, -1, 0, 1][frame])

    elif row == 2:  # sleeping
        draw_desk(draw)
        draw_monitors(draw, flicker=2)  # screens off
        draw_chair(draw)
        draw_body_sitting(draw, y_off=1, arms='slumped')
        # Head slumped down on desk
        head_y = 5
        rect(draw, 28, 30 + head_y, 8, 6, HOODIE)  # hood visible
        rect(draw, 29, 31 + head_y, 6, 3, SKIN_SHADOW)  # side of face
        rect(draw, 27, 29 + head_y, 10, 2, HOODIE_LIGHT)  # hood top
        draw_zzz(draw, frame)

    elif row == 3:  # celebrating
        breath = [0, -1, -2, -1, 0, -1][frame]
        draw_desk(draw)
        draw_monitors(draw, left_glow=MONITOR_GREEN, right_glow=MONITOR_GREEN)
        draw_chair(draw)
        arms = 'up' if frame in [1, 2, 3, 4] else 'desk'
        draw_body_sitting(draw, y_off=breath, arms=arms)
        draw_head(draw, y_off=breath, mouth='open' if frame in [1, 2, 3] else 'smile',
                  look_dir=[0, 0, 1, -1, 0, 0][frame])
        draw_sparkle(draw, frame)

    elif row == 4:  # worried
        draw_desk(draw)
        flicker = 1 if frame in [1, 3, 5] else 0
        draw_monitors(draw, left_glow=MONITOR_RED, right_glow=MONITOR_RED, flicker=flicker)
        draw_chair(draw)
        arms = ['typing_l', 'desk', 'typing_r', 'desk', 'typing_l', 'typing_r'][frame]
        draw_body_sitting(draw, arms=arms)
        draw_head(draw, eyes='wide', mouth='flat',
                  look_dir=[0, 1, 1, -1, -1, 0][frame])
        draw_sweat(draw, frame)

    elif row == 5:  # warmup
        draw_desk(draw)
        draw_chair(draw)

        if frame < 2:
            # Monitors off
            draw_monitors(draw, flicker=2)
            # Stretching
            breath = -1 if frame == 1 else 0
            draw_body_sitting(draw, y_off=breath, arms='desk')
            draw_head(draw, y_off=breath, eyes='closed' if frame == 0 else 'open',
                      mouth='open' if frame == 1 else 'flat')
        elif frame < 4:
            # Left monitor turning on
            rect(draw, 11, 30, 14, 12, MONITOR_FRAME)
            rect(draw, 12, 31, 12, 10, MONITOR_SCREEN)
            rect(draw, 16, 42, 4, 2, MONITOR_FRAME)
            if frame >= 2:
                # Glow starting
                for i in range(12):
                    alpha = 60 + (frame - 2) * 80
                    px(draw, 13 + i % 6, 33 + i // 6, (*MONITOR_BLUE[:3], min(alpha, 200)))

            # Right monitor still off
            rect(draw, 39, 30, 14, 12, MONITOR_FRAME)
            rect(draw, 40, 31, 12, 10, MONITOR_SCREEN)
            rect(draw, 44, 42, 4, 2, MONITOR_FRAME)
            if frame == 3:
                for i in range(6):
                    px(draw, 42 + i, 35, (*MONITOR_GREEN[:3], 80))

            draw_body_sitting(draw, arms='desk')
            draw_head(draw, look_dir=-1 if frame == 2 else 1)
        else:
            # Both monitors on
            draw_monitors(draw)
            draw_body_sitting(draw, arms='desk' if frame == 4 else 'typing_l')
            draw_head(draw, look_dir=0, mouth='smile')

    return img


def generate_sprite_sheet():
    """Generate the full 384x384 sprite sheet."""
    sheet = Image.new('RGBA', (SHEET_W, SHEET_H), TRANSPARENT)

    for row in range(ROWS):
        for col in range(COLS):
            frame = draw_frame(row, col)
            sheet.paste(frame, (col * W, row * H))

    return sheet


if __name__ == '__main__':
    sheet = generate_sprite_sheet()

    # Save as PNG file
    out_path = os.path.join(os.path.dirname(__file__), 'sprite-sheet.png')
    sheet.save(out_path, 'PNG', optimize=True)

    # Also output base64
    import io
    buf = io.BytesIO()
    sheet.save(buf, 'PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')

    b64_path = os.path.join(os.path.dirname(__file__), 'sprite-base64.txt')
    with open(b64_path, 'w') as f:
        f.write(b64)

    print(f"Sprite sheet saved to {out_path}")
    print(f"Base64 saved to {b64_path}")
    print(f"PNG size: {buf.tell()} bytes")
    print(f"Base64 length: {len(b64)} chars")
