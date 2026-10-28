#!/usr/bin/env python3
"""Run against dev/mock-daemon.ts; captures desktop window modes and the phone sheet."""

import argparse
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import Browser, Locator, Page, sync_playwright

BASE_URL = "http://127.0.0.1:7661"
SCREENSHOTS = Path("/tmp/deck-day2/out/x1-float/fix")
CHROMIUM = Path.home() / "Library/Caches/ms-playwright/chromium_headless_shell-1248/chromium_headless_shell-mac-arm64/chrome-headless-shell"
DESKTOP_VIEWPORT = {"width": 1400, "height": 900}
PHONE_VIEWPORT = {"width": 393, "height": 852}


def screenshot(page: Page, name: str) -> None:
    destination = SCREENSHOTS / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(destination), full_page=True)
    print(destination)


def session_ids(page: Page) -> list[str]:
    response = page.request.get(f"{BASE_URL}/api/sessions")
    assert response.ok, f"mock session list returned HTTP {response.status}"
    payload = response.json()
    live = payload["live"]
    return [row["id"] for row in live]


def wait_for_session_pane(page: Page) -> Locator:
    focused = page.locator('.pn-frame[data-focused="true"]')
    focused.wait_for(state="visible", timeout=20_000)
    focused.locator(".sh-app").wait_for(state="visible", timeout=20_000)
    return focused


def open_session(page: Page, session_id: str) -> Locator:
    page.evaluate("id => { location.hash = `session=${encodeURIComponent(id)}`; }", session_id)
    page.wait_for_function("() => !location.hash.includes('session=')", timeout=10_000)
    page.wait_for_timeout(150)
    return wait_for_session_pane(page)


def split(page: Page, direction: str) -> Locator:
    name = "split pane down" if direction == "down" else "split pane right"
    count = page.locator(".pn-frame").count()
    page.get_by_role("toolbar", name="pane layout").get_by_role("button", name=name).click()
    page.wait_for_function("expected => document.querySelectorAll('.pn-frame').length === expected",
                           arg=count + 1, timeout=10_000)
    focused = page.locator('.pn-frame[data-focused="true"]')
    focused.wait_for(state="visible")
    return focused


def focus_pane(page: Page, pane_id: str) -> Locator:
    pane = page.locator(f'.pn-frame[data-pane="{pane_id}"]')
    pane.wait_for(state="visible")
    box = pane.bounding_box()
    assert box is not None
    pane.click(position={"x": box["width"] - 8, "y": box["height"] / 2})
    assert pane.get_attribute("data-focused") == "true", f"pane {pane_id} did not receive focus"
    return pane


def sheet_with_title(scope: Page | Locator, title: str) -> Locator:
    return scope.locator(".dk-sheet").filter(has_text=title)


def wait_for_sheet_animations(page: Page, title: str) -> None:
    page.wait_for_function(
        """title => {
          const sheet = [...document.querySelectorAll('.dk-sheet')].find(
            candidate => candidate.querySelector('.dk-sheet-title')?.textContent?.trim() === title
          );
          return sheet !== undefined && sheet.getAnimations().every(animation => animation.playState === "finished");
        }""",
        arg=title,
        timeout=5_000,
    )


def wait_for_sheet_popover(page: Page, sheet: Locator) -> None:
    element = sheet.element_handle()
    assert element is not None
    page.wait_for_function(
        "(sheet) => sheet.closest('.dk-sheet-root').matches(':popover-open')",
        arg=element,
        timeout=5_000,
    )


