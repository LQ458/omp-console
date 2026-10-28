from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import drive

SIZES = [
    (800, 600),
    (1024, 700),
    (1280, 800),
    (1440, 900),
    (1728, 1117),
    (2560, 1440),
    (520, 800),
]
MODEL = "openai-codex/gpt-6-luna"
DRAFT_PREFIX = "omp console.app crash-relaunch draft "

CONSOLE_HOOK_JS = r"""(() => {
    const errors = window.__deckAutomationConsoleErrors ?? (window.__deckAutomationConsoleErrors = []);
    if (!window.__deckAutomationConsoleHooked) {
        const original = console.error.bind(console);
        console.error = (...args) => {
            errors.push(args.map(value => String(value)).join(" "));
            original(...args);
        };
        window.addEventListener("error", event => errors.push(`error: ${event.message}`));
        window.addEventListener("unhandledrejection", event => errors.push(`rejection: ${String(event.reason)}`));
        window.__deckAutomationConsoleHooked = true;
    }
    return {installed: true, count: errors.length};
})()"""

DOM_CHECK_JS = r"""(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const height = root.clientHeight;
    const visible = element => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const outside = [...document.querySelectorAll("body *")].filter(element => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return (rect.left < -1 && rect.right > 0) || (rect.right > width + 1 && rect.left < width) ||
            (rect.top < -1 && rect.bottom > 0) || (rect.bottom > height + 1 && rect.top < height);
    }).slice(0, 20).map(element => {
        const rect = element.getBoundingClientRect();
        return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className.slice(0, 100) : "",
            text: (element.innerText || element.textContent || "").trim().slice(0, 80),
            rect: [rect.left, rect.top, rect.right, rect.bottom].map(value => Math.round(value)),
        };
    });
    const clippedButtons = [...document.querySelectorAll("button, button *")].filter(element => {
        if (element.children.length !== 0 || !(element.textContent || "").trim() || !visible(element)) return false;
        const style = getComputedStyle(element);
        return element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== "ellipsis";
    }).slice(0, 20).map(element => ({
        text: (element.textContent || "").trim().slice(0, 80),
        className: typeof element.className === "string" ? element.className.slice(0, 100) : "",
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        textOverflow: getComputedStyle(element).textOverflow,
    }));
    const regions = [...document.querySelectorAll("main, [role=main]")];
    const visibleText = (regions.length ? regions.map(element => element.innerText).join("\n") : document.body.innerText || "").trim();
    return {
        viewport: {width, height},
        document: {scrollWidth: root.scrollWidth, clientWidth: width, scrollHeight: root.scrollHeight, clientHeight: height},
        horizontalOverflow: root.scrollWidth > width + 1,
        outside,
        clippedButtons,
        consoleErrors: window.__deckAutomationConsoleErrors || [],
        visibleText: visibleText.slice(0, 5000),
    };
})()"""

CRASH_STATE_JS = r"""(() => {
    const layout = JSON.parse(localStorage.getItem("omp-console-layout:current") || "null");
    const paneText = document.querySelector(".pn-bar-count")?.textContent?.trim() || "";
    const countMatch = paneText.match(/\d+/);
    const draftKey = "omp-console-composer-draft:" + __SESSION_ID__;
    const input = [...document.querySelectorAll("textarea.sh-composer-input")].find(element => !element.disabled);
    return {
        layoutCount: Array.isArray(layout?.panes) ? layout.panes.length : 0,
        visiblePaneCount: countMatch ? Number(countMatch[0]) : 0,
        paneText,
        composerCount: document.querySelectorAll("textarea.sh-composer-input").length,
        draft: localStorage.getItem(draftKey),
        composerText: input?.value ?? null,
        visibleText: (document.querySelector("main, [role=main]")?.innerText || document.body.innerText || "").trim().slice(0, 3000),
        consoleErrors: window.__deckAutomationConsoleErrors || [],
    };
})()"""


def _write_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def _api_request(daemon_url: str, path: str, *, method: str = "GET", body: object | None = None, timeout: float = 120) -> Any:
    url = urllib.parse.urljoin(daemon_url.rstrip("/") + "/", path.lstrip("/"))
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            if not payload:
                return None
            return json.loads(payload)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"daemon {method} {path} returned HTTP {error.code}: {detail}") from error


def _create_session(daemon_url: str, cwd: Path, title: str) -> dict[str, Any]:
    response = _api_request(
        daemon_url,
        "/api/sessions",
        method="POST",
        body={"cwd": str(cwd), "model": MODEL, "title": title},
    )
    if not isinstance(response, dict) or not isinstance(response.get("id"), str):
        raise RuntimeError(f"daemon returned an invalid session response: {response!r}")
    return response


