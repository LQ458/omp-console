from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

INSTRUMENTATION = r"""
(() => {
  let active = null;
  window.__motionBench = {
    start(label) {
      if (active !== null) throw new Error("motion measurement already active");
      const sample = { label, frames: [], tasks: [], raf: 0, observer: null, running: true };
      let previous = performance.now();
      sample.raf = requestAnimationFrame(function tick(now) {
        if (!sample.running) return;
        sample.frames.push(now - previous);
        previous = now;
        sample.raf = requestAnimationFrame(tick);
      });
      const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
      if (supported) {
        sample.observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) sample.tasks.push(entry.duration);
        });
        sample.observer.observe({ type: "longtask", buffered: false });
      }
      sample.longTaskSupported = supported;
      active = sample;
    },
    stop() {
      if (active === null) throw new Error("no motion measurement is active");
      const sample = active;
      sample.running = false;
      cancelAnimationFrame(sample.raf);
      sample.observer?.disconnect();
      active = null;
      const frames = sample.frames.filter(value => Number.isFinite(value) && value > 0);
      const dropped = frames.filter(value => value > 16.7).length;
      const sorted = [...frames].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length === 0 ? 0 : sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
      const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      return {
        label: sample.label,
        frames: frames.length,
        intervals_ms: frames.map(value => Number(value.toFixed(3))),
        median_frame_ms: Number(median.toFixed(3)),
        p95_frame_ms: Number(p95.toFixed(3)),
        over16_7_count: dropped,
        over16_7_pct: frames.length ? dropped * 100 / frames.length : 0,
        max_frame_ms: frames.length ? Math.max(...frames) : 0,
        long_task_supported: sample.longTaskSupported,
        long_tasks: sample.tasks.length,
        max_long_task_ms: sample.tasks.length ? Math.max(...sample.tasks) : 0,
      };
    },
  };
})();
"""

POINTER_CAPTURE_STUB = "Element.prototype.setPointerCapture = function () {};"


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


def instrument(context: BrowserContext) -> None:
    context.add_init_script(POINTER_CAPTURE_STUB + "\n" + INSTRUMENTATION)


def start_measurement(page: Page, label: str) -> None:
    page.evaluate("label => window.__motionBench.start(label)", label)


def stop_measurement(page: Page) -> dict[str, Any]:
    return page.evaluate("() => window.__motionBench.stop()")


def measure_click(page: Page, label: str, selector: str, wait_ms: int = 450) -> dict[str, Any]:
    target = page.locator(selector).first
    if not target.is_visible():
        raise RuntimeError(f"{label}: target is not visible: {selector}")
    start_measurement(page, label)
    target.click()
    page.wait_for_timeout(wait_ms)
    return stop_measurement(page)


def app_page(context: BrowserContext, daemon_url: str, session_ids: list[str]) -> Page:
    page = context.new_page()
    page.set_default_timeout(12000)
    page.goto(f"{daemon_url}/?bench#session={session_ids[0]}", wait_until="domcontentloaded")
    page.wait_for_selector(".sh-header", state="visible", timeout=30000)
    page.wait_for_selector(".pn-frame", state="visible", timeout=30000)
    if page.viewport_size is not None and page.viewport_size["width"] >= 760:
        page.wait_for_selector(f'.dk-card-row[data-session-id="{session_ids[1]}"] .dk-card-open', state="visible", timeout=30000)
    return page


def close_extra_panes(page: Page) -> None:
    frames = page.locator(".pn-frame")
    while frames.count() > 1:
        close = page.locator('button[aria-label="close this pane"]').last
        if not close.is_visible():
            raise RuntimeError("split pane has no visible close control")
        close.click()
        page.wait_for_function("document.querySelectorAll('.pn-frame').length <= 1", timeout=5000)
        page.wait_for_timeout(240)