def open_agents_sheet(page: Page, pane: Locator) -> Locator:
    graph = pane.get_by_role("button", name="Graph", exact=True)
    if graph.count() > 0:
        graph.click()
    else:
        open_graph = pane.get_by_role("button", name="Open agent graph")
        if open_graph.count() == 0:
            open_graph = page.get_by_role("button", name="Open agent graph")
        if open_graph.count() > 0:
            open_graph.first.click()
        else:
            toggle = pane.get_by_role("button", name="show agents")
            if toggle.count() == 0:
                toggle = pane.get_by_role("button", name="hide agents")
            if toggle.count() == 0:
                toggle = page.get_by_role("button", name="show agents")
            if toggle.count() == 0:
                toggle = page.get_by_role("button", name="hide agents")
            assert toggle.count() > 0, "Agents rail toggle is unavailable"
            if toggle.first.get_attribute("aria-label") == "show agents":
                toggle.first.click()
            graph.wait_for(state="visible", timeout=10_000)
            graph.click()
    dialog = sheet_with_title(pane, "Agents")
    dialog.wait_for(state="visible", timeout=10_000)
    dialog.locator(".ag-sheet-tools").wait_for(state="visible", timeout=10_000)
    assert dialog.evaluate("el => el.contains(document.activeElement)"), "Agents sheet did not take focus on open"
    return dialog


def assert_float_over_other_pane(dialog: Locator, origin: Locator, other: Locator) -> None:
    box = dialog.bounding_box()
    origin_box = origin.bounding_box()
    other_box = other.bounding_box()
    assert box is not None and origin_box is not None and other_box is not None
    extends = (
        box["x"] < origin_box["x"]
        or box["y"] < origin_box["y"]
        or box["x"] + box["width"] > origin_box["x"] + origin_box["width"]
        or box["y"] + box["height"] > origin_box["y"] + origin_box["height"]
    )
    assert extends, f"floating panel stayed inside its pane: {box=} {origin_box=}"
    root_open = dialog.evaluate("el => el.closest('.dk-sheet-root').matches(':popover-open')")
    assert root_open, "floating panel is not in the browser top layer"

    left = max(box["x"] + 24, other_box["x"] + 8)
    right = min(box["x"] + box["width"] - 24, other_box["x"] + other_box["width"] - 8)
    top = max(box["y"] + 52, other_box["y"] + 8)
    bottom = min(box["y"] + box["height"] - 20, other_box["y"] + other_box["height"] - 8)
    assert left < right and top < bottom, f"floating panel did not overlap the other pane: {box=} {other_box=}"
    point = {"x": (left + right) / 2, "y": (top + bottom) / 2}
    assert dialog.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", point), (
        "elementFromPoint over the other pane did not hit the floating panel"
    )
    assert (
        box["x"] >= 0
        and box["y"] >= 0
        and box["x"] + box["width"] <= DESKTOP_VIEWPORT["width"]
        and box["y"] + box["height"] <= DESKTOP_VIEWPORT["height"]
    ), f"floating panel was clipped by the viewport: {box=}"

def assert_hit_test_inside(locator: Locator, message: str) -> None:
    box = locator.bounding_box()
    assert box is not None
    point = {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}
    assert locator.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", point), message


def point_outside_panel(panel: Locator, target: Locator) -> dict[str, float]:
    panel_box = panel.bounding_box()
    target_box = target.bounding_box()
    assert panel_box is not None and target_box is not None
    for x in (target_box["x"] + 10, target_box["x"] + target_box["width"] - 10):
        for y in (
            target_box["y"] + 10,
            target_box["y"] + target_box["height"] / 2,
            target_box["y"] + target_box["height"] - 10,
        ):
            inside = (
                panel_box["x"] <= x <= panel_box["x"] + panel_box["width"]
                and panel_box["y"] <= y <= panel_box["y"] + panel_box["height"]
            )
            point = {"x": x, "y": y}
            if not inside and target.evaluate("(el, p) => el === document.elementFromPoint(p.x, p.y)", point):
                return point
    raise AssertionError("no hit-testable point remained outside the window")