def _delete_session(daemon_url: str, session_id: str) -> None:
    quoted_id = urllib.parse.quote(session_id, safe="")
    _api_request(daemon_url, f"/api/sessions/{quoted_id}", method="DELETE", timeout=30)


def _failure(findings: list[dict[str, str]], name: str, detail: object, *, severity: str = "error") -> None:
    findings.append({"severity": severity, "what": name, "evidence": str(detail)})


def _assertion(name: str, passed: bool, detail: object, findings: list[dict[str, str]]) -> dict[str, object]:
    rendered = str(detail)
    if not passed:
        _failure(findings, name, rendered)
    return {"name": name, "pass": passed, "detail": rendered}


def _eval_retry(js: str, timeout: float = 30) -> object:
    deadline = time.monotonic() + timeout
    last_error = "webview did not answer"
    while time.monotonic() < deadline:
        try:
            return drive.send("eval", js=js)
        except drive.DriveError as error:
            last_error = str(error)
            time.sleep(0.25)
    raise RuntimeError(last_error)


def _wait_for_page(timeout: float = 40) -> None:
    deadline = time.monotonic() + timeout
    last_error = "webview document is not ready"
    while time.monotonic() < deadline:
        try:
            ready = drive.send("eval", js='document.readyState === "complete"')
            if ready is True:
                return
            last_error = f"document.readyState was {ready!r}"
        except drive.DriveError as error:
            last_error = str(error)
        time.sleep(0.25)
    raise RuntimeError(last_error)


def _console_hook(findings: list[dict[str, str]]) -> bool:
    try:
        result = _eval_retry(CONSOLE_HOOK_JS)
        return isinstance(result, dict) and result.get("installed") is True
    except Exception as error:
        _failure(findings, "console error capture hook installed", error)
        return False


def _size_moment(
    width: int,
    height: int,
    screenshot: Path,
    findings: list[dict[str, str]],
) -> dict[str, object]:
    assertions: list[dict[str, object]] = []
    bounds: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    screenshot_path: str | None = None
    capture: object | None = None
    try:
        result = drive.send("resize", width=width, height=height)
        bounds = result if isinstance(result, dict) else None
    except Exception as error:
        assertions.append(_assertion("window resized to requested logical points", False, error, findings))
    actual_size = bounds.get("size") if bounds is not None else None
    reached = (
        isinstance(actual_size, dict)
        and abs(float(actual_size.get("width", -10000)) - width) <= 2
        and abs(float(actual_size.get("height", -10000)) - height) <= 2
    )
    assertions.append(_assertion("window resized to requested logical points", reached, {"requested": [width, height], "actual": actual_size}, findings))

    try:
        time.sleep(0.4)
        capture = drive.snapshot(screenshot)
        if screenshot.is_file() and screenshot.stat().st_size > 0:
            screenshot_path = str(screenshot)
        capture_ok = (
            isinstance(capture, dict)
            and capture.get("blank") is False
            and screenshot_path is not None
        )
        capture_detail = capture
        if isinstance(capture, dict) and capture.get("blank") is True:
            capture_detail = {"error": "blank snapshot", "capture": capture}
        assertions.append(
            _assertion(
                "real omp console.app window snapshot is non-blank",
                capture_ok,
                capture_detail,
                findings,
            )
        )
    except Exception as error:
        assertions.append(_assertion("real omp console.app window snapshot is non-blank", False, error, findings))

    try:
        data = drive.send("eval", js=DOM_CHECK_JS)
        metrics = data if isinstance(data, dict) else None
    except Exception as error:
        assertions.append(_assertion("DOM checks completed", False, error, findings))
    if metrics is not None:
        document = metrics.get("document", {})
        viewport = metrics.get("viewport", {})
        assertions.extend(
            [
                _assertion(
                    "document has no horizontal overflow",
                    metrics.get("horizontalOverflow") is False,
                    {"document": document, "viewport": viewport},
                    findings,
                ),
                _assertion(
                    "no visible elements cross a viewport edge",
                    not metrics.get("outside"),
                    metrics.get("outside"),
                    findings,
                ),
                _assertion(
                    "button labels are not clipped without ellipsis",
                    not metrics.get("clippedButtons"),
                    metrics.get("clippedButtons"),
                    findings,
                ),
                _assertion(
                    "no captured console errors",
                    not metrics.get("consoleErrors"),
                    metrics.get("consoleErrors"),
                    findings,
                ),
            ]
        )
    return {
        "id": f"macapp-window-{width}x{height}",
        "question": f"At {width}×{height}, can the user read the omp console screen without horizontal overflow, clipped controls, or browser errors?",
        "screenshot": screenshot_path,
        "snapshot_capture": capture,
        "visible_text": metrics.get("visibleText", "") if metrics is not None else "",
        "assertions": assertions,
        "bounds": bounds,
        "dom": metrics,
    }



