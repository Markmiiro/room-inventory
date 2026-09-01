"""Render each Stitch mockup at 390px phone width into screenshots/.

Headless Chrome captures each page in one pass. The interactive browser cannot:
its viewport is shorter than most of these screens, and scaling them down to fit
produces a design target nobody can read.

Each page is rendered at its own measured height rather than a fixed one, so
that position:fixed furniture — a bottom bar, a floating action button — lands
at the bottom of the *page* instead of floating partway down a taller window.

The heights are `document.documentElement.scrollHeight` at 390px wide, plus a
small pad. Measure with a short viewport: every mockup puts `min-h-screen` on
the body, so a tall window makes the page report the window's height instead of
its own.

The mockups pull Tailwind and their fonts from CDNs, so this needs a network.
That is fine: these are reference renders, not part of the app, which bundles
both locally per SPEC 9. Re-measure with _measure_heights.js if a mockup changes.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

CHROME = "/usr/bin/google-chrome"
BASE = "http://127.0.0.1:8090"
ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "screenshots"

WIDTH = 390  # the phone width the app is designed against
SCALE = 2    # capture at 2x so the text stays legible when read back

# Stitch directory -> (screen name from SPEC 11, measured page height at 390px).
# The theme's own surfaces and its primary green. Every mockup paints a large
# area in at least one of them; a page whose tailwind.config failed to apply
# falls back to Tailwind's defaults and comes out white on white.
THEME_COLOURS = {
    (247, 250, 245),  # surface
    (244, 247, 242),  # background
    (21, 66, 18),     # primary
}
MIN_THEME_SHARE = 0.03


SCREENS = [
    ("rooms_home_final", "01-rooms", 1485),
    ("room_detail", "02-room-detail", 733),
    ("record_detail_corrected", "03-record-detail", 1588),
    ("animals_list", "04-animals-list", 731),
    ("move_flow_final", "05-move", 884),
    ("add_or_purchase_final", "06-add-purchase", 2158),
    ("sell_screen_final", "07-sell", 862),
    ("log_death", "08-log-death", 1300),
    ("alerts", "09-alerts", 1104),
    ("calendar", "10-calendar", 1105),
    ("health_final", "11-health", 884),
    ("money_summary_final", "12-money-summary", 1944),
    # This one is an `h-screen flex flex-col overflow-hidden` shell rather than a
    # page that grows with its content, so it has no intrinsic height: it fills
    # whatever viewport it is given. Rendered at a real phone height instead.
    ("expenses", "13-expenses", 844),
    ("add_expense", "13a-add-expense", 1287),
    ("manage_categories", "13b-manage-categories", 616),
    ("more_final", "14-more", 1119),
]

# All fourteen of SPEC 11 now have a mockup.
MISSING: list[str] = []


# One mockup — room_detail — ships a truncated `tailwind.config`: its `body-md`
# font-size array is closed with `}` instead of `]`, and the config object is
# left one closing brace short. The Play CDN evaluates that config as a script,
# so the SyntaxError throws away the whole theme — every custom colour, font and
# size falls back to Tailwind's defaults and the page renders unstyled without
# the render itself failing. It is repaired here rather than by hand because
# `extracted/` is gitignored and rebuilt from the zips, which would bring the
# broken config straight back.
MALFORMED_FONT_SIZE = re.compile(r'(\[\s*"[\d.]+px",\s*\{[^{}]*\}\s*)\}')


def repair_config(path: Path) -> bool:
    """Fix the malformed font-size array in place. True if anything changed."""
    source = path.read_text()
    config = re.search(r'<script id="tailwind-config">(.*?)</script>', source, re.S)
    if not config:
        return False
    original = config.group(1)
    fixed, count = MALFORMED_FONT_SIZE.subn(r"\1]", original)
    # The config holds no braces inside its strings, so a plain count is enough
    # to tell how many the truncation dropped.
    missing = fixed.count("{") - fixed.count("}")
    if missing > 0:
        fixed = fixed.rstrip() + "\n" + "}" * missing + "\n"
    if not count and missing <= 0:
        return False
    path.write_text(source.replace(original, fixed, 1))
    return True


def render(directory: str, name: str, height: int) -> dict:
    repaired = repair_config(ROOT / "extracted" / "stitch_room_inventory_manager" / directory / "code.html")
    target = OUT / f"{name}.png"
    subprocess.run(
        [
            CHROME, "--headless", "--disable-gpu", "--no-sandbox",
            "--hide-scrollbars", f"--force-device-scale-factor={SCALE}",
            f"--window-size={WIDTH},{height}",
            "--virtual-time-budget=10000",
            f"--screenshot={target}", f"{BASE}/{directory}/code.html",
        ],
        capture_output=True, text=True, timeout=120,
    )
    if not target.exists() or target.stat().st_size == 0:
        return {"screen": name, "ok": False}

    from PIL import Image

    with Image.open(target) as image:
        size = image.size
        share = theme_share(image)

    # A mockup whose config failed renders perfectly happily — it is just
    # unstyled, and nothing about the subprocess says so. Checking the pixels is
    # the only way to tell from here, and an unchecked render of the wrong thing
    # is worse than no render at all.
    result = {"screen": name, "ok": share >= MIN_THEME_SHARE,
              "px": f"{size[0]}x{size[1]}",
              "css_px": f"{size[0] // SCALE}x{size[1] // SCALE}",
              "theme_share": round(share, 4)}
    if not result["ok"]:
        result["problem"] = "theme not applied — check the tailwind config"
    if repaired:
        result["repaired_config"] = True
    return result


def theme_share(image) -> float:
    """How much of the render is painted in the theme's own colours."""
    from PIL import Image

    # Sampled small: this is a proportion, not a measurement.
    small = image.convert("RGB").resize((image.width // 8 or 1, image.height // 8 or 1))
    pixels = list(small.getdata())
    hits = sum(1 for pixel in pixels if pixel in THEME_COLOURS)
    return hits / len(pixels) if pixels else 0.0


def main() -> int:
    OUT.mkdir(exist_ok=True)
    results = [render(*screen) for screen in SCREENS]
    print(json.dumps({"rendered": results, "no_mockup_available": MISSING}, indent=1))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