def exercise_agents_overlays(page: Page, dialog: Locator, prefix: str, mode: str) -> None:
    assert dialog.get_attribute("data-display-mode") == mode
    node = dialog.locator(".ag-gnode[data-node-id]").first
    node.wait_for(state="visible", timeout=10_000)
    node.click(button="right")
    menu = page.locator(".ag-menu[role='menu']")
    menu.wait_for(state="visible", timeout=5_000)
    assert menu.evaluate("el => el.closest('.ag-sheet-root') !== null"), "agent menu escaped the windowed sheet root"
    assert_hit_test_inside(menu, f"node menu is hidden behind the {mode} Agents sheet")
    screenshot(page, f"{prefix}-{mode}-node-menu.png")
    page.keyboard.press("Escape")
    menu.wait_for(state="detached", timeout=5_000)

    dialog.locator(".ag-gnode[data-node-id]").first.click()
    drawer = page.locator(".ag-drawer")
    drawer.wait_for(state="visible", timeout=5_000)
    assert drawer.evaluate("el => el.closest('.ag-sheet-root') !== null"), "agent drawer escaped the windowed sheet root"
    assert_hit_test_inside(drawer, f"agent drawer is hidden behind the {mode} Agents sheet")
    screenshot(page, f"{prefix}-{mode}-agent-drawer.png")
    drawer.get_by_role("button", name="close", exact=True).click()
    drawer.wait_for(state="detached", timeout=5_000)


def exercise_other_pane_popovers(page: Page, pane: Locator, prefix: str) -> None:
    summary = pane.locator('summary[aria-label="more session controls"]')
    assert summary.count() == 1, "session header overflow trigger is unavailable"
    summary.click()
    menu = page.locator('.sh-header-overflow-layer[data-open="true"]')
    menu.wait_for(state="visible", timeout=5_000)
    assert menu.evaluate("el => el.matches(':popover-open')"), "header overflow menu did not enter the top layer"
    assert_hit_test_inside(menu, "header overflow menu is hidden behind the floating sheet")
    screenshot(page, f"{prefix}-header-overflow.png")

    model = pane.locator('button[title="change model (this session only)"]')
    if model.count() == 0:
        model = menu.locator('button[title="change model (this session only)"]')
    assert model.count() == 1, "model picker is missing from the other pane's controls"
    model.click()
    picker = page.get_by_role("dialog", name="Model and thinking", exact=True)
    picker.wait_for(state="visible", timeout=5_000)
    assert picker.evaluate("el => el.closest('.sp-portal').matches(':popover-open')"), "model picker portal did not enter the top layer"
    assert_hit_test_inside(picker, "model picker is hidden behind the floating sheet")
    screenshot(page, f"{prefix}-other-pane-model-picker.png")
    page.keyboard.press("Escape")
    picker.wait_for(state="detached", timeout=5_000)
    page.wait_for_function("() => document.querySelector('.sh-header-overflow-layer[data-open=true]') === null")


def exercise_spawn_clickthrough(page: Page, composer: Locator, prefix: str) -> None:
    page.evaluate(
        """() => localStorage.setItem("omp-console.sheet-window.v1:spawn", JSON.stringify({
          version: 1, mode: "in-pane", geometry: { x: 16, y: 72, width: 420, height: 300 }
        }))"""
    )
    page.evaluate(
        """() => window.dispatchEvent(new CustomEvent("omp-console:open-panel", {
          cancelable: true, detail: { panel: "spawn", task: "windowed Spawn regression" }
        }))"""
    )
    dialog = sheet_with_title(page, "New agent")
    dialog.wait_for(state="visible", timeout=10_000)
    dialog.get_by_role("button", name="Float panel").click()
    assert dialog.get_attribute("data-display-mode") == "float"
    assert dialog.evaluate("el => el.closest('.dk-sheet-root').matches(':popover-open')")
    portal = page.locator(".sp-portal")
    assert portal.evaluate("el => getComputedStyle(el).pointerEvents") == "none", "windowed Spawn portal blocks other panes"
    point = point_outside_panel(dialog, composer)
    page.mouse.click(point["x"], point["y"])
    assert composer.evaluate("el => document.activeElement === el"), "floating Spawn prevented the other pane from receiving focus"
    assert dialog.is_visible(), "clicking another pane dismissed floating Spawn"
    page.keyboard.press("Escape")
    assert dialog.is_visible(), "Escape in another pane's composer closed floating Spawn"
    screenshot(page, f"{prefix}-spawn-other-pane-escape.png")
    dialog.get_by_role("button", name="Float panel").focus()
    page.keyboard.press("Escape")
    dialog.wait_for(state="detached", timeout=5_000)