def _seed_two_panes(session_ids: list[str], findings: list[dict[str, str]]) -> None:
    if len(session_ids) != 2:
        raise RuntimeError(f"expected exactly two live test sessions, got {len(session_ids)}")

    reset = drive.send(
        "eval",
        js=(
            '(() => { const keys = Object.keys(localStorage).filter(key => key.startsWith("omp-console-layout:")); '
            'for (const key of keys) localStorage.removeItem(key); '
            'const remaining = Object.keys(localStorage).filter(key => key.startsWith("omp-console-layout:")); '
            'return {removed: keys, remaining}; })()'
        ),
    )
    if not isinstance(reset, dict) or reset.get("remaining") != []:
        raise RuntimeError(f"could not clear stored pane layouts before staging: {reset!r}")
    reloaded = drive.send("reload")
    if not isinstance(reloaded, dict) or reloaded.get("reloaded") is not True:
        raise RuntimeError(f"could not reload the clean pane layout: {reloaded!r}")
    _wait_for_page()
    if not _console_hook(findings):
        raise RuntimeError("could not reinstall the console error hook after clearing pane layouts")

    def open_session(title: str) -> None:
        js = (
            "(() => {"
            'const buttons=[...document.querySelectorAll("button.dk-card-open")];'
            f"const button=buttons.find(element=>element.innerText.includes({json.dumps(title)}));"
            "if(!button||button.disabled)return {clicked:false,candidates:buttons.map(element=>({text:element.innerText,disabled:element.disabled,title:element.title}))};"
            "button.click();"
            "return {clicked:true};"
            "})()"
        )
        opened = drive.send("eval", js=js)
        if not isinstance(opened, dict) or opened.get("clicked") is not True:
            raise RuntimeError(f"could not open live session card {title!r}: {opened!r}")

    open_session("omp console macOS automation 1")
    time.sleep(0.5)
    first_open = _eval_retry(
        f'JSON.parse(localStorage.getItem("omp-console-layout:current")||"null")?.panes?.some(pane=>pane.sessionId==={json.dumps(session_ids[0])})===true',
        timeout=10,
    )
    if first_open is not True:
        raise RuntimeError("opening the first session did not persist it in the focused pane")

    split = drive.send(
        "eval",
        js='(() => { const button=document.querySelector(\'button[aria-label="split pane right"]\'); if(!button)return false; button.click(); return true; })()',
    )
    if split is not True:
        raise RuntimeError("the pane toolbar did not expose its split-right control")
    open_session("omp console macOS automation 2")

    ready_js = (
        '(() => { const layout=JSON.parse(localStorage.getItem("omp-console-layout:current")||"null"); '
        'return layout?.panes?.length===2 && '
        f'layout.panes.some(pane=>pane.sessionId==={json.dumps(session_ids[0])}) && '
        f'layout.panes.some(pane=>pane.sessionId==={json.dumps(session_ids[1])}) && '
        'document.querySelector(".pn-bar-count")?.textContent?.includes("2 panes")===true && '
        'document.querySelector("textarea.sh-composer-input")!==null; })()'
    )
    deadline = time.monotonic() + 45
    ready = False
    while time.monotonic() < deadline:
        try:
            ready = drive.send("eval", js=ready_js) is True
        except drive.DriveError:
            ready = False
        if ready:
            break
        time.sleep(0.2)
    if ready:
        return
    observed = _eval_retry(
        """({
            storedLayout: localStorage.getItem("omp-console-layout:current"),
            viewport: [innerWidth, innerHeight],
            paneCount: document.querySelector(".pn-bar-count")?.textContent || null,
            composers: document.querySelectorAll("textarea.sh-composer-input").length,
            visibleText: (document.querySelector("main, [role=main]")?.innerText || document.body.innerText || "").trim().slice(0, 1000)
        })""",
        timeout=10,
    )
    raise RuntimeError(f"the two UI-opened sessions did not render as two panes with a composer: {observed!r}")