def run_desktop_app(page: Page, session_ids: list[str], repeats: int) -> dict[str, list[dict[str, Any]]]:
    metrics: dict[str, list[dict[str, Any]]] = {}

    def add(name: str, sample: dict[str, Any]) -> None:
        metrics.setdefault(name, []).append(sample)

    for index in range(repeats):
        target = session_ids[1] if index % 2 == 0 else session_ids[0]
        add("session-switch", measure_click(page, "session-switch", f'.dk-card-row[data-session-id="{target}"] .dk-card-open'))

    for index in range(repeats):
        add("sidebar-fold", measure_click(page, "sidebar-fold", 'button[aria-label="hide sessions"]'))
        add("sidebar-unfold", measure_click(page, "sidebar-unfold", 'button[aria-label="show sessions"]'))

    for index in range(repeats):
        add("pane-split-right", measure_click(page, "pane-split-right", 'button[aria-label="split pane right"]'))
        page.wait_for_function("document.querySelectorAll('.pn-frame').length >= 2", timeout=5000)
        close_extra_panes(page)

        add("pane-split-down", measure_click(page, "pane-split-down", 'button[aria-label="split pane down"]'))
        page.wait_for_function("document.querySelectorAll('.pn-frame').length >= 2", timeout=5000)
        close_extra_panes(page)

        page.locator('button[aria-label="split pane right"]').click()
        page.wait_for_function("document.querySelectorAll('.pn-frame').length >= 2", timeout=5000)
        add("pane-close", measure_click(page, "pane-close", 'button[aria-label="close this pane"]', wait_ms=500))
        page.wait_for_function("document.querySelectorAll('.pn-frame').length === 1", timeout=5000)

    return metrics


def visible_settings_button(page: Page):
    buttons = page.locator('button[aria-label="settings"]')
    for index in range(buttons.count()):
        button = buttons.nth(index)
        if button.is_visible():
            return button
    summary = page.locator('summary[aria-label="more session actions"]')
    if summary.count() and summary.first.is_visible():
        summary.first.click()
        for index in range(buttons.count()):
            button = buttons.nth(index)
            if button.is_visible():
                return button
    raise RuntimeError("phone settings button is not visible")


def open_settings(page: Page, measured: bool = False, label: str = "settings-sheet-open") -> dict[str, Any] | None:
    button = visible_settings_button(page)
    sample = None
    if measured:
        start_measurement(page, label)
        button.click()
        page.wait_for_timeout(450)
        sample = stop_measurement(page)
    else:
        button.click()
        page.wait_for_timeout(260)
    page.wait_for_selector('.dk-sheet[aria-label="Settings"]', state="visible", timeout=5000)
    return sample


def close_settings(page: Page) -> None:
    page.locator('button[aria-label="close Settings"]').click()
    page.wait_for_selector('.dk-sheet[aria-label="Settings"]', state="detached", timeout=5000)
    page.wait_for_timeout(250)


def drag_settings(page: Page, pointer_id: int, distance: int, label: str) -> dict[str, Any]:
    header = page.locator(".dk-sheet-head h2")
    box = header.bounding_box()
    if box is None:
        raise RuntimeError("settings sheet header has no bounding box")
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    start_measurement(page, label)
    touch_pointer(page, header, "pointerdown", pointer_id, x, y)
    page.wait_for_timeout(45)
    touch_pointer(page, header, "pointermove", pointer_id, x, y + distance)
    page.wait_for_timeout(85)
    touch_pointer(page, header, "pointerup", pointer_id, x, y + distance)
    page.wait_for_timeout(500)
    return stop_measurement(page)


def run_phone_app(page: Page, repeats: int) -> dict[str, list[dict[str, Any]]]:
    metrics: dict[str, list[dict[str, Any]]] = {}

    def add(name: str, sample: dict[str, Any]) -> None:
        metrics.setdefault(name, []).append(sample)

    page.wait_for_selector(".cmp-action-toggle", state="visible", timeout=12000)
    for _ in range(repeats):
        add("phone-action-panel-open", measure_click(page, "phone-action-panel-open", ".cmp-action-toggle"))
        page.wait_for_selector(".cmp-touch-action-panel", state="visible", timeout=5000)
        start_measurement(page, "phone-action-panel-close")
        page.locator(".cmp-action-toggle").first.click()
        page.wait_for_function(
            """() => {
                const panel = document.querySelector(".cmp-touch-action-panel");
                return panel?.dataset.exiting === "true" &&
                    panel.getAttribute("aria-hidden") === "true" &&
                    panel.hasAttribute("inert");
            }""",
            timeout=5000,
        )
        page.wait_for_selector(".cmp-touch-action-panel", state="detached", timeout=5000)
        page.wait_for_timeout(30)
        add("phone-action-panel-close", stop_measurement(page))

    for _ in range(repeats):
        sample = open_settings(page, measured=True)
        if sample is None:
            raise RuntimeError("settings open measurement was not recorded")
        add("settings-sheet-open", sample)
        close_settings(page)

    for index in range(repeats):
        open_settings(page)
        add("bottom-sheet-drag-spring", drag_settings(page, 200 + index, 70, "bottom-sheet-drag-spring"))
        page.wait_for_function("document.querySelector('.dk-sheet[aria-label=\"Settings\"]')?.dataset.dragging !== 'true'", timeout=5000)
        close_settings(page)

    for index in range(repeats):
        open_settings(page)
        add("bottom-sheet-drag-close", drag_settings(page, 300 + index, 340, "bottom-sheet-drag-close"))
        page.wait_for_selector('.dk-sheet[aria-label="Settings"]', state="detached", timeout=5000)
        page.wait_for_timeout(220)

    return metrics


