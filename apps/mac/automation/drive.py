from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

BUNDLE_ID = "dev.ompconsole.app"
DEFAULT_STATE_DIR = Path("/tmp/omp-console-nightly/macapp")
STATE_ENV = "OMP_CONSOLE_AUTOMATION_STATE_DIR"
MAC_DIR = Path(__file__).resolve().parents[1]
APP_PATH = MAC_DIR / "dist" / "omp console.app"
APP_EXECUTABLE = APP_PATH / "Contents" / "MacOS" / "deck-mac"


class DriveError(RuntimeError):
    pass


def _state_directory(value: Path | None = None) -> Path:
    selected = value or Path(os.environ.get(STATE_ENV, DEFAULT_STATE_DIR))
    return selected.expanduser().resolve()


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def _atomic_text(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(text)
    os.replace(temporary, path)
    path.chmod(0o600)


def _write_state(state_directory: Path, state: dict[str, object]) -> None:
    _atomic_text(state_directory / "drive-state.json", json.dumps(state, separators=(",", ":")))


def _read_state(state_directory: Path) -> dict[str, object]:
    try:
        state = json.loads((state_directory / "drive-state.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DriveError(f"omp console driver state is unavailable: {error}") from error
    if not isinstance(state, dict):
        raise DriveError("omp console driver state is malformed")
    return state


def _process_command(pid: int) -> str | None:
    result = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    command = result.stdout.strip()
    return command if result.returncode == 0 and command else None


def _is_deck_pid(pid: int) -> bool:
    command = _process_command(pid)
    return command is not None and command.split(maxsplit=1)[0] == str(APP_EXECUTABLE)


def _deck_pids() -> list[int]:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    pids: list[int] = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if fields[1].split(maxsplit=1)[0] == str(APP_EXECUTABLE):
            pids.append(pid)
    return pids


def _quit_existing_app() -> None:
    completed = subprocess.run(
        ["/usr/bin/osascript", "-e", f'quit app id "{BUNDLE_ID}"'],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if completed.returncode != 0 and _deck_pids():
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise DriveError(f"osascript could not quit omp console.app: {detail}")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if not _deck_pids():
            return
        time.sleep(0.1)
    raise DriveError("omp console.app did not quit after the AppleScript quit request")


def _start_app(state_directory: Path, *, automation: bool, daemon_url: str | None = None) -> int:
    if not APP_EXECUTABLE.is_file():
        raise DriveError(f"omp console.app executable is missing; build it first: {APP_EXECUTABLE}")
    _private_directory(state_directory)
    environment = os.environ.copy()
    environment.pop("OMP_CONSOLE_AUTOMATION_DIR", None)
    environment.pop("OMP_CONSOLE_DAEMON_URL_FILE", None)
    environment.pop(STATE_ENV, None)

    state: dict[str, object] = {
        "mode": "automation" if automation else "production",
        "launched_by_drive": True,
        "app_executable": str(APP_EXECUTABLE),
    }
    launch_command = [
        "/usr/bin/open",
        "-n",
        "-a",
        str(APP_PATH),
        "--stdout",
        str(state_directory / "omp-console-app.stdout.log"),
        "--stderr",
        str(state_directory / "omp-console-app.stderr.log"),
    ]
    if automation:
        if daemon_url is None:
            raise DriveError("automation launch requires a daemon URL")
        automation_directory = state_directory / "automation"
        _private_directory(automation_directory)
        for child in (automation_directory / "cmd", automation_directory / "out"):
            _private_directory(child)
        daemon_file = state_directory / "daemon-url"
        _atomic_text(daemon_file, daemon_url)
        state.update({"automation_dir": str(automation_directory), "daemon_url": daemon_url})
        launch_command.extend(
            [
                "--env",
                f"OMP_CONSOLE_AUTOMATION_DIR={automation_directory}",
                "--env",
                f"OMP_CONSOLE_DAEMON_URL_FILE={daemon_file}",
            ]
        )

    before = set(_deck_pids())
    completed = subprocess.run(
        launch_command,
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=environment,
    )
    if completed.returncode != 0:
        for pid in set(_deck_pids()) - before:
            _stop_started_process(pid)
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise DriveError(f"LaunchServices could not open omp console.app: {detail}")

    deadline = time.monotonic() + 20
    pid: int | None = None
    while time.monotonic() < deadline:
        new_pids = sorted(set(_deck_pids()) - before)
        if len(new_pids) == 1:
            pid = new_pids[0]
            break
        if len(new_pids) > 1:
            for started_pid in new_pids:
                _stop_started_process(started_pid)
            raise DriveError("LaunchServices started multiple omp console.app processes")
        time.sleep(0.05)
    if pid is None:
        raise DriveError("LaunchServices did not start omp console.app")
    state["pid"] = pid
    _write_state(state_directory, state)
    activation_script = f'tell application "System Events" to set frontmost of first application process whose unix id is {pid} to true'
    try:
        activation = subprocess.run(
            ["/usr/bin/osascript", "-e", activation_script],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        _stop_started_process(pid)
        raise DriveError(f"could not activate omp console.app: {error}") from error
    if activation.returncode != 0:
        _stop_started_process(pid)
        detail = activation.stderr.strip() or activation.stdout.strip()
        raise DriveError(f"could not activate omp console.app: {detail}")
    return pid


def _stop_started_process(pid: int) -> None:
    if not _is_deck_pid(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and _is_deck_pid(pid):
        time.sleep(0.05)
    if _is_deck_pid(pid):
        os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and _is_deck_pid(pid):
            time.sleep(0.05)


def _send(op: str, state_directory: Path, args: dict[str, object], timeout: float) -> object:
    state = _read_state(state_directory)
    if state.get("mode") != "automation":
        raise DriveError("omp console.app was not launched in automation mode")
    try:
        pid = int(state["pid"])
        automation_directory = Path(str(state["automation_dir"]))
    except (KeyError, TypeError, ValueError) as error:
        raise DriveError("omp console driver state lacks the automation process") from error
    if not _is_deck_pid(pid):
        raise DriveError(f"automation omp console.app process {pid} is not running")

    command_name = f"{time.time_ns()}-{os.getpid()}.json"
    command_path = automation_directory / "cmd" / command_name
    output_path = automation_directory / "out" / command_name
    payload = {"op": op, **args}
    _atomic_text(command_path, json.dumps(payload, separators=(",", ":")))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if output_path.is_file():
            try:
                response = json.loads(output_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise DriveError(f"invalid automation response: {error}") from error
            output_path.unlink(missing_ok=True)
            if not isinstance(response, dict) or response.get("ok") is not True:
                detail = response.get("error", "unknown automation error") if isinstance(response, dict) else "malformed response"
                raise DriveError(str(detail))
            return response.get("result")
        if not _is_deck_pid(pid):
            raise DriveError(f"automation omp console.app process {pid} exited before replying")
        time.sleep(0.05)
    raise DriveError(f"omp console.app did not answer {op!r} within {timeout:g} seconds")


def send(op: str, **args: object) -> object:
    """Send one command through the private automation directory and return its JSON result."""
    if op == "snapshot":
        raw_path = args.get("path")
        if not isinstance(raw_path, (str, Path)):
            raise DriveError("snapshot requires an absolute PNG path")
        return snapshot(Path(raw_path))
    return _send(op, _state_directory(), args, 30)


def _wait_ready(state_directory: Path, pid: int) -> dict[str, object]:
    deadline = time.monotonic() + 45
    last_error = "automation hook did not answer"
    while time.monotonic() < deadline:
        try:
            ping = _send("ping", state_directory, {}, 3)
            bounds = _send("bounds", state_directory, {}, 5)
            return {"ping": ping, "bounds": bounds, "pid": pid}
        except DriveError as error:
            last_error = str(error)
            if not _is_deck_pid(pid):
                break
            time.sleep(0.2)
    if _is_deck_pid(pid):
        _stop_started_process(pid)
    raise DriveError(f"omp console.app failed its automation ready check: {last_error}")


def launch(daemon_url: str, state_directory: Path | None = None) -> dict[str, object]:
    directory = _state_directory(state_directory)
    os.environ[STATE_ENV] = str(directory)
    _quit_existing_app()
    pid = _start_app(directory, automation=True, daemon_url=daemon_url)
    return _wait_ready(directory, pid)


def crash(state_directory: Path | None = None) -> dict[str, object]:
    directory = _state_directory(state_directory)
    state = _read_state(directory)
    if state.get("mode") != "automation" or state.get("launched_by_drive") is not True:
        raise DriveError("crash is limited to the automation omp console.app process launched by this driver")
    try:
        pid = int(state["pid"])
    except (KeyError, TypeError, ValueError) as error:
        raise DriveError("omp console driver state has no process id") from error
    if not _is_deck_pid(pid):
        raise DriveError(f"refusing to signal PID {pid}: it is not the omp console.app executable launched here")
    os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not _is_deck_pid(pid):
            return {"pid": pid, "signal": 9, "stopped": True}
        time.sleep(0.05)
    raise DriveError(f"omp console.app process {pid} did not stop after SIGKILL")


def relaunch(state_directory: Path | None = None) -> dict[str, object]:
    directory = _state_directory(state_directory)
    os.environ[STATE_ENV] = str(directory)
    state = _read_state(directory)
    if state.get("mode") != "automation" or state.get("launched_by_drive") is not True:
        raise DriveError("relaunch requires saved automation launch state")
    try:
        old_pid = int(state["pid"])
        daemon_url = str(state["daemon_url"])
    except (KeyError, TypeError, ValueError) as error:
        raise DriveError("omp console driver state cannot relaunch the automation app") from error
    if _is_deck_pid(old_pid):
        raise DriveError(f"omp console.app process {old_pid} is still running; refusing to duplicate it")
    pid = _start_app(directory, automation=True, daemon_url=daemon_url)
    return _wait_ready(directory, pid)


def restore_production(state_directory: Path | None = None) -> dict[str, object]:
    directory = _state_directory(state_directory)
    os.environ[STATE_ENV] = str(directory)
    previous: dict[str, object] = {}
    state_file = directory / "drive-state.json"
    if state_file.is_file():
        previous = _read_state(directory)
    _quit_existing_app()
    pid = _start_app(directory, automation=False)
    time.sleep(1)
    if not _is_deck_pid(pid):
        raise DriveError("production omp console.app exited during restore")

    automation_directory = previous.get("automation_dir")
    if automation_directory is not None:
        target = Path(str(automation_directory)).resolve()
        if target == (directory / "automation").resolve() and target.is_dir():
            shutil.rmtree(target)
    return {"pid": pid, "mode": "production", "automation_env": False}


def _capture_snapshot(path: Path, state_directory: Path) -> object:
    if not path.is_absolute() or path.suffix.lower() != ".png":
        raise DriveError("snapshot path must be an absolute .png path")
    native_error: str | None = None
    try:
        result = _send("snapshot", state_directory, {"path": str(path)}, 45)
        if (
            isinstance(result, dict)
            and result.get("blank") is False
            and path.is_file()
            and path.stat().st_size > 0
        ):
            return result
        if isinstance(result, dict) and result.get("blank") is True:
            native_error = "blank snapshot"
        else:
            native_error = "WKWebView snapshot did not return a non-blank PNG"
    except DriveError as error:
        native_error = str(error)

    try:
        capture = _send("snapshot", state_directory, {"path": str(path), "method": "screencapture"}, 30)
    except DriveError as error:
        raise DriveError(f"WKWebView snapshot failed ({native_error}); screencapture fallback failed: {error}") from error
    if not isinstance(capture, dict) or not path.is_file() or path.stat().st_size == 0:
        raise DriveError(f"WKWebView snapshot failed ({native_error}); screencapture fallback did not produce a PNG")
    capture["webkit_error"] = native_error
    return capture


def snapshot(path: Path | None = None, state_directory: Path | None = None) -> object:
    directory = _state_directory(state_directory)
    if path is None:
        path = directory / "snapshots" / f"snapshot-{time.time_ns()}.png"
    path = path.expanduser().resolve()
    if path.suffix.lower() != ".png":
        raise DriveError("snapshot path must be an absolute .png path")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return _capture_snapshot(path, directory)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Drive the real omp console.app through its opt-in file automation hook.")
    parser.add_argument("--state-dir", type=Path, default=None, help=f"private driver state directory (default: {DEFAULT_STATE_DIR})")
    commands = parser.add_subparsers(dest="command", required=True)

    launch_command = commands.add_parser("launch", help="quit omp console.app and launch it against a daemon with automation enabled")
    launch_command.add_argument("--daemon", required=True)

    commands.add_parser("relaunch", help="relaunch the automation omp console.app process after a crash")
    commands.add_parser("restore-production", help="relaunch omp console.app normally without automation environment variables")
    commands.add_parser("crash", help="SIGKILL only the omp console.app PID recorded by this driver")
    snap_command = commands.add_parser("snap", help="capture a PNG of the omp console.app window")
    snap_command.add_argument("path", nargs="?", type=Path)

    resize_command = commands.add_parser("resize", help="resize the main omp console.app window in logical points")
    resize_command.add_argument("width", type=float)
    resize_command.add_argument("height", type=float)

    eval_command = commands.add_parser("eval", help="evaluate one JavaScript expression in the main webview")
    eval_command.add_argument("js")
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    directory = _state_directory(arguments.state_dir)
    os.environ[STATE_ENV] = str(directory)
    try:
        if arguments.command == "launch":
            result = launch(arguments.daemon, directory)
        elif arguments.command == "relaunch":
            result = relaunch(directory)
        elif arguments.command == "restore-production":
            result = restore_production(directory)
        elif arguments.command == "crash":
            result = crash(directory)
        elif arguments.command == "snap":
            result = snapshot(arguments.path, directory)
        elif arguments.command == "resize":
            result = _send("resize", directory, {"width": arguments.width, "height": arguments.height}, 30)
        elif arguments.command == "eval":
            result = _send("eval", directory, {"js": arguments.js}, 25)
        else:
            raise DriveError(f"unknown command {arguments.command}")
    except (DriveError, OSError, subprocess.SubprocessError) as error:
        print(f"drive.py: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