def resize_panel(page: Page, dialog: Locator, edge: str, dx: float, dy: float) -> None:
    handle = dialog.locator(f'.dk-sheet-resize-handle[data-edge="{edge}"]')
    handle_box = handle.bounding_box()
    sheet = dialog.element_handle()
    assert handle_box is not None and sheet is not None
    start_x = handle_box["x"] + handle_box["width"] / 2
    start_y = handle_box["y"] + handle_box["height"] / 2
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    assert dialog.get_attribute("data-resizing") == "true"
    page.mouse.move(start_x + dx, start_y + dy, steps=8)
    page.mouse.up()
    page.wait_for_function(
        "(element) => element.getAttribute('data-resizing') !== 'true'",
        arg=sheet,
        timeout=5_000,
    )


def assert_resize_fixed_edge(page: Page, dialog: Locator, edge: str, dx: float, dy: float) -> None:
    before = dialog.bounding_box()
    assert before is not None
    resize_panel(page, dialog, edge, dx, dy)
    after = dialog.bounding_box()
    assert after is not None
    if "w" in edge:
        assert abs(after["x"] + after["width"] - before["x"] - before["width"]) <= 1, f"{edge} resize moved the right edge"
    else:
        assert abs(after["x"] - before["x"]) <= 1, f"{edge} resize moved the left edge"
    if "n" in edge:
        assert abs(after["y"] + after["height"] - before["y"] - before["height"]) <= 1, f"{edge} resize moved the bottom edge"
    else:
        assert abs(after["y"] - before["y"]) <= 1, f"{edge} resize moved the top edge"


def assert_lost_pointer_capture_ends_resize(page: Page, dialog: Locator) -> None:
    handle = dialog.locator('.dk-sheet-resize-handle[data-edge="se"]')
    handle_box = handle.bounding_box()
    assert handle_box is not None
    start_x = handle_box["x"] + handle_box["width"] / 2
    start_y = handle_box["y"] + handle_box["height"] / 2
    page.evaluate(
        """() => {
          window.__sheetPointerId = null;
          document.addEventListener("pointerdown", event => {
            window.__sheetPointerId = event.pointerId;
          }, { capture: true, once: true });
        }"""
    )
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(start_x + 1, start_y + 1, steps=1)
    assert dialog.get_attribute("data-resizing") == "true"
    before_loss = dialog.bounding_box()
    assert before_loss is not None
    transferred = page.evaluate(
        """() => {
          const section = document.querySelector('.ag-sheet');
          const id = window.__sheetPointerId;
          if (!(section instanceof Element) || typeof id !== "number" || !section.hasPointerCapture(id)) return false;
          document.body.setPointerCapture(id);
          return document.body.hasPointerCapture(id);
        }"""
    )
    assert transferred, "browser did not transfer the sheet's active pointer capture"
    page.mouse.move(min(start_x + 20, DESKTOP_VIEWPORT["width"] - 1),
                    min(start_y + 20, DESKTOP_VIEWPORT["height"] - 1))
    page.wait_for_function(
        "() => document.querySelector('.ag-sheet')?.getAttribute('data-resizing') !== 'true'",
        timeout=5_000,
    )
    page.mouse.up()
    after_loss = dialog.bounding_box()
    assert after_loss is not None
    assert all(abs(after_loss[key] - before_loss[key]) <= 1 for key in ("x", "y", "width", "height")), (
        "resize continued after pointer capture was lost"
    )