def reveal_archive_action(page: Page):
    row = page.locator('[data-session-id="motion-archive"]')
    box = row.bounding_box()
    if box is None:
        raise RuntimeError("archive row has no bounding box")
    x = box["x"] + box["width"] * 0.75
    y = box["y"] + box["height"] / 2
    touch_pointer(page, row, "pointerdown", 500, x, y)
    page.wait_for_timeout(80)
    touch_pointer(page, row, "pointermove", 500, x - 72, y)
    page.wait_for_timeout(80)
    touch_pointer(page, row, "pointerup", 500, x - 72, y)
    archive = row.locator(".dk-row-swipe-actions").get_by_role("button", name="Archive")
    archive.wait_for(state="visible", timeout=5000)
    return archive


def run_harness(context: BrowserContext, harness_url: str, repeats: int, cpu_rate: int | None = None) -> dict[str, list[dict[str, Any]]]:
    page = context.new_page()
    page.set_default_timeout(12000)
    throttle_page(context, page, cpu_rate)
    page.goto(harness_url, wait_until="domcontentloaded")
    page.wait_for_selector(".motion-harness", state="visible")
    metrics: dict[str, list[dict[str, Any]]] = {}

    def add(name: str, sample: dict[str, Any]) -> None:
        metrics.setdefault(name, []).append(sample)

    for index in range(repeats):
        if index > 0:
            page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('[data-session-id="motion-archive"]', state="visible")
        archive = reveal_archive_action(page)
        start_measurement(page, "session-row-archive-collapse")
        archive.click()
        page.wait_for_timeout(420)
        add("session-row-archive-collapse", stop_measurement(page))
        page.wait_for_selector('[data-session-id="motion-archive"]', state="detached", timeout=5000)

    for _ in range(repeats):
        start_measurement(page, "toast-enter")
        page.get_by_role("button", name="Show archive toast").click()
        page.wait_for_timeout(350)
        add("toast-enter", stop_measurement(page))
        start_measurement(page, "toast-exit")
        page.locator('button[aria-label="dismiss archive toast"]').click()
        page.wait_for_timeout(350)
        add("toast-exit", stop_measurement(page))
        page.wait_for_selector(".dk-archive-toast", state="detached", timeout=5000)

    for index in range(repeats):
        if index > 0:
            page.reload(wait_until="domcontentloaded")
        add("widget-figure-card-appear", measure_click(page, "widget-figure-card-appear", 'button:has-text("Show widget figure")', wait_ms=500))
        page.wait_for_selector("iframe.tr-fig-frame", state="visible", timeout=5000)

    page.close()
    return metrics


def throttle_page(context: BrowserContext, page: Page, cpu_rate: int | None) -> None:
    if cpu_rate is None:
        return
    session = context.new_cdp_session(page)
    session.send("Emulation.setCPUThrottlingRate", {"rate": cpu_rate})
    session.detach()



