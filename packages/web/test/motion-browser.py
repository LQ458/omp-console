from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_MOTION_BASE_URL", "http://127.0.0.1:7760")
SCREEN_DIR = Path(os.environ.get("OMP_CONSOLE_MOTION_SCREEN_DIR", "/tmp/deck-day/t2-motion/screens"))


def api_guard(route: Route) -> None:
    if route.request.method != "GET":
        route.abort()
    else:
        route.continue_()


def touch_pointer(page: Page, locator, event: str, pointer_id: int, x: float, y: float) -> None:
    locator.dispatch_event(
        event,
        {
            "pointerId": pointer_id,
            "pointerType": "touch",
            "isPrimary": True,
            "button": 0,
            "clientX": x,
            "clientY": y,
        },
    )


def run_scenarios(browser: Browser, label: str, context_options: dict[str, object]) -> None:
    context = browser.new_context(**context_options)
    context.add_init_script("Element.prototype.setPointerCapture = function () {};")
    page = context.new_page()
    page.route("**/api/**", api_guard)
    page.set_default_timeout(8000)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    row = page.locator('[data-session-id="motion-archive"]')
    expect(row).to_be_visible()

    box = row.bounding_box()
    assert box is not None
    start_x = box["x"] + box["width"] * 0.75
    start_y = box["y"] + box["height"] / 2
    touch_pointer(page, row, "pointerdown", 41, start_x, start_y)
    page.wait_for_timeout(280)
    touch_pointer(page, row, "pointermove", 41, start_x - 64, start_y)
    page.wait_for_timeout(240)
    touch_pointer(page, row, "pointerup", 41, start_x - 64, start_y)
    archive = row.locator(".dk-row-swipe-actions").get_by_role("button", name="Archive")
    expect(archive).to_be_visible()
    page.screenshot(path=str(SCREEN_DIR / f"{label}-row-swipe.png"))

    start_height = row.evaluate("element => element.getBoundingClientRect().height")
    archive.click()
    expect(row).to_have_attribute("data-leaving", "true")
    page.wait_for_timeout(45)
    middle_height = row.evaluate("element => element.getBoundingClientRect().height")
    assert 0 < middle_height < start_height, f"archive row did not visibly collapse: {start_height} -> {middle_height}"
    page.screenshot(path=str(SCREEN_DIR / f"{label}-archive-collapse.png"))
    expect(row).to_have_count(0, timeout=1500)

    page.reload(wait_until="domcontentloaded")
    page.get_by_role("button", name="Open session picker").click()
    expect(page.locator(".dk-sheet")).to_be_visible()
    workspace = page.locator(".dk-new-option").filter(has_text="motion-demo").first
    workspace.click()
    expect(page.get_by_text("Starting session…")).to_be_visible()
    page.screenshot(path=str(SCREEN_DIR / f"{label}-create-pending.png"))

    page.reload(wait_until="domcontentloaded")
    page.get_by_role("button", name="Open session picker").click()
    sheet = page.locator(".dk-sheet")
    expect(sheet).to_be_visible()
    page.wait_for_timeout(240)
    initial_y = sheet.evaluate("element => element.getBoundingClientRect().y")
    header = page.locator(".dk-sheet-head h2")
    header_box = header.bounding_box()
    assert header_box is not None
    x = header_box["x"] + header_box["width"] / 2
    y = header_box["y"] + header_box["height"] / 2
    touch_pointer(page, header, "pointerdown", 51, x, y)
    page.wait_for_timeout(120)
    touch_pointer(page, header, "pointermove", 51, x, y + 70)
    expect(sheet).to_have_attribute("data-dragging", "true")
    page.wait_for_timeout(100)
    dragged_y = sheet.evaluate("element => element.getBoundingClientRect().y")
    assert dragged_y > 30, f"sheet did not follow the drag: y={dragged_y}"
    page.screenshot(path=str(SCREEN_DIR / f"{label}-sheet-drag.png"))

    page.wait_for_timeout(120)
    touch_pointer(page, header, "pointerup", 51, x, y + 70)
    expect(sheet).not_to_have_attribute("data-dragging", "true")
    page.wait_for_timeout(260)
    sprung_y = sheet.evaluate("element => element.getBoundingClientRect().y")
    assert abs(sprung_y - initial_y) < 3, f"sheet did not spring back: {initial_y} -> {sprung_y}"

    header_box = header.bounding_box()
    assert header_box is not None
    close_x = header_box["x"] + header_box["width"] / 2
    close_y = header_box["y"] + header_box["height"] / 2
    touch_pointer(page, header, "pointerdown", 52, close_x, close_y)
    page.wait_for_timeout(50)
    touch_pointer(page, header, "pointermove", 52, close_x, close_y + 320)
    touch_pointer(page, header, "pointerup", 52, close_x, close_y + 320)
    expect(sheet).to_have_count(0, timeout=2000)
    context.close()

    print(f"PASS {label}: row swipe, measured archive collapse, create pending, sheet drag/spring/close")


def main() -> None:
    SCREEN_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        webkit = playwright.webkit.launch(headless=True)
        try:
            run_scenarios(webkit, "iphone-15-webkit", playwright.devices["iPhone 15"])
        finally:
            webkit.close()

        candidates = sorted(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-1248/*/chrome-headless-shell"))
        if not candidates:
            raise RuntimeError("Chromium headless shell 1248 is not installed")
        chromium = playwright.chromium.launch(headless=True, executable_path=str(candidates[0]))
        try:
            run_scenarios(chromium, "desktop-chromium", {"viewport": {"width": 1440, "height": 900}})
        finally:
            chromium.close()

    for path in sorted(SCREEN_DIR.glob("*.png")):
        print(path)


if __name__ == "__main__":
    main()