def _set_composer_draft(session_id: str, draft: str) -> dict[str, Any]:
    js = (
        "(() => {"
        f"const draft={json.dumps(draft)};"
        'const input=[...document.querySelectorAll("textarea.sh-composer-input")].find(element=>!element.disabled);'
        'if(!input)return {typed:false,reason:"no enabled composer"};'
        'const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;'
        'setter.call(input,draft);'
        'input.dispatchEvent(new Event("input",{bubbles:true}));'
        'return {typed:true,value:input.value};'
        "})()"
    )
    typed = drive.send("eval", js=js)
    if not isinstance(typed, dict) or typed.get("typed") is not True or typed.get("value") != draft:
        raise RuntimeError(f"composer did not accept the draft: {typed!r}")
    drive.send("eval", js="new Promise(resolve => setTimeout(() => resolve(true), 700))")
    state = _eval_retry(CRASH_STATE_JS.replace("__SESSION_ID__", json.dumps(session_id)))
    if not isinstance(state, dict):
        raise RuntimeError("could not read the pre-crash pane and draft state")
    return state


def _restart_moment(
    run_directory: Path,
    session_ids: list[str],
    findings: list[dict[str, str]],
) -> tuple[dict[str, object], dict[str, object]]:
    screenshot = run_directory / "crash-relaunch.png"
    assertions: list[dict[str, object]] = []
    result: dict[str, object] = {}
    visible_text = ""
    capture: object | None = None
    try:
        desktop_bounds = drive.send("resize", width=1024, height=700)
        desktop_size = desktop_bounds.get("size") if isinstance(desktop_bounds, dict) else None
        if (
            not isinstance(desktop_size, dict)
            or abs(float(desktop_size.get("width", -1)) - 1024) > 2
            or abs(float(desktop_size.get("height", -1)) - 700) > 2
        ):
            raise RuntimeError(f"could not return to desktop pane mode: {desktop_size!r}")
        time.sleep(0.4)
        _seed_two_panes(session_ids, findings)
        draft = DRAFT_PREFIX + datetime.now(timezone.utc).strftime("%H:%M:%S.%f UTC")
        before = _set_composer_draft(session_ids[0], draft)
        before_draft_ok = before.get("composerText") == draft and before.get("draft") == draft
        assertions.append(
            _assertion(
                "pre-crash typed draft reached the per-session durable draft store",
                before_draft_ok,
                {"composerText": before.get("composerText"), "storedDraft": before.get("draft")},
                findings,
            )
        )
        before_panes_ok = before.get("layoutCount") == 2 and before.get("visiblePaneCount") == 2
        assertions.append(
            _assertion(
                "pre-crash UI has two open panes",
                before_panes_ok,
                {"layoutCount": before.get("layoutCount"), "paneText": before.get("paneText")},
                findings,
            )
        )
        crash_result = drive.crash()
        relaunch_result = drive.relaunch()
        _wait_for_page()
        _console_hook(findings)
        after = _eval_retry(CRASH_STATE_JS.replace("__SESSION_ID__", json.dumps(session_ids[0])), timeout=45)
        if not isinstance(after, dict):
            raise RuntimeError("could not read the restored UI state")
        visible_text = str(after.get("visibleText", ""))
        draft_restored = after.get("composerText") == draft and after.get("draft") == draft
        panes_restored = after.get("layoutCount") == 2 and after.get("visiblePaneCount") == 2
        assertions.extend(
            [
                _assertion(
                    "unsent composer draft restored after SIGKILL and relaunch",
                    draft_restored,
                    {"expected": draft, "composerText": after.get("composerText"), "storedDraft": after.get("draft")},
                    findings,
                ),
                _assertion(
                    "both open panes restored after SIGKILL and relaunch",
                    panes_restored,
                    {"layoutCount": after.get("layoutCount"), "paneText": after.get("paneText"), "composerCount": after.get("composerCount")},
                    findings,
                ),
                _assertion(
                    "crash relaunch UI has no captured console errors",
                    not after.get("consoleErrors"),
                    after.get("consoleErrors"),
                    findings,
                ),
            ]
        )
        capture = drive.snapshot(screenshot)
        screenshot_path = str(screenshot) if screenshot.is_file() and screenshot.stat().st_size > 0 else None
        capture_ok = isinstance(capture, dict) and capture.get("blank") is False and screenshot_path is not None
        capture_detail = capture
        if isinstance(capture, dict) and capture.get("blank") is True:
            capture_detail = {"error": "blank snapshot", "capture": capture}
        assertions.append(_assertion("post-relaunch omp console.app snapshot is non-blank", capture_ok, capture_detail, findings))
        result = {"crash": crash_result, "relaunch": relaunch_result, "before": before, "after": after, "snapshot_capture": capture}
        return (
            {
                "id": "macapp-crash-relaunch",
                "question": "After force quit and relaunch, did the unsent draft and both open panes come back?",
                "screenshot": screenshot_path,
                "snapshot_capture": capture,
                "visible_text": visible_text,
                "assertions": assertions,
            },
            result,
        )
    except Exception as error:
        assertions.append(_assertion("crash/relaunch draft and pane scenario completed", False, error, findings))
        result["error"] = str(error)
        return (
            {
                "id": "macapp-crash-relaunch",
                "question": "After force quit and relaunch, did the unsent draft and both open panes come back?",
                "screenshot": str(screenshot) if screenshot.is_file() else None,
                "snapshot_capture": capture,
                "visible_text": visible_text,
                "assertions": assertions,
            },
            result,
        )


