from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

WEB = Path(__file__).resolve().parents[2]
BUN = os.environ.get("OMP_CONSOLE_BUN", "bun")
BUN_PATH = shutil.which(BUN) or (str(Path(BUN).resolve()) if Path(BUN).is_file() else None)
PORT_BASE = int(os.environ.get("OMP_CONSOLE_SCENARIO_PORT_BASE", "7640"))
PORT = PORT_BASE + 1
OUT = Path(os.environ.get("OMP_CONSOLE_SCREENSHOT_OUT", "/tmp/omp-console-night2/out/w2-pins"))
SCENARIO_ROOT = Path(os.environ.get("OMP_CONSOLE_SCENARIO_ROOT", "/tmp/omp-console-night2/w2-pins"))

RECIPES = [
    {
        "id": "nightly",
        "name": "Nightly triage",
        "cwd": "/work/reminders",
        "machineId": "local",
        "prompt": "Review the newest Apple Reminders",
        "createdAt": 1,
        "updatedAt": 1,
    },
    {
        "id": "reminders",
        "name": "Reminder review",
        "cwd": "/work/reminders",
        "machineId": "local",
        "prompt": "Summarize the open reminders",
        "createdAt": 2,
        "updatedAt": 2,
    },
]


def json_response(route, value: object, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))


def wait_for_daemon(process: subprocess.Popen[bytes], url: str) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("mock daemon exited before becoming ready")
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError("mock daemon did not become ready")