def summarize(samples: list[dict[str, Any]], gated: bool) -> dict[str, Any]:
    percentages = [sample["over16_7_pct"] for sample in samples]
    maxima = [sample["max_frame_ms"] for sample in samples]
    intervals = [interval for sample in samples for interval in sample["intervals_ms"]]
    task_counts = [sample["long_tasks"] for sample in samples if sample["long_task_supported"]]
    peak_long_task = max((sample["max_long_task_ms"] for sample in samples), default=0)
    median_pct = statistics.median(percentages)
    worst_frame = max(maxima, default=0)
    return {
        "runs": len(samples),
        "median_over16_7_pct": round(median_pct, 3),
        "median_frame_ms": round(statistics.median(intervals), 3) if intervals else 0,
        "worst_max_frame_ms": round(worst_frame, 3),
        "median_max_frame_ms": round(statistics.median(maxima), 3) if maxima else 0,
        "median_long_tasks": round(statistics.median(task_counts), 3) if task_counts else None,
        "max_long_task_ms": round(peak_long_task, 3),
        "gate": "NOT_GATED" if not gated else "PASS" if median_pct < 5 and worst_frame <= 50 else "FAIL",
    }


def run_environment(
    browser: Browser,
    name: str,
    context_options: dict[str, Any],
    daemon_url: str,
    harness_url: str,
    session_ids: list[str],
    repeats: int,
    cpu_rate: int | None = None,
) -> dict[str, Any]:
    context = browser.new_context(**context_options)
    instrument(context)
    desktop = context_options.get("viewport", {}).get("width", 1280) >= 760

    result: dict[str, Any] = {
        "environment": name,
        "viewport": context_options.get("viewport", "iPhone 15"),
        "cpu_throttling_rate": cpu_rate,
        "metrics": {},
    }
    page = app_page(context, daemon_url, session_ids)
    throttle_page(context, page, cpu_rate)
    if desktop:
        result["metrics"].update(run_desktop_app(page, session_ids, repeats))
    else:
        result["metrics"].update(run_phone_app(page, repeats))
    page.close()
    result["metrics"].update(run_harness(context, harness_url, repeats, cpu_rate))
    context.close()
    result["summary"] = {name: summarize(samples, cpu_rate is not None) for name, samples in result["metrics"].items()}
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--daemon-url", required=True)
    parser.add_argument("--harness-url", required=True)
    parser.add_argument("--session-ids", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--phase", choices=("before", "after"), required=True)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 5:
        raise SystemExit("at least five repeats are required")

    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    session_ids = args.session_ids.split(",")
    results: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        webkit = playwright.webkit.launch(headless=True)
        try:
            results.append(
                run_environment(
                    webkit,
                    "webkit-iphone-15",
                    playwright.devices["iPhone 15"],
                    args.daemon_url,
                    args.harness_url,
                    session_ids,
                    args.repeats,
                )
            )
            results.append(
                run_environment(
                    webkit,
                    "webkit-desktop",
                    {"viewport": {"width": 1440, "height": 900}},
                    args.daemon_url,
                    args.harness_url,
                    session_ids,
                    args.repeats,
                )
            )
        finally:
            webkit.close()

        chrome_path = Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1248/chromium_headless_shell-mac-arm64/chrome-headless-shell"
        if not chrome_path.is_file():
            raise RuntimeError(f"Chromium headless shell 1248 is unavailable: {chrome_path}")
        chromium = playwright.chromium.launch(headless=True, executable_path=str(chrome_path))
        try:
            results.append(
                run_environment(
                    chromium,
                    "chromium-desktop-4x",
                    {"viewport": {"width": 1440, "height": 900}},
                    args.daemon_url,
                    args.harness_url,
                    session_ids,
                    args.repeats,
                    cpu_rate=4,
                )
            )
            results.append(
                run_environment(
                    chromium,
                    "chromium-iphone-15-4x",
                    playwright.devices["iPhone 15"],
                    args.daemon_url,
                    args.harness_url,
                    session_ids,
                    args.repeats,
                    cpu_rate=4,
                )
            )
        finally:
            chromium.close()

    report = {"phase": args.phase, "repeats": args.repeats, "results": results}
    report_path = output / "transitions.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for result in results:
        summaries = result["summary"]
        failed = [name for name, summary in summaries.items() if summary["gate"] == "FAIL"]
        print(f"{result['environment']}: {len(summaries)} transitions; gate failures={failed or 'none'}")
        for transition, summary in summaries.items():
            print(
                f"  {transition}: >16.7ms median={summary['median_over16_7_pct']:.3f}% "
                f"worst-frame={summary['worst_max_frame_ms']:.3f}ms "
                f"long-tasks={summary['median_long_tasks']} gate={summary['gate']}"
            )
    print(report_path)


if __name__ == "__main__":
    main()
