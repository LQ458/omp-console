#!/usr/bin/env python3
"""Browser-level theme contracts and palette screenshots against a local mock daemon.

Usage: python3 test/theme-browser.py <base-url> <session-link|-> <output-dir>
The session link is read from sandbox mock-daemon JSON on stdin; browser requests to non-GET /api routes are blocked.
"""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

PALETTES = ("deck", "graphite", "ocean", "forest", "sepia", "contrast", "custom")
THEMES = ("light", "dark")
VIEWPORTS = (("phone", 393, 852), ("desktop", 1300, 850))

CONTRAST_PROBE = """() => {
  const root = document.documentElement;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = value => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const token = name => getComputedStyle(root).getPropertyValue(name).trim();
  const results = [];
  for (const palette of ['deck', 'graphite', 'ocean', 'forest', 'sepia', 'contrast', 'custom']) {
    for (const theme of ['light', 'dark']) {
      root.dataset.palette = palette;
      root.dataset.theme = theme;
      const fg = rgb(token('--fg'));
      const muted = rgb(token('--fg-muted'));
      const faint = rgb(token('--fg-faint'));
      const accentText = rgb(token('--accent-fg'));
      results.push({
        palette,
        theme,
        surfaces: ['--bg', '--panel', '--bg-raised'].map(name => rgb(token(name))),
        foreground: fg,
        muted,
        faint,
        accentText,
        accents: ['--accent', '--accent-a', '--accent-b'].map(name => rgb(token(name))),
      });
    }
  }
  return results;
}"""


def luminance(rgb: list[int]) -> float:
    channels = [value / 255 for value in rgb]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(first: list[int], second: list[int]) -> float:
    a, b = luminance(first), luminance(second)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


async def block_api_writes(route) -> None:
    request = route.request
    if "/api/" in request.url and request.method != "GET":
        await route.abort()
    else:
        await route.continue_()


async def check_contrast(page) -> int:
    rows = await page.evaluate(CONTRAST_PROBE)
    checks = 0
    failures = []
    for row in rows:
        label = f"{row['palette']}/{row['theme']}"
        for surface in row["surfaces"]:
            checks += 1
            ratio = contrast(row["foreground"], surface)
            if ratio < 4.5:
                failures.append(f"{label} fg/background {ratio:.2f}:1")
            checks += 1
            ratio = contrast(row["muted"], surface)
            if ratio < 4.5:
                failures.append(f"{label} muted/background {ratio:.2f}:1")
            checks += 1
            ratio = contrast(row["faint"], surface)
            if ratio < 3:
                failures.append(f"{label} faint/background {ratio:.2f}:1")
        for accent in row["accents"]:
            checks += 1
            ratio = contrast(row["accentText"], accent)
            if ratio < 4.5:
                failures.append(f"{label} accent button {ratio:.2f}:1")
    if failures:
        raise AssertionError("Theme contrast failures: " + "; ".join(failures))
    return checks


async def check_motion_precedence(page) -> None:
    result = await page.evaluate("""() => {
      const root = document.documentElement;
      root.dataset.motion = 'lively';
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;transition:opacity var(--dur-base);animation:rise var(--dur-base) linear';
      document.body.append(probe);
      const livelyDuration = getComputedStyle(root).getPropertyValue('--dur-base').trim();
      root.dataset.motion = 'off';
      const offDuration = getComputedStyle(root).getPropertyValue('--dur-base').trim();
      const offTransition = getComputedStyle(probe).transitionDuration;
      const offAnimation = getComputedStyle(probe).animationDuration;
      root.dataset.motion = 'lively';
      const transition = getComputedStyle(probe).transitionDuration;
      const animation = getComputedStyle(probe).animationDuration;
      probe.remove();
      return { livelyDuration, offDuration, offTransition, offAnimation, transition, animation };
    }""")
    if (
        result["livelyDuration"] not in ("200ms", ".2s", "0.2s")
        or result["offDuration"] not in ("0ms", "0s")
        or result["offTransition"] != "0s"
        or result["offAnimation"] != "0s"
    ):
        raise AssertionError(f"motion token precedence failed: {result}")
    await page.emulate_media(reduced_motion="reduce")
    forced = await page.evaluate("""() => {
      const root = document.documentElement;
      root.dataset.motion = 'lively';
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;transition:opacity var(--dur-base);animation:rise var(--dur-base) linear';
      document.body.append(probe);
      const result = {
        token: getComputedStyle(root).getPropertyValue('--dur-base').trim(),
        transition: getComputedStyle(probe).transitionDuration,
        animation: getComputedStyle(probe).animationDuration,
      };
      probe.remove();
      return result;
    }""")
    await page.emulate_media(reduced_motion="no-preference")
    if forced["token"] not in ("0ms", "0s") or forced["transition"] != "0s" or forced["animation"] != "0s":
        raise AssertionError(f"reduced motion did not force motion off: {forced}")


def local_join_confirmation(session_link: str) -> str | None:
    candidate = session_link if "://" in session_link else f"ws://{session_link}"
    parsed = urlsplit(candidate)
    if parsed.hostname != "127.0.0.1" or parsed.port is None:
        return None
    return f"Join a session hosted at {parsed.hostname}:{parsed.port}?"


