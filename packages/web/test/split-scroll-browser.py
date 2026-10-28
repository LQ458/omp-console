from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_SPLIT_BASE_URL", "http://127.0.0.1:7650")
CHROMIUM = Path(
    os.environ.get(
        "OMP_CONSOLE_CHROMIUM",
        str(Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1248/chromium_headless_shell-mac-arm64/chrome-headless-shell"),
    )
)
SCREENSHOTS = Path(os.environ.get("OMP_CONSOLE_SCREENSHOT_DIR", "/tmp/deck-night2/out/w3-perf"))
RUNS = 5


def top_entry(page, pane_id: str) -> dict[str, int | str] | None:
    return page.locator(f'.pn-frame[data-pane="{pane_id}"] .tr-root').evaluate("""element => {
        const viewport = element.getBoundingClientRect();
        const row = [...element.querySelectorAll('.tr-vrow')].find(candidate => {
            const box = candidate.getBoundingClientRect();
            return box.bottom > viewport.top + 1 && box.top < viewport.bottom;
        });
        return row === undefined ? null : {
            key: row.dataset.key ?? '',
            position: Number(row.getAttribute('aria-posinset') ?? 0),
        };
    }""")


def wait_for_entry(page, pane_id: str) -> dict[str, int | str]:
    page.wait_for_function(
        """pane => {
            const root = document.querySelector(`.pn-frame[data-pane="${pane}"] .tr-root`);
            if (!(root instanceof HTMLElement)) return false;
            const viewport = root.getBoundingClientRect();
            return [...root.querySelectorAll('.tr-vrow')].some(row => {
                const box = row.getBoundingClientRect();
                return box.bottom > viewport.top + 1 && box.top < viewport.bottom;
            });
        }""",
        arg=pane_id,
    )
    entry = top_entry(page, pane_id)
    if entry is None:
        raise AssertionError(f"pane {pane_id} has no visible transcript entry")
    return entry


def assert_position_stable(before: dict[str, int | str], after: dict[str, int | str], label: str) -> None:
    delta = abs(int(after["position"]) - int(before["position"]))
    if delta > 1:
        raise AssertionError(f"{label} moved from {before} to {after}")


def assert_follows_bottom(page, pane_id: str, label: str) -> int:
    root = page.locator(f'.pn-frame[data-pane="{pane_id}"] .tr-root')
    gaps = root.evaluate("""async root => {
        const gaps = [];
        const deadline = performance.now() + 3000;
        do {
            gaps.push(root.scrollHeight - root.scrollTop - root.clientHeight);
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (performance.now() < deadline);
        return gaps;
    }""")
    if len(gaps) < 20:
        raise AssertionError(f"{label} sampled only {len(gaps)} frames")
    worst = max(gaps)
    if worst >= 50:
        raise AssertionError(f"{label} stopped following the bottom; max gap {worst}px, samples {gaps}")
    return worst


def resolve_session(page) -> str:
    explicit = os.environ.get("OMP_CONSOLE_SPLIT_SESSION")
    if explicit:
        return explicit
    response = page.request.get(f"{BASE_URL}/api/sessions")
    if not response.ok:
        raise AssertionError(f"session listing failed: {response.status}")
    live = response.json().get("live", [])
    if not live:
        raise AssertionError("mock daemon has no live session")
    return str(live[0]["id"])

def main() -> None:
    if not CHROMIUM.is_file():
        raise RuntimeError(f"Chromium headless shell is missing: {CHROMIUM}")
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROMIUM))
        try:
            for run in range(1):
                context = browser.new_context(viewport={"width": 1400, "height": 900})
                page = context.new_page()
                try:
                    page.goto(f"{BASE_URL}/?bench#session=bench-stream", wait_until="domcontentloaded")
                    page.locator(".pn-frame .tr-root").wait_for()
                    page.wait_for_function("""async () => {
                        const response = await fetch('/api/sessions');
                        const sessions = await response.json();
                        return sessions.live.find(session => session.id === 'bench-stream')?.state === 'streaming';
                    }""")
                    page.wait_for_function("window.__deckBench !== undefined")
                    page.evaluate("window.__deckBench.start()")
                    original = page.locator(".pn-frame:has(.tr-root)").first
                    pane_id = original.get_attribute("data-pane")
                    if pane_id is None:
                        raise AssertionError("streaming pane has no data-pane id")
                    streaming_root = page.locator(f'.pn-frame[data-pane="{pane_id}"] .tr-root')
                    streaming_root.evaluate("root => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    before_split_gap = assert_follows_bottom(page, pane_id, "before split")

                    page.get_by_role("button", name="split pane right").click()
                    page.wait_for_function("document.querySelectorAll('.pn-frame').length === 2")
                    after_split_gap = assert_follows_bottom(page, pane_id, "after split")
                    bench = page.evaluate("window.__deckBench.stop()")
                    token_paints = bench["tokenToPaintMs"]["n"]
                    if token_paints <= 0:
                        raise AssertionError(f"bench-stream recorded no token-to-paint samples: {bench}")
                    if run == 0:
                        page.screenshot(path=str(SCREENSHOTS / "split-scroll-stream-after.png"))
                    print(
                        f"PASS streaming: bottom gaps {before_split_gap}px/{after_split_gap}px; "
                        f"token-to-paint samples {token_paints}"
                    )
                finally:
                    context.close()
            for run in range(RUNS):
                context = browser.new_context(viewport={"width": 1400, "height": 900})
                page = context.new_page()
                try:
                    session_id = resolve_session(page)
                    page.goto(f"{BASE_URL}/#session={session_id}", wait_until="domcontentloaded")
                    page.locator(".pn-frame .tr-root").wait_for()
                    page.wait_for_function("""() => {
                        const row = document.querySelector('.pn-frame .tr-root .tr-vrow');
                        return row !== null && Number(row.getAttribute('aria-setsize') ?? 0) >= 1;
                    }""")
                    scroller = page.locator('.pn-frame .tr-root').first
                    scroller.evaluate("""element => {
                        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
                        element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) * 0.42);
                        element.dispatchEvent(new Event('scroll', { bubbles: true }));
                    }""")
                    original = page.locator('.pn-frame:has(.tr-root)').first
                    pane_id = original.get_attribute("data-pane")
                    if pane_id is None:
                        raise AssertionError("session pane has no data-pane id")
                    before = wait_for_entry(page, pane_id)

                    page.get_by_role("button", name="split pane right").click()
                    page.wait_for_function("document.querySelectorAll('.pn-frame').length === 2")
                    page.wait_for_timeout(750)
                    first_split = wait_for_entry(page, pane_id)
                    assert_position_stable(before, first_split, "first split")

                    page.locator(f'.pn-frame[data-pane="{pane_id}"]').click(position={"x": 20, "y": 20})
                    page.get_by_role("button", name="split pane right").click()
                    page.wait_for_function("document.querySelectorAll('.pn-frame').length === 3")
                    page.wait_for_timeout(750)
                    later_split = wait_for_entry(page, pane_id)
                    assert_position_stable(before, later_split, "later split")

                    if run == 0:
                        page.screenshot(path=str(SCREENSHOTS / "split-scroll-after.png"))
                    print(f"PASS {run + 1}/{RUNS}: {before['key']} -> {first_split['key']} -> {later_split['key']}")
                finally:
                    context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