def exercise_desktop(browser: Browser, engine: str, pane_count: int) -> None:
    context = browser.new_context(viewport=DESKTOP_VIEWPORT)
    page = context.new_page()
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.get_by_role("toolbar", name="pane layout").wait_for(state="visible", timeout=20_000)
    sessions = [session_id for session_id in session_ids(page) if session_id != "agent-tree"]
    assert len(sessions) >= 3, f"mock needs three non-agent sessions; found {sessions}"
    assert "graph" in sessions, "mock must include the graph fixture for sibling-pane Agents checks"

    page.goto(f"{BASE_URL}/#session={quote('graph', safe='')}", wait_until="domcontentloaded")
    first = wait_for_session_pane(page)
    first_id = first.get_attribute("data-pane")
    assert first_id is not None

    click_other_id = first_id
    if pane_count == 2:
        target = split(page, "down")
        target_id = target.get_attribute("data-pane")
        open_session(page, "agent-tree")
    else:
        right = split(page, "right")
        click_other_id = right.get_attribute("data-pane")
        open_session(page, sessions[0])
        focus_pane(page, first_id)
        target = split(page, "down")
        target_id = target.get_attribute("data-pane")
        open_session(page, "agent-tree")
        split(page, "right")
        open_session(page, sessions[3])
        page.wait_for_function("() => document.querySelectorAll('.pn-frame').length === 4")

    assert target_id is not None and click_other_id is not None
    target = page.locator(f'.pn-frame[data-pane="{target_id}"]')
    assert page.locator(".pn-frame").count() == pane_count
    other = page.locator(f'.pn-frame[data-pane="{first_id}"]')
    click_other = page.locator(f'.pn-frame[data-pane="{click_other_id}"]')
    assert other.count() == 1 and click_other.count() == 1

    target = focus_pane(page, target_id)
    dialog = open_agents_sheet(page, target)
    prefix = f"{engine}-{pane_count}pane"
    assert dialog.get_attribute("data-display-mode") == "in-pane"
    screenshot(page, f"{prefix}-01-in-pane.png")

    graph_frame = dialog.locator(".ag-graph-frame")
    graph_before = graph_frame.bounding_box()
    graph_svg = dialog.locator(".ag-graph-svg")
    graph_transform = graph_svg.locator(":scope > g").get_attribute("transform")

    dialog.get_by_role("button", name="Float panel").click()
    wait_for_sheet_popover(page, dialog)
    assert dialog.get_attribute("data-display-mode") == "float"
    assert_float_over_other_pane(dialog, target, other)
    graph_after_float = graph_frame.bounding_box()
    assert graph_before is not None and graph_after_float is not None
    assert graph_after_float["height"] > graph_before["height"] + 20, "Agents graph did not grow with its floating window"
    page.wait_for_function(
        "old => document.querySelector('.ag-graph-svg > g')?.getAttribute('transform') !== old",
        arg=graph_transform,
    )
    screenshot(page, f"{prefix}-02-float.png")
    window_element = dialog.element_handle()
    assert window_element is not None
    page.wait_for_function(
        "(element) => element.getAnimations().every(animation => animation.playState !== 'running')",
        arg=window_element,
        timeout=5_000,
    )


    baseline_geometry = dialog.bounding_box()
    assert baseline_geometry is not None
    assert_resize_fixed_edge(page, dialog, "se", 5_000, 5_000)
    screenshot(page, f"{prefix}-se-large-delta-fixed-edge.png")
    southeast = dialog.bounding_box()
    assert southeast is not None
    resize_panel(
        page,
        dialog,
        "se",
        baseline_geometry["width"] - southeast["width"],
        baseline_geometry["height"] - southeast["height"],
    )
    restored = dialog.bounding_box()
    assert restored is not None
    assert all(abs(restored[key] - baseline_geometry[key]) <= 1 for key in ("x", "y", "width", "height"))

    assert_resize_fixed_edge(page, dialog, "nw", -5_000, -5_000)
    screenshot(page, f"{prefix}-nw-large-delta-fixed-edge.png")
    northwest = dialog.bounding_box()
    assert northwest is not None
    resize_panel(
        page,
        dialog,
        "nw",
        baseline_geometry["x"] - northwest["x"],
        baseline_geometry["y"] - northwest["y"],
    )
    restored = dialog.bounding_box()
    assert restored is not None
    assert all(abs(restored[key] - baseline_geometry[key]) <= 1 for key in ("x", "y", "width", "height")), f"NW restore differs: baseline={baseline_geometry}, actual={restored}, clamped={northwest}"


    title = dialog.locator(".dk-sheet-title")
    title_box = title.bounding_box()
    assert title_box is not None
    start_x = title_box["x"] + title_box["width"] / 2
    start_y = title_box["y"] + title_box["height"] / 2
    panel_box = dialog.bounding_box()
    other_box = other.bounding_box()
    assert panel_box is not None and other_box is not None
    desired_window_top = other_box["y"] + 72 if pane_count == 2 else 16
    target_pointer_y = start_y + desired_window_top - panel_box["y"]
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    assert dialog.get_attribute("data-dragging") == "true"
    assert dialog.evaluate("el => getComputedStyle(el).transitionDuration") == "0s", "dragging animated the panel"
    page.mouse.move(max(20, start_x - 400), target_pointer_y, steps=8)
    page.mouse.up()
    page.wait_for_function("() => document.querySelector('.ag-sheet')?.style.transition === ''", timeout=5_000)
    assert dialog.evaluate("el => el.getAnimations().every(animation => animation.playState !== 'running')"), "drag release animated the panel"
    assert_float_over_other_pane(dialog, target, other)
    screenshot(page, f"{prefix}-03-dragged.png")

    composer = click_other.locator("textarea.sh-composer-input").first
    composer_point = point_outside_panel(dialog, composer)
    page.mouse.click(composer_point["x"], composer_point["y"])
    assert composer.evaluate("el => document.activeElement === el"), "other pane composer did not receive focus"
    assert dialog.is_visible(), "clicking another pane dismissed the floating window"
    screenshot(page, f"{prefix}-04-other-pane.png")
    page.keyboard.press("Escape")
    assert dialog.is_visible(), "Escape in another pane's composer closed the floating window"
    screenshot(page, f"{prefix}-05-other-pane-escape.png")
    exercise_agents_overlays(page, dialog, prefix, "float")
    exercise_other_pane_popovers(page, click_other, prefix)
    focus_pane(page, click_other_id)
    exercise_spawn_clickthrough(page, composer, prefix)

    box_before_resize = dialog.bounding_box()
    handle = dialog.locator('.dk-sheet-resize-handle[data-edge="se"]')
    handle_box = handle.bounding_box()
    assert box_before_resize is not None and handle_box is not None
    page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
    page.mouse.down()
    assert dialog.get_attribute("data-resizing") == "true"
    assert dialog.evaluate("el => getComputedStyle(el).transitionDuration") == "0s", "resizing animated the panel"
    page.mouse.move(handle_box["x"] + handle_box["width"] / 2 + 100,
                    handle_box["y"] + handle_box["height"] / 2 + 70, steps=8)
    page.mouse.up()
    page.wait_for_function("() => document.querySelector('.ag-sheet')?.style.transition === ''", timeout=5_000)
    assert dialog.evaluate("el => el.getAnimations().every(animation => animation.playState !== 'running')"), "resize release animated the panel"
    box_after_resize = dialog.bounding_box()
    assert box_after_resize is not None
    assert box_after_resize["width"] > box_before_resize["width"]
    assert box_after_resize["height"] > box_before_resize["height"]
    assert box_after_resize["width"] >= 420 and box_after_resize["height"] >= 300
    graph_after_resize = graph_frame.bounding_box()
    assert graph_after_resize is not None and graph_after_resize["width"] > graph_after_float["width"]
    assert_float_over_other_pane(dialog, target, other)
    screenshot(page, f"{prefix}-06-resized.png")
    if engine == "chromium":
        assert_lost_pointer_capture_ends_resize(page, dialog)


    title.dblclick()
    page.wait_for_function("() => document.querySelector('.ag-sheet')?.getAttribute('data-display-mode') === 'maximized'", timeout=5_000)
    assert dialog.get_attribute("data-display-mode") == "maximized", "double-click did not maximize"
    max_box = dialog.bounding_box()
    assert max_box is not None
    assert max_box["x"] >= 12 and max_box["y"] >= 12
    assert max_box["x"] + max_box["width"] <= DESKTOP_VIEWPORT["width"] - 12
    assert max_box["y"] + max_box["height"] <= DESKTOP_VIEWPORT["height"] - 12
    screenshot(page, f"{prefix}-07-double-click-maximized.png")

    title.dblclick()
    page.wait_for_function("() => document.querySelector('.ag-sheet')?.getAttribute('data-display-mode') === 'float'", timeout=5_000)
    assert dialog.get_attribute("data-display-mode") == "float", "double-click did not restore the previous mode"
    screenshot(page, f"{prefix}-08-double-click-restored.png")

    dialog.get_by_role("button", name="Maximize panel").click()
    assert dialog.get_attribute("data-display-mode") == "maximized"
    screenshot(page, f"{prefix}-09-maximized.png")
    exercise_agents_overlays(page, dialog, prefix, "maximized")

    dialog.get_by_role("button", name="Show in pane").click()
    assert dialog.get_attribute("data-display-mode") == "in-pane"
    assert not dialog.evaluate("el => el.closest('.dk-sheet-root').matches(':popover-open')")
    screenshot(page, f"{prefix}-10-in-pane-again.png")

    if pane_count == 2:
        focus_pane(page, first_id)
        top_window = open_agents_sheet(page, other)
        lower_window = dialog
        lower_window.get_by_role("button", name="Float panel").click()
        wait_for_sheet_popover(page, lower_window)
        assert lower_window.get_attribute("data-display-mode") == "float"
        top_window.get_by_role("button", name="Float panel").click()
        wait_for_sheet_popover(page, top_window)
        page.wait_for_function("() => document.querySelectorAll('.ag-sheet-root:popover-open').length === 2")
        lower_box = lower_window.bounding_box()
        top_box = top_window.bounding_box()
        assert lower_box is not None and top_box is not None
        assert lower_box["x"] != top_box["x"] or lower_box["y"] != top_box["y"], "simultaneous Agents windows opened exactly on top of each other"
        exposed = {"x": lower_box["x"] + 8, "y": lower_box["y"] + lower_box["height"] / 2}
        assert lower_window.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", exposed)
        page.mouse.click(exposed["x"], exposed["y"])
        overlap = {
            "x": (max(lower_box["x"], top_box["x"]) + min(lower_box["x"] + lower_box["width"], top_box["x"] + top_box["width"])) / 2,
            "y": (max(lower_box["y"], top_box["y"]) + min(lower_box["y"] + lower_box["height"], top_box["y"] + top_box["height"])) / 2,
        }
        assert lower_window.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", overlap), "clicking a floating Agents window did not bring it to the front"
        screenshot(page, f"{prefix}-agents-window-front.png")
        top_exposed = {"x": top_box["x"] + top_box["width"] - 8, "y": top_box["y"] + top_box["height"] / 2}
        assert top_window.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", top_exposed)
        page.mouse.click(top_exposed["x"], top_exposed["y"])
        assert top_window.evaluate("(el, p) => el.contains(document.elementFromPoint(p.x, p.y))", top_exposed)
        top_window.get_by_role("button", name="Show in pane").click()
        assert top_window.get_attribute("data-display-mode") == "in-pane"
        lower_window.get_by_role("tab", name="Tree").click()
        page.keyboard.press("Escape")
        lower_window.wait_for(state="detached", timeout=5_000)
        assert top_window.is_visible(), "Escape inside the lower floating sheet closed the upper in-pane sheet"
        screenshot(page, f"{prefix}-sibling-sheet-escape.png")
        top_window.get_by_role("button", name="close Agents").click()
        top_window.wait_for(state="detached", timeout=5_000)

    context.close()


