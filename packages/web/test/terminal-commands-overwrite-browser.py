from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("OMP_CONSOLE_OMFG_BASE_URL", "http://127.0.0.1:7667")
SCREENSHOT = Path(os.environ.get("OMP_CONSOLE_OMFG_SCREENSHOT", "/tmp/deck-day2/out/y3-agents/omfg-overwrite.png"))


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.webkit.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1000, "height": 780})
            response = page.request.get(f"{BASE_URL}/api/sessions")
            if not response.ok:
                raise RuntimeError(f"mock daemon session list returned {response.status}")
            sessions = response.json().get("live", [])
            if not sessions:
                raise RuntimeError("mock daemon has no live session to open")
            session = sessions[0]
            page.goto(f"{BASE_URL}/#session={quote(session['id'])}", wait_until="domcontentloaded")
            page.locator("[data-deck-scroller]").wait_for()
            page.wait_for_timeout(250)
            page.evaluate(
                """() => window.dispatchEvent(new CustomEvent("omp-console:open-panel", {
                    detail: { panel: "omfg", command: "omfg", args: "Avoid an ungrounded answer" }
                }))"""
            )

            rule = page.get_by_label("Rule · mock-rule.md")
            rule.wait_for()
            save = page.get_by_role("button", name="Accept and save")
            save.click()
            page.get_by_text(
                "Rule already exists at /mock/project/.omp/rules/mock-rule.md; accept again to replace it.",
                exact=True,
            ).wait_for()
            project_confirm = page.get_by_role("button", name="Confirm overwrite")
            project_confirm.wait_for()
            if project_confirm.get_attribute("title") != "Replace /mock/project/.omp/rules/mock-rule.md":
                raise AssertionError("project overwrite confirmation did not identify its target path")

            page.get_by_label("Save to").select_option(label="User rules · all projects")
            page.get_by_role("button", name="Accept and save").wait_for()
            page.get_by_role("button", name="Accept and save").click()
            page.get_by_text(
                "Rule already exists at ~/.omp/rules/mock-rule.md; accept again to replace it.",
                exact=True,
            ).wait_for()
            user_confirm = page.get_by_role("button", name="Confirm overwrite")
            user_confirm.wait_for()
            if user_confirm.get_attribute("title") != "Replace ~/.omp/rules/mock-rule.md":
                raise AssertionError("user overwrite confirmation did not identify its target path")

            rule.fill(f"{rule.input_value()}\n# edited after confirmation")
            page.get_by_role("button", name="Accept and save").wait_for()
            SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(SCREENSHOT), full_page=True)
            page.get_by_role("button", name="Accept and save").click()
            page.get_by_text(
                "Rule already exists at ~/.omp/rules/mock-rule.md; accept again to replace it.",
                exact=True,
            ).wait_for()
            page.get_by_role("button", name="Confirm overwrite").click()
            page.get_by_text("Saved ~/.omp/rules/mock-rule.md", exact=True).wait_for()
            print("PASS: scope and content changes require fresh overwrite confirmation before saving")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