async def capture_browser(engine_name: str, browser_type, base_url: str, session_link: str, out_dir: Path, chromium_path: Path | None = None) -> int:
    launch_options = {"headless": True}
    if chromium_path is not None:
        launch_options["executable_path"] = str(chromium_path)
    browser = await browser_type.launch(**launch_options)
    context = await browser.new_context(viewport={"width": 1300, "height": 850}, device_scale_factor=1)
    await context.route("**/api/**", block_api_writes)
    confirmation = json.dumps(local_join_confirmation(session_link))
    await context.add_init_script(f"window.confirm = message => message === {confirmation};")
    page = await context.new_page()
    await page.goto(f"{base_url}/#{session_link}", wait_until="domcontentloaded")
    await page.get_by_text("Live", exact=True).wait_for(timeout=15000)
    await page.wait_for_timeout(1800)
    await page.emulate_media(reduced_motion="no-preference")
    contrast_checks = await check_contrast(page)
    await check_motion_precedence(page)
    settings_page = await context.new_page()
    await settings_page.goto(base_url, wait_until="domcontentloaded")
    await settings_page.locator('button[aria-label="global settings"]').wait_for(timeout=15000)
    captures = 0

    for device, width, height in VIEWPORTS:
        settings_button = "global settings" if device != "phone" else "settings"
        await page.set_viewport_size({"width": width, "height": height})
        await settings_page.set_viewport_size({"width": width, "height": height})
        for palette in PALETTES:
            for theme in THEMES:
                await page.evaluate("""prefs => {
                  const root = document.documentElement;
                  root.dataset.theme = prefs.theme;
                  root.dataset.palette = prefs.palette;
                  root.dataset.motion = 'calm';
                  root.style.colorScheme = prefs.theme;
                  root.style.setProperty('--accent-custom-h', '344.18197813294347');
                  root.style.setProperty('--accent-custom-c', '0.20707357619289016');
                }""", {"theme": theme, "palette": palette})
                await settings_page.evaluate("""prefs => {
                  localStorage.setItem('omp-console-theme', prefs.theme);
                  localStorage.setItem('omp-console-palette', prefs.palette);
                  localStorage.setItem('omp-console-motion', 'calm');
                  localStorage.setItem('omp-console-custom-accent', JSON.stringify({
                    hex: '#d946a7', hue: 344.18197813294347, chroma: 0.20707357619289016
                  }));
                }""", {"theme": theme, "palette": palette})
                await settings_page.reload(wait_until="domcontentloaded")
                await settings_page.wait_for_timeout(1500)
                session_path = out_dir / f"{engine_name}-{palette}-{theme}-{device}-session.png"
                await page.screenshot(path=str(session_path), full_page=False)
                await settings_page.locator(f'button[aria-label="{settings_button}"]').click()
                appearance = settings_page.locator(".dk-settings-appearance")
                await appearance.scroll_into_view_if_needed(timeout=10000)
                if palette == "custom" and device == "phone" and theme == "light":
                    await settings_page.locator('input[aria-label="Custom accent color"]').evaluate("""input => {
                      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                      setter.call(input, '#2679d8');
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                    }""")
                    await settings_page.wait_for_timeout(100)
                    converted = await settings_page.evaluate("""() => ({
                      saved: JSON.parse(localStorage.getItem('omp-console-custom-accent')),
                      hue: document.documentElement.style.getPropertyValue('--accent-custom-h'),
                      chroma: document.documentElement.style.getPropertyValue('--accent-custom-c'),
                    })""")
                    if converted["saved"]["hex"] != "#2679d8" or not converted["hue"] or not converted["chroma"]:
                        raise AssertionError(f"custom color was not converted and applied: {converted}")
                settings_path = out_dir / f"{engine_name}-{palette}-{theme}-{device}-settings.png"
                await settings_page.screenshot(path=str(settings_path), full_page=False)
                captures += 2

    await settings_page.set_viewport_size({"width": 1300, "height": 850})
    await settings_page.goto(base_url, wait_until="domcontentloaded")
    await settings_page.wait_for_timeout(400)
    second = await context.new_page()
    await second.goto(base_url, wait_until="domcontentloaded")
    await second.wait_for_function("document.documentElement.dataset.palette !== undefined")
    await settings_page.locator('button[aria-label="global settings"]').click()
    await settings_page.get_by_role("radio", name="Ocean").click()
    await second.wait_for_function("document.documentElement.dataset.palette === 'ocean'", timeout=10000)
    await second.close()
    await settings_page.close()
    await context.close()
    await browser.close()
    return contrast_checks + captures


async def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: theme-browser.py <base-url> <session-link|-> <output-dir>")
    base_url = sys.argv[1].rstrip("/")
    session_link = json.load(sys.stdin)["link"] if sys.argv[2] == "-" else sys.argv[2].lstrip("#")
    out_dir = Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    chrome_candidates = sorted(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-1248/*/chrome-headless-shell"))
    if not chrome_candidates:
        raise SystemExit("Chromium headless shell 1248 not found under ~/Library/Caches/ms-playwright")

    try:
        async with async_playwright() as playwright:
            webkit_count = await capture_browser("webkit", playwright.webkit, base_url, session_link, out_dir)
            chromium_count = await capture_browser("chromium", playwright.chromium, base_url, session_link, out_dir, chrome_candidates[-1])
    except Exception as error:
        if isinstance(error, AssertionError):
            raise
        raise SystemExit(f"Browser exercise failed: {type(error).__name__}; message suppressed to avoid exposing sandbox details") from None
    print(f"PASS: contrast checks and reduced-motion precedence; {webkit_count} WebKit checks/captures; {chromium_count} Chromium checks/captures")
    print(f"Screenshots: {out_dir}")


if __name__ == "__main__":
    asyncio.run(main())
