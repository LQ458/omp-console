from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import Browser, Locator, Page, Route, expect, sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_SESSION_LIST_BASE_URL", "http://127.0.0.1:7761")
SCREEN_DIR = Path(os.environ.get("OMP_CONSOLE_SESSION_LIST_SCREEN_DIR", "/tmp/deck-day/s1-list"))


def api_guard(route: Route) -> None:
    request = route.request
    if "/api/" in request.url and request.method != "GET":
        route.abort()
    else:
        route.continue_()


def open_context_menu(page: Page, row: Locator, mobile: bool) -> None:
    if not mobile:
        row.click(button="right")
        return
    box = row.bounding_box()
    assert box is not None
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    row.dispatch_event("pointerdown", {"pointerId": 41, "pointerType": "touch", "isPrimary": True, "button": 0, "clientX": x, "clientY": y})
    page.wait_for_timeout(540)
    row.dispatch_event("pointerup", {"pointerId": 41, "pointerType": "touch", "isPrimary": True, "button": 0, "clientX": x, "clientY": y})
    page.wait_for_timeout(720)


def capture_theme_states(page: Page, label: str, theme: str, mobile: bool) -> None:
    page.evaluate("theme => { document.documentElement.dataset.palette = 'deck'; document.documentElement.dataset.theme = theme; }", theme)
    page.wait_for_timeout(80)
    row = page.locator('[data-session-id="session-list-fixture"]')
    open_button = row.locator(".dk-card-open")
    page.screenshot(path=str(SCREEN_DIR / f"{label}-{theme}-list.png"))

    open_button.hover()
    page.screenshot(path=str(SCREEN_DIR / f"{label}-{theme}-hovered-row.png"))

    open_context_menu(page, row, mobile)
    menu = row.get_by_role("menu", name="Actions for Generated title")
    expect(menu).to_be_visible()
    page.screenshot(path=str(SCREEN_DIR / f"{label}-{theme}-context-menu.png"))
    page.keyboard.press("Escape")
    expect(menu).to_have_count(0)

    page.get_by_role("button", name="Rename session title").click()
    title_input = page.get_by_role("textbox", name="Edit session title")
    title_input.fill("Header draft")
    page.screenshot(path=str(SCREEN_DIR / f"{label}-{theme}-header-rename.png"))
    title_input.press("Escape")
    expect(page.get_by_role("textbox", name="Edit session title")).to_have_count(0)



def capture_palette_matrix(page: Page, label: str) -> None:
    palettes = ("deck", "graphite", "ocean", "forest", "sepia", "contrast", "custom")
    row = page.locator('[data-session-id="session-list-fixture"]')
    row.locator(".dk-card-open").hover()
    for palette in palettes:
        for theme in ("light", "dark"):
            page.evaluate(
                """({palette, theme}) => {
                    const root = document.documentElement;
                    root.dataset.palette = palette;
                    root.dataset.theme = theme;
                    if (palette === "custom") {
                        root.style.setProperty("--accent-custom-h", "252");
                        root.style.setProperty("--accent-custom-c", "0.13");
                    }
                }""",
                {"palette": palette, "theme": theme},
            )
            page.wait_for_timeout(80)
            page.screenshot(path=str(SCREEN_DIR / f"{label}-palette-{palette}-{theme}-hovered-row.png"))


