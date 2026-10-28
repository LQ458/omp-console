"""Proves, in headless Chromium, which requests the omp-console service worker answers.

    cd packages/web && bun run build && bun dev/mock-daemon.ts --port 7490 --dist dist &
    python3 pwa/verify/relay_probe.py http://127.0.0.1:7490

Playwright's Response.from_service_worker is true only when the worker called respondWith, so it
separates "intercepted" from "went straight to the network". Own process; no omp browser tabs.
Exit code 1 when the expectations below do not hold.
"""
import asyncio
import glob
import json
import os
import sys

from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7490").rstrip("/")


def find_chrome() -> str | None:
    """Same browser omp-sweep uses: newest puppeteer chrome-headless-shell, else Playwright's own."""
    candidates = sorted(glob.glob(os.path.expanduser("~/.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell")))
    return candidates[-1] if candidates else None


async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as pw:
        chrome = find_chrome()
        browser = await (pw.chromium.launch(executable_path=chrome) if chrome else pw.chromium.launch())
        context = await browser.new_context()
        page = await context.new_page()
        seen: list[dict] = []
        sockets: list[str] = []

        page.on(
            "response",
            lambda response: seen.append(
                {"url": response.url.replace(BASE, ""), "status": response.status, "sw": response.from_service_worker}
            ),
        )
        page.on("websocket", lambda ws: sockets.append(ws.url))

        await page.goto(BASE + "/", wait_until="load")
        await page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        # Reload so the page is loaded under the worker's control, like every later launch.
        await page.reload(wait_until="load")
        controlled = await page.evaluate("!!navigator.serviceWorker.controller")
        if not controlled:
            failures.append("page not controlled after reload")

        seen.clear()
        await page.evaluate(
            """async () => {
                await fetch('/api/health');
                await fetch('/r/probe-room').catch(() => null);
                await fetch('/api/sessions', { method: 'POST', body: '{}', headers: {'content-type': 'application/json'} }).catch(() => null);
            }"""
        )
        await page.wait_for_timeout(1500)

        def entries(path: str, method: str | None = None):
            return [r for r in seen if r["url"].split("?")[0] == path]
        # A real guest connection: take a room link from the control API, paste it into the join screen, and
        # check the relay WebSocket opens while the worker controls the page.
        link = await page.evaluate(
            """async () => {
                const list = await (await fetch('/api/sessions')).json();
                const id = list.live[0].id;
                const room = await (await fetch(`/api/sessions/${id}/room`, { method: 'POST', headers: {'content-type': 'application/json'}, body: '{}' })).json();
                return room.link;
            }"""
        )
        await page.fill("input[placeholder*='/r/room']", link)
        await page.get_by_role("button", name="Connect", exact=True).click()
        await page.wait_for_timeout(2000)
        relay_sockets = [s for s in sockets if "/r/" in s]
        if not relay_sockets:
            failures.append("no relay WebSocket was opened through the controlled page")
        transcript_visible = await page.evaluate("document.body.innerText.length > 200")
        if not transcript_visible:
            failures.append("page shows no transcript after connecting")

        health = entries("/api/health")
        relay = entries("/r/probe-room")
        if not health or not all(r["sw"] for r in health):
            failures.append(f"/api/health should be answered by the worker: {health}")
        if not relay or any(r["sw"] for r in relay):
            failures.append(f"/r/probe-room must not be answered by the worker: {relay}")
        print(json.dumps({"controlled": controlled, "responses": seen[:12], "websockets": sockets}, indent=1))

        # Offline: the shell must still load from the precache and /api must answer from its cache.
        await context.set_offline(True)
        await page.reload(wait_until="load")
        offline_title = await page.title()
        offline_api = await page.evaluate("fetch('/api/health').then(r => r.status).catch(e => 'error:' + e.message)")
        print(json.dumps({"offline_title": offline_title, "offline_api": offline_api}))
        if not offline_title.endswith("deck"):
            failures.append(f"offline shell did not load, title={offline_title!r}")
        if offline_api != 200:
            failures.append(f"offline /api/health not served from cache: {offline_api}")
        await context.set_offline(False)
        await browser.close()

    for failure in failures:
        print("FAIL", failure)
    print("OK" if not failures else "FAILED")
    return 1 if failures else 0


sys.exit(asyncio.run(main()))