def exercise_phone(browser: Browser) -> None:
    context = browser.new_context(viewport=PHONE_VIEWPORT)
    page = context.new_page()
    page.add_init_script(
        """() => localStorage.setItem("omp-console.sheet-window.v1:agents", JSON.stringify({
          version: 1, mode: "maximized", geometry: { x: 12, y: 12, width: 1000, height: 700 }
        }))"""
    )
    page.goto(f"{BASE_URL}/#session={quote('agent-tree', safe='')}", wait_until="domcontentloaded")
    pane = wait_for_session_pane(page)
    pane.get_by_role("button", name="Open sessions", exact=True).click()
    dialog = sheet_with_title(page, "Sessions")
    dialog.wait_for(state="visible", timeout=5_000)
    dialog.locator("nav.dk-side").wait_for(state="visible", timeout=10_000)
    assert dialog.get_attribute("data-size") == "full"
    assert dialog.get_attribute("data-display-mode") == "in-pane"
    assert dialog.get_by_role("button", name="Float panel").count() == 0
    wait_for_sheet_animations(page, "Sessions")
    box = dialog.bounding_box()
    assert box is not None and box["y"] <= 1 and box["height"] >= PHONE_VIEWPORT["height"] - 1
    screenshot(page, "webkit-phone-session-bottom-sheet.png")
    dialog.get_by_role("button", name="close Sessions").click()
    dialog.wait_for(state="detached", timeout=5_000)

    agents = open_agents_sheet(page, pane)
    agents_size = agents.get_attribute("data-size")
    assert agents_size == "full", f"phone Agents sheet size={agents_size}, viewport={page.evaluate('window.innerWidth')}, box={agents.bounding_box()}"
    assert agents.get_attribute("data-display-mode") == "in-pane"
    assert agents.get_by_role("button", name="Float panel").count() == 0
    assert not agents.evaluate("el => el.closest('.dk-sheet-root').hasAttribute('popover')"), "phone Agents sheet entered the top layer"
    wait_for_sheet_animations(page, "Agents")
    box = agents.bounding_box()
    screenshot(page, "webkit-phone-agents-bottom-sheet.png")
    root_box = agents.evaluate(
        """el => {
          const rect = el.closest(".dk-sheet-root").getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }"""
    )
    assert box is not None and all(abs(box[key] - root_box[key]) <= 1 for key in ("x", "y", "width", "height")), (
        f"phone Agents sheet no longer fills its sheet root: {box=} {root_box=}"
    )
    assert root_box["y"] + root_box["height"] >= PHONE_VIEWPORT["height"] - 1
    agents.get_by_role("button", name="close Agents").click()
    agents.wait_for(state="detached", timeout=5_000)
    context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=("webkit", "chromium"), required=True)
    parser.add_argument("--layouts", type=int, nargs="+", choices=(2, 4), default=(2, 4))
    parser.add_argument("--phone", action="store_true", help="also capture the unchanged phone session sheet (WebKit only)")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        if args.engine == "webkit":
            browser = playwright.webkit.launch(headless=True)
        else:
            assert CHROMIUM.is_file(), f"Chromium headless shell not found: {CHROMIUM}"
            browser = playwright.chromium.launch(headless=True, executable_path=str(CHROMIUM))
        try:
            if args.phone:
                assert args.engine == "webkit", "phone screenshot is captured on WebKit"
            for pane_count in args.layouts:
                exercise_desktop(browser, args.engine, pane_count)
            if args.phone:
                exercise_phone(browser)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