def main() -> None:
    if BUN_PATH is None:
        raise RuntimeError("Bun was not found; set OMP_CONSOLE_BUN or add bun to PATH")
    if not 7620 <= PORT_BASE <= 7697:
        raise RuntimeError("OMP_CONSOLE_SCENARIO_PORT_BASE must be between 7620 and 7697")
    OUT.mkdir(parents=True, exist_ok=True)
    for dirname in ("home", "tmp", "config", "agent"):
        (SCENARIO_ROOT / dirname).mkdir(parents=True, exist_ok=True)

    daemon_url = f"http://127.0.0.1:{PORT}"
    daemon_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(SCENARIO_ROOT / "home"),
        "TMPDIR": str(SCENARIO_ROOT / "tmp"),
        "PI_CONFIG_DIR": str(SCENARIO_ROOT / "config"),
        "PI_CODING_AGENT_DIR": str(SCENARIO_ROOT / "agent"),
        "OMP_CONSOLE_COMPUTER_USE": "0",
        "OMP_CONSOLE_SCENARIO_ROOT": str(SCENARIO_ROOT),
        "OMP_CONSOLE_SCENARIO_PORT_BASE": str(PORT_BASE),
    }
    starts: list[dict[str, object]] = []
    log_path = OUT / "w2-pins-mock-daemon.log"

    with log_path.open("wb") as daemon_log:
        process = subprocess.Popen(
            [BUN_PATH, "dev/mock-daemon.ts", "--port", str(PORT), "--dist", "dist"],
            cwd=WEB,
            env=daemon_env,
            stdout=daemon_log,
            stderr=subprocess.STDOUT,
        )
        try:
            wait_for_daemon(process, daemon_url)
            with urllib.request.urlopen(f"{daemon_url}/api/sessions", timeout=5) as response:
                sessions = json.load(response)
            session = next(item for item in sessions["live"] if item["title"] == "Refactor relay backoff")
            session_id = session["id"]

            def route_api(route) -> None:
                request = route.request
                url = urlparse(request.url)
                if url.path == "/api/recipes" and request.method == "GET":
                    json_response(route, {"recipes": RECIPES})
                    return
                if url.path == "/api/pins" and request.method == "GET":
                    json_response(route, {"sessionIds": [session_id]})
                    return
                if url.path == "/api/history" and request.method == "GET":
                    json_response(route, {"nodes": [], "edges": []})
                    return
                if url.path == "/api/search" and request.method == "GET":
                    snippets = [
                        ("search-session-1", "Cobalt briefing", "Please open the cobalt comet report.", "entry-1"),
                        ("search-session-2", "Evening report", "The cobalt comet is visible tonight.", "entry-2"),
                    ]
                    hits = []
                    for result_id, title, snippet, entry_id in snippets:
                        start = snippet.lower().index("cobalt comet")
                        hits.append({
                            "sessionId": result_id,
                            "title": title,
                            "snippet": snippet,
                            "matchStart": start,
                            "matchEnd": start + len("cobalt comet"),
                            "at": 2,
                            "entryId": entry_id,
                        })
                    json_response(route, {"results": hits, "truncated": False, "scannedSessions": 2})
                    return
                if url.path.startswith("/api/recipes/") and url.path.endswith("/start") and request.method == "POST":
                    body = json.loads(request.post_data or "{}")
                    starts.append({"path": url.path, "body": body})
                    json_response(route, {
                        "id": "recipe-started-local",
                        "title": "Recipe session",
                        "cwd": "/work/reminders",
                        "state": "idle",
                        "createdAt": 3,
                        "lastActivityAt": 3,
                        "agentCount": 0,
                        "goalActive": False,
                        "awaitingAnswer": False,
                    }, 201)
                    return
                route.continue_()

            browser_env = {
                "PATH": daemon_env["PATH"],
                "HOME": daemon_env["HOME"],
                "TMPDIR": daemon_env["TMPDIR"],
                "OMP_CONSOLE_COMPUTER_USE": "0",
                "PLAYWRIGHT_BROWSERS_PATH": str(Path.home() / "Library" / "Caches" / "ms-playwright"),
            }
            with sync_playwright() as playwright:
                browser = playwright.webkit.launch(headless=True, env=browser_env)
                try:
                    context = browser.new_context(**playwright.devices["iPhone 15"], color_scheme="dark", reduced_motion="reduce")
                    page = context.new_page()
                    page.add_init_script(
                        "window.__openedSearchResults = []; window.__hashChanges = []; "
                        "window.addEventListener('omp-console:open-search-result', event => window.__openedSearchResults.push(event.detail)); "
                        "window.addEventListener('hashchange', () => window.__hashChanges.push(window.location.hash));"
                    )
                    page.route("**/api/**", route_api)

                    page.goto(daemon_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="sessions", exact=True).click()
                    page.get_by_text("Pinned", exact=True).wait_for(state="visible", timeout=10_000)
                    page.wait_for_timeout(350)
                    page.screenshot(path=str(OUT / "pinned-group-iphone15.png"))
                    session_url = f"{daemon_url}/#session={session_id}"
                    page.goto(session_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="Open sessions", exact=True).click()

                    page.get_by_role("button", name="new session", exact=True).click()
                    page.get_by_text("Start: Nightly triage", exact=True).wait_for(state="visible", timeout=10_000)
                    page.wait_for_timeout(350)
                    page.screenshot(path=str(OUT / "recipe-picker-iphone15.png"))
                    with page.expect_response(lambda response: response.url.endswith("/api/recipes/nightly/start")) as start_response_info:
                        page.get_by_text("Start: Nightly triage", exact=True).click()
                    if start_response_info.value.status != 201:
                        raise AssertionError("the recipe picker did not receive a successful start response")
                    if not starts or starts[-1]["path"] != "/api/recipes/nightly/start":
                        raise AssertionError("the recipe picker did not start its selected recipe")
                    if not isinstance(starts[-1]["body"].get("idempotencyKey"), str):
                        raise AssertionError("the recipe picker did not send an idempotency key")

                    page.goto(session_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="Open sessions", exact=True).wait_for(state="visible", timeout=10_000)
                    page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))")
                    search_input = page.locator(".ct-pal-input")
                    search_input.wait_for(state="visible", timeout=10_000)
                    search_input.fill("cobalt comet")
                    page.get_by_text("Evening report", exact=True).wait_for(state="visible", timeout=10_000)
                    page.wait_for_timeout(350)
                    if page.locator(".ct-pal-domain-main").count() != 2:
                        raise AssertionError("Cmd+K did not show both transcript search hits")
                    page.screenshot(path=str(OUT / "command-palette-iphone15.png"))
                    search_input.press("ArrowDown")
                    search_input.press("Enter")
                    page.wait_for_function("window.__openedSearchResults.some(result => result.entryId === 'entry-2')", timeout=10_000)
                    opened = page.evaluate("window.__openedSearchResults.at(-1)")
                    if opened.get("sessionId") != "search-session-2":
                        raise AssertionError("ArrowDown and Enter did not open the selected transcript hit")

                    page.goto(session_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="Open sessions", exact=True).wait_for(state="visible", timeout=10_000)
                    page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))")
                    search_input = page.locator(".ct-pal-input")
                    search_input.wait_for(state="visible", timeout=10_000)
                    search_input.fill("start:")
                    page.get_by_role("option", name="Start: Reminder review").wait_for(state="visible", timeout=10_000)
                    search_input.press("ArrowDown")
                    selected = page.locator('.ct-pal-domain-main[role="option"][aria-selected="true"]')
                    if "Reminder review" not in selected.inner_text():
                        raise AssertionError("ArrowDown did not move the active option to the second recipe")
                    search_input.press("Enter")
                    page.wait_for_function("window.__hashChanges.some(hash => hash.includes('recipe-started-local'))", timeout=10_000)
                    recipe_hashes = page.evaluate("window.__hashChanges.map(decodeURIComponent)")
                    if "#session=recipe-started-local" not in recipe_hashes:
                        raise AssertionError(f"a local recipe start used a non-local key: {recipe_hashes!r}")

                    print("PASS: pinned group, recipe picker, Cmd+K results, and ArrowDown/Enter actions")
                    for name in ("pinned-group-iphone15.png", "recipe-picker-iphone15.png", "command-palette-iphone15.png"):
                        print(OUT / name)
                    context.close()
                finally:
                    browser.close()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