def run(daemon_url: str, output_root: Path) -> tuple[Path, dict[str, object]]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f"{datetime.now(timezone.utc).microsecond:06d}Z"
    run_directory = output_root / stamp / "macapp"
    run_directory.mkdir(parents=True, mode=0o700)
    run_directory.chmod(0o700)
    sessions: list[str] = []
    moments: list[dict[str, object]] = []
    findings: list[dict[str, str]] = []
    started = time.monotonic()
    app_launched = False
    result: dict[str, object] = {
        "scenario": "macapp-window-matrix",
        "engine": "WKWebView",
        "pass": False,
        "findings": findings,
        "timings": {},
        "snapshots": [],
    }

    try:
        project = Path("/tmp/omp-console-nightly/macapp-projects/fixture").resolve()
        project.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            for index in range(2):
                session = _create_session(daemon_url, project, f"omp console macOS automation {index + 1}")
                sessions.append(session["id"])
            result["test_sessions"] = sessions
        except Exception as error:
            _failure(findings, "two isolated Luna test sessions created without sending prompts", error)

        try:
            launch_result = drive.launch(daemon_url, run_directory)
            app_launched = True
            result["launch"] = launch_result
            _wait_for_page()
            _console_hook(findings)
        except Exception as error:
            _failure(findings, "automation omp console.app launched and reached the configured daemon", error)

        if app_launched:
            for width, height in SIZES:
                size_started = time.monotonic()
                screenshot = run_directory / f"window-{width}x{height}.png"
                moment = _size_moment(width, height, screenshot, findings)
                moments.append(moment)
                result["snapshots"].append(moment["screenshot"])
                timings = result["timings"]
                if isinstance(timings, dict):
                    timings[f"{width}x{height}_seconds"] = round(time.monotonic() - size_started, 3)

            if len(sessions) == 2:
                restart_moment, restart_result = _restart_moment(run_directory, sessions, findings)
                moments.append(restart_moment)
                result["crash_relaunch"] = restart_result
                result["snapshots"].append(restart_moment["screenshot"])
            else:
                _failure(findings, "crash/relaunch draft and pane scenario had two live sessions", "session setup failed")
        else:
            for width, height in SIZES:
                moments.append(
                    {
                        "id": f"macapp-window-{width}x{height}",
                        "question": f"At {width}×{height}, can the user read the omp console screen without overflow or clipped controls?",
                        "screenshot": None,
                        "visible_text": "",
                        "assertions": [{"name": "omp console.app launched", "pass": False, "detail": "launch failed"}],
                    }
                )
    except Exception as error:
        _failure(findings, "window matrix completed", error)
    finally:
        try:
            restore = drive.restore_production(run_directory)
            app_launched = False
            result["production_restore"] = restore
        except Exception as error:
            _failure(findings, "omp console.app restored to a normal production launch", error)
        for session_id in sessions:
            try:
                _delete_session(daemon_url, session_id)
            except Exception as error:
                _failure(findings, "sandbox test session cleaned up", error, severity="warning")
        result["timings"]["duration_seconds"] = round(time.monotonic() - started, 3)
        result["pass"] = not any(finding["severity"] == "error" for finding in findings)
        _write_json(run_directory / "moments.json", moments)
        _write_json(run_directory / "result.json", result)
    return run_directory, result


def main() -> int:
    parser = argparse.ArgumentParser(description="Exercise the real omp console.app WKWebView across the required window sizes.")
    parser.add_argument("--daemon", default="http://127.0.0.1:7592/", help="sandbox daemon URL")
    parser.add_argument("--out", type=Path, default=Path("/tmp/omp-console-nightly/runs"), help="scenario output root")
    arguments = parser.parse_args()
    try:
        output, result = run(arguments.daemon, arguments.out.expanduser().resolve())
    except Exception as error:
        print(f"window-matrix.py: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"output": str(output), "pass": result.get("pass"), "findings": result.get("findings", [])}, indent=2))
    return 0 if result.get("pass") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