def run_scenarios(browser: Browser, label: str, context_options: dict[str, object], mobile: bool) -> None:
    context = browser.new_context(**context_options)
    page = context.new_page()
    page.route("**/api/**", api_guard)
    page.set_default_timeout(8000)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    row = page.locator('[data-session-id="session-list-fixture"]')
    expect(row).to_be_visible()

    for theme in ("light", "dark"):
        capture_theme_states(page, label, theme, mobile)

    if not mobile:
        capture_palette_matrix(page, label)

    first_open = row.locator(".dk-card-open")
    second_row = page.locator('[data-session-id="session-list-second"]')
    second_open = second_row.locator(".dk-card-open")
    first_open.focus()
    page.keyboard.press("ArrowDown")
    expect(second_open).to_be_focused()
    page.keyboard.press("Enter")
    expect(second_open).to_have_attribute("aria-current", "true")
    page.keyboard.press("ArrowUp")
    expect(first_open).to_be_focused()
    page.keyboard.press("Enter")
    expect(first_open).to_have_attribute("aria-current", "true")
    page.keyboard.press("Shift+F10")
    keyboard_menu = row.get_by_role("menu", name="Actions for Generated title")
    rename_item = keyboard_menu.get_by_role("menuitem", name="Rename")
    expect(rename_item).to_be_focused()
    page.keyboard.press("ArrowDown")
    expect(keyboard_menu.get_by_role("menuitem", name="Fork")).to_be_focused()
    page.keyboard.press("Escape")
    expect(row.locator(".dk-card-menu-trigger")).to_be_focused()

    unsaved_row = page.locator('[data-session-id="session-list-unsaved"]')
    open_context_menu(page, unsaved_row, mobile)
    unsaved_menu = unsaved_row.get_by_role("menu", name="Actions for Unsaved session")
    expect(unsaved_menu).to_be_visible()
    expect(unsaved_menu.get_by_role("menuitem", name="Fork")).to_have_count(0)
    page.keyboard.press("Escape")

    for theme in ("light", "dark"):
        page.evaluate("theme => { document.documentElement.dataset.theme = theme; }", theme)
        row.locator(".dk-card-line-two").click()
        expect(row.locator(".dk-card-open")).to_have_attribute("aria-current", "true")
        page.screenshot(path=str(SCREEN_DIR / f"{label}-{theme}-selected-row.png"))
    assert page.locator(".session-list-harness").get_attribute("data-opened-session") == "session-list-fixture"

    open_context_menu(page, row, mobile)
    menu = row.get_by_role("menu", name="Actions for Generated title")
    expect(menu).to_be_visible()
    expect(menu.get_by_role("menuitem", name="Fork")).to_be_visible()
    menu.get_by_role("menuitem", name="Open in new pane").click()
    expect(page.locator(".session-list-harness")).to_have_attribute("data-opened-in-new-pane", "true")

    open_context_menu(page, row, mobile)
    menu = row.get_by_role("menu", name="Actions for Generated title")
    menu.get_by_role("menuitem", name="Rename").click()
    rename_input = row.locator(".dk-card-rename input")
    rename_input.fill("Menu renamed title")
    page.locator('[data-session-id="session-list-second"] .dk-card-open').click()
    expect(row.locator(".dk-card-title-text")).to_have_text("Menu renamed title")

    title = row.locator(".dk-card-title-text")
    title.dblclick()
    rename_input = row.locator(".dk-card-rename input")
    rename_input.fill("Double-click renamed title")
    rename_input.press("Enter")
    expect(title).to_have_text("Double-click renamed title")

    header_trigger = page.get_by_role("button", name="Rename session title")
    header_trigger.click()
    header_input = page.get_by_role("textbox", name="Edit session title")
    header_input.fill("Header blurred title")
    row.locator(".dk-card-open").click()
    expect(page.get_by_role("button", name="Rename session title")).to_contain_text("Header blurred title")

    header_trigger = page.get_by_role("button", name="Rename session title")
    header_trigger.click()
    header_input = page.get_by_role("textbox", name="Edit session title")
    header_input.fill("Header saved title")
    header_input.press("Enter")
    expect(page.get_by_role("button", name="Rename session title")).to_contain_text("Header saved title")

    page.get_by_role("button", name="Rename session title").click()
    header_input = page.get_by_role("textbox", name="Edit session title")
    header_input.fill("Discard this title")
    header_input.press("Escape")
    expect(page.get_by_role("button", name="Rename session title")).to_contain_text("Header saved title")

    page.get_by_role("button", name="Rename session title").click()
    header_input = page.get_by_role("textbox", name="Edit session title")
    header_input.fill("")
    header_input.press("Enter")
    expect(page.get_by_role("button", name="Rename session title")).to_contain_text("Generated title")

    context.close()
    palette_note = "; seven-palette light/dark matrix" if not mobile else ""
    print(
        f"PASS {label}: full-row/new-pane open, context and double-click rename, "
        f"header blur/Enter/Escape/empty reset; light/dark screenshots{palette_note}"
    )


def main() -> None:
    SCREEN_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        webkit = playwright.webkit.launch(headless=True)
        try:
            run_scenarios(webkit, "iphone-15-webkit", playwright.devices["iPhone 15"], True)
            run_scenarios(webkit, "desktop-1300x850-webkit", {"viewport": {"width": 1300, "height": 850}}, False)
        finally:
            webkit.close()

    for path in sorted(SCREEN_DIR.glob("*.png")):
        print(path)


if __name__ == "__main__":
    main()
