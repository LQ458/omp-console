from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_SCROLL_BASE_URL", "http://127.0.0.1:7654")
CHROMIUM = Path(
    os.environ.get(
        "OMP_CONSOLE_CHROMIUM",
        str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1248/chromium_headless_shell-mac-arm64/chrome-headless-shell"),
    )
)


def main() -> None:
    if not CHROMIUM.is_file():
        raise RuntimeError(f"Chromium headless shell is missing: {CHROMIUM}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROMIUM))
        try:
            page = browser.new_page(viewport={"width": 900, "height": 700})
            page.goto(BASE_URL, wait_until="domcontentloaded")
            scroller = page.locator("[data-deck-scroller]")
            scroller.wait_for()
            page.wait_for_function("document.querySelector('[data-deck-scroller]').scrollHeight > 30000")
            scroller.evaluate("element => { element.scrollTop = 22000; element.dispatchEvent(new Event('scroll', { bubbles: true })); }")
            page.wait_for_function("document.querySelector('[data-testid=saved-scroll-anchor]').textContent !== ''")
            before_key = scroller.evaluate("""element => {
                const viewport = element.getBoundingClientRect();
                return [...element.querySelectorAll('.tr-vrow')].find(row => {
                    const box = row.getBoundingClientRect();
                    return box.bottom > viewport.top + 1 && box.top < viewport.bottom;
                })?.dataset.key ?? null;
            }""")
            if before_key is None:
                raise AssertionError("no visible transcript entry before remount")

            page.get_by_role("button", name="Toggle split panes").click()
            page.wait_for_function("document.querySelector('main').dataset.paneMode === 'split'")
            page.wait_for_timeout(200)
            after_key = page.locator("[data-deck-scroller]").evaluate("""element => {
                const viewport = element.getBoundingClientRect();
                return [...element.querySelectorAll('.tr-vrow')].find(row => {
                    const box = row.getBoundingClientRect();
                    return box.bottom > viewport.top + 1 && box.top < viewport.bottom;
                })?.dataset.key ?? null;
            }""")
            if after_key != before_key:
                raise AssertionError(f"transcript entry changed across pane remount: {before_key} -> {after_key}")
            saved = page.locator("[data-testid=saved-scroll-anchor]").text_content()
            if saved != before_key:
                raise AssertionError(f"saved entry anchor changed: {before_key} -> {saved}")
            print(f"PASS: transcript entry anchor survived pane remount ({before_key})")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
