from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_MATH_BASE_URL", "http://127.0.0.1:7653")
CHROMIUM = Path(
    os.environ.get(
        "OMP_CONSOLE_CHROMIUM",
        str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1248/chromium_headless_shell-mac-arm64/chrome-headless-shell"),
    )
)
SCREENSHOTS = Path(os.environ.get("OMP_CONSOLE_SCREENSHOT_DIR", "/tmp/deck-night2/out/w3-perf"))

def main() -> None:
    if not CHROMIUM.is_file():
        raise RuntimeError(f"Chromium headless shell is missing: {CHROMIUM}")
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROMIUM))
        try:
            page = browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(BASE_URL, wait_until="domcontentloaded")
            first_stage = page.locator('[data-stream-stage="1"]')
            first_stage.locator("math").wait_for()
            assert first_stage.locator("math").count() == 1
            assert first_stage.locator(".tr-math-pending").count() == 0
            figure = first_stage.locator('.tr-fig[data-fig="svg"]')
            figure.wait_for()
            figure.locator(".tr-fig-img").wait_for()
            assert figure.get_attribute("class") is not None and "tr-fig--drawn" in (figure.get_attribute("class") or "")

            page.get_by_role("button", name="Continue stream").click()
            second_stage = page.locator('[data-stream-stage="2"]')
            second_stage.locator("math").nth(1).wait_for()
            assert second_stage.locator("math").count() == 2
            assert second_stage.locator(".tr-math-pending").count() == 0
            second_stage.locator(".tr-md table").wait_for()
            page.wait_for_timeout(200)
            assert page.locator('.tr-fig[data-fig="chart"]').count() == 0
            assert not errors, f"page errors: {errors}"
            print("PASS: streaming inline/display math and SVG figures hydrate before completion; non-chart table has no chart placeholder")
            offline = browser.new_page()
            offline.route("**/index.html", lambda route: route.abort())
            offline_navigations: list[str] = []
            offline.on("framenavigated", lambda frame: offline_navigations.append(frame.url) if frame == offline.main_frame else None)
            offline.goto(f"{BASE_URL}?fallback", wait_until="domcontentloaded")
            offline.get_by_text("Deck was updated").wait_for()
            retry = offline.get_by_role("button", name="Retry")
            retry.wait_for()
            offline.screenshot(path=str(SCREENSHOTS / "lazy-retry-fallback.png"))
            navigation_count = len(offline_navigations)
            retry.click()
            offline.get_by_role("button", name="Retry").wait_for(timeout=5000)
            assert len(offline_navigations) == navigation_count, f"offline Retry navigated: {offline_navigations}"
            print("PASS: Retry keeps the fallback while index.html is unreachable")

            reachable = browser.new_page()
            reachable.add_init_script("""(() => {
                const key = "omp-console-test-index-cache-modes";
                const modes = JSON.parse(sessionStorage.getItem(key) ?? "[]");
                const nativeFetch = window.fetch.bind(window);
                window.fetch = (input, init) => {
                    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url, window.location.href);
                    if (url.pathname.endsWith("/index.html")) {
                        modes.push(init?.cache ?? null);
                        sessionStorage.setItem(key, JSON.stringify(modes));
                    }
                    return nativeFetch(input, init);
                };
            })();""")
            reachable.route(
                "**/index.html",
                lambda route: route.fulfill(
                    status=200,
                    content_type="text/html",
                    body='<meta name="omp-console-build-version" content="development">',
                ),
            )
            reachable.goto(f"{BASE_URL}?fallback", wait_until="domcontentloaded")
            reachable.get_by_role("button", name="Retry").wait_for()
            with reachable.expect_navigation(wait_until="domcontentloaded", timeout=5000):
                reachable.get_by_role("button", name="Retry").click()
            reachable.get_by_role("button", name="Retry").wait_for()
            cache_modes = reachable.evaluate("JSON.parse(sessionStorage.getItem('omp-console-test-index-cache-modes') ?? '[]')")
            assert cache_modes and all(mode == "no-store" for mode in cache_modes), f"index fetch cache modes: {cache_modes}"
            print(f"PASS: reachable Retry reloads once after no-store index checks ({len(cache_modes)} requests)")

            stale = browser.new_page()
            stale.route(
                "**/index.html",
                lambda route: route.fulfill(
                    status=200,
                    content_type="text/html",
                    body='<meta name="omp-console-build-version" content="newbuild999">',
                ),
            )
            stale.goto(f"{BASE_URL}?fallback&stale", wait_until="domcontentloaded")
            stale.get_by_text("Deck was updated").wait_for()
            alert = stale.get_by_role("alert")
            action = alert.get_by_role("button")
            action.wait_for()
            assert action.inner_text() == "Reload", f"stale shell offered {action.inner_text()!r}"
            assert "server may still be restarting" not in alert.inner_text().lower()
            print("PASS: a previously reloaded stale shell offers Reload")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
