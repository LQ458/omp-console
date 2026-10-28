#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OS=$(uname -s)
LAUNCH_AGENT_LABEL=dev.ompconsole.daemon
LAUNCH_AGENT_FILE="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"
LAUNCHD_TEMPLATE="$REPO_ROOT/ops/launchd/$LAUNCH_AGENT_LABEL.plist.template"
SYSTEMD_UNIT_LABEL=omp-console.service
SYSTEMD_UNIT_FILE="$HOME/.config/systemd/user/$SYSTEMD_UNIT_LABEL"
SYSTEMD_TEMPLATE="$REPO_ROOT/ops/systemd/omp-console.service.template"
LAUNCH_AGENT=0
SYSTEMD=0
INSTALL_APP=0
DRY_RUN=0
UNINSTALL=0
PLAIN=0
STATE_DIR="$HOME/.omp-console"
ENV_FILE="$STATE_DIR/env"
CLI_SHIM="$HOME/.local/bin/omp-console"
OWNER=
ALLOW_HOSTS=()

usage() {
	printf 'Usage: %s [--plain|--launchd|--systemd] [--owner <tailnet-login> --allow-host <hostname> ...] [--app] [--dry-run]\n' "$0"
	printf '       %s --uninstall [--dry-run]\n' "$0"
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--launchd) LAUNCH_AGENT=1; shift ;;
		--systemd) SYSTEMD=1; shift ;;
		--plain) PLAIN=1; shift ;;
		--app) INSTALL_APP=1; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		--owner)
			if [ "$#" -lt 2 ]; then usage >&2; exit 2; fi
			OWNER=$2
			shift 2
			;;
		--allow-host)
			if [ "$#" -lt 2 ]; then usage >&2; exit 2; fi
			ALLOW_HOSTS+=("$2")
			shift 2
			;;
		-h|--help) usage; exit 0 ;;
		*) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

if [ "$LAUNCH_AGENT" -eq 1 ] && [ "$SYSTEMD" -eq 1 ]; then
	printf '%s\n' '--launchd and --systemd cannot be combined.' >&2
	exit 2
fi

if [ "$PLAIN" -eq 1 ] && { [ "$LAUNCH_AGENT" -eq 1 ] || [ "$SYSTEMD" -eq 1 ] || [ "$INSTALL_APP" -eq 1 ]; }; then
	printf '%s\n' '--plain cannot be combined with --launchd, --systemd, or --app.' >&2
	exit 2
fi

if [ "$UNINSTALL" -eq 1 ]; then
	if [ "$LAUNCH_AGENT" -eq 1 ] || [ "$SYSTEMD" -eq 1 ] || [ "$INSTALL_APP" -eq 1 ] || [ "$PLAIN" -eq 1 ] || [ -n "$OWNER" ] || [ "${#ALLOW_HOSTS[@]}" -gt 0 ]; then
		printf '%s\n' '--uninstall cannot be combined with install options.' >&2
		exit 2
	fi
	case "$OS" in
		Darwin)
			if [ "$DRY_RUN" -eq 1 ]; then
				printf 'Would unload %s if loaded, then remove only %s\n' "$LAUNCH_AGENT_LABEL" "$LAUNCH_AGENT_FILE"
				exit 0
			fi
			if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
				launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL"
			fi
			rm -f "$LAUNCH_AGENT_FILE"
			printf 'Removed omp-console LaunchAgent: %s\n' "$LAUNCH_AGENT_FILE"
			;;
		Linux)
			if [ "$DRY_RUN" -eq 1 ]; then
				printf 'Would disable and stop %s if present, then remove only %s\n' "$SYSTEMD_UNIT_LABEL" "$SYSTEMD_UNIT_FILE"
				exit 0
			fi
			if command -v systemctl >/dev/null 2>&1; then
				systemctl --user disable --now "$SYSTEMD_UNIT_LABEL" >/dev/null 2>&1 || true
			fi
			rm -f "$SYSTEMD_UNIT_FILE"
			if command -v systemctl >/dev/null 2>&1; then
				systemctl --user daemon-reload
			fi
			printf 'Removed omp-console systemd user service: %s\n' "$SYSTEMD_UNIT_FILE"
			;;
		*)
			printf 'Unsupported host OS for uninstall: %s\n' "$OS" >&2
			exit 1
			;;
	esac
	exit 0
fi

case "$OS" in
	Darwin)
		if [ "$SYSTEMD" -eq 1 ]; then
			printf '%s\n' '--systemd is Linux-only; use --launchd on macOS.' >&2
			exit 1
		fi
		;;
	Linux)
		if [ "$LAUNCH_AGENT" -eq 1 ]; then
			printf '%s\n' '--launchd is macOS-only; use --systemd on Linux.' >&2
			exit 1
		fi
		if [ "$INSTALL_APP" -eq 1 ]; then
			printf '%s\n' '--app is macOS-only; Linux uses the browser/PWA at http://127.0.0.1:7490.' >&2
			exit 1
		fi
		;;
	*)
		printf 'Unsupported host OS: %s\n' "$OS" >&2
		exit 1
		;;
esac

if [ -n "$OWNER" ] && [ "${#ALLOW_HOSTS[@]}" -eq 0 ]; then
	printf -- '--owner only applies to Tailscale Serve requests; also pass the --allow-host name.\n' >&2
	exit 2
fi
if [ "$LAUNCH_AGENT" -eq 0 ] && [ "$SYSTEMD" -eq 0 ] && { [ -n "$OWNER" ] || [ "${#ALLOW_HOSTS[@]}" -gt 0 ]; }; then
	printf 'Remote identity options require --launchd on macOS or --systemd on Linux.\n' >&2
	exit 2
fi

if [ -n "${BUN:-}" ]; then BUN_COMMAND=$BUN; else BUN_COMMAND=$(command -v bun || true); fi
if [ -z "$BUN_COMMAND" ]; then
	printf 'Bun >= 1.4 is required. Install it using the official Bun instructions; this script never installs Bun globally.\n' >&2
	exit 1
fi
if [[ "$BUN_COMMAND" == */* ]]; then BUN_PATH=$BUN_COMMAND; else BUN_PATH=$(command -v "$BUN_COMMAND" || true); fi
if [ -z "$BUN_PATH" ] || [ ! -x "$BUN_PATH" ]; then
	printf 'Bun >= 1.4 is required, but %s is not executable.\n' "$BUN_COMMAND" >&2
	exit 1
fi
ACTUAL_BUN=$("$BUN_PATH" --version)
if [[ ! "$ACTUAL_BUN" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
	printf 'Could not parse Bun version: %s\n' "$ACTUAL_BUN" >&2
	exit 1
fi
IFS=. read -r BUN_MAJOR BUN_MINOR _ <<< "$ACTUAL_BUN"
# Older Bun releases cannot read this lockfile format (measured: 1.1.38, 1.2.x and 1.3.0 all fail the frozen install),
# and Bun 1.2.19 also emitted a web build whose entry was the wrong chunk (blank page). Every later step uses this Bun.
if [ "$((10#$BUN_MAJOR))" -lt 1 ] || { [ "$((10#$BUN_MAJOR))" -eq 1 ] && [ "$((10#$BUN_MINOR))" -lt 4 ]; }; then
	printf 'Bun >= 1.4 is required, found %s. Upgrade with `bun upgrade`.\n' "$ACTUAL_BUN" >&2
	exit 1
fi
printf 'Bun: %s at %s (minimum 1.4).\n' "$ACTUAL_BUN" "$BUN_PATH"
# Package scripts call `bun` by name; make that the Bun checked above, not another one earlier on PATH.
PATH="$(dirname -- "$BUN_PATH"):$PATH"
export PATH

OMP_PATH=$(command -v omp || true)
if [ -z "$OMP_PATH" ]; then
	printf 'omp is required. Install it before using omp-console.\n' >&2
	exit 1
fi
if ! "$OMP_PATH" --version >/dev/null 2>&1; then
	printf 'The omp executable did not pass `omp --version`.\n' >&2
	exit 1
fi
printf 'Reminder: sign in to omp before starting sessions; this installer does not inspect omp credentials.\n'

if [ "$DRY_RUN" -eq 1 ]; then
	printf 'Would run: (cd %s && %s install --frozen-lockfile)\n' "$REPO_ROOT" "$BUN_PATH"
	printf 'Would run: (cd %s/packages/web && %s run build)\n' "$REPO_ROOT" "$BUN_PATH"
	if [ "$LAUNCH_AGENT" -eq 1 ]; then
		printf 'Would render %s into %s using state %s/.omp-console, port 7490, and logs %s/Library/Logs/omp-console; then bootstrap %s\n' \
			"$LAUNCHD_TEMPLATE" "$LAUNCH_AGENT_FILE" "$HOME" "$HOME" "$LAUNCH_AGENT_LABEL"
		if [ -n "$OWNER" ]; then printf 'Remote identity: owner %s; allowed host(s): %s\n' "$OWNER" "${ALLOW_HOSTS[*]}"; fi
	fi
	if [ "$SYSTEMD" -eq 1 ]; then
		printf 'Would render %s into %s with ExecStart=%s/packages/daemon/src/main.ts --web-dir %s/packages/web/dist and OMP_CONSOLE_SUPERVISED=1.\n' \
			"$SYSTEMD_TEMPLATE" "$SYSTEMD_UNIT_FILE" "$BUN_PATH" "$REPO_ROOT"
		printf 'Would run: systemctl --user daemon-reload && systemctl --user enable %s && systemctl --user restart %s\n' "$SYSTEMD_UNIT_LABEL" "$SYSTEMD_UNIT_LABEL"
		if [ -n "$OWNER" ]; then printf 'Remote identity: owner %s; allowed host(s): %s\n' "$OWNER" "${ALLOW_HOSTS[*]}"; fi
	fi
	if [ "$INSTALL_APP" -eq 1 ]; then
		printf 'Would build and install only /Applications/omp console.app\n'
	fi
	printf 'Would create %s with mode 0600, capture only PI_CODING_AGENT_DIR and PI_CONFIG_DIR (when non-root), and install %s.\n' "$ENV_FILE" "$CLI_SHIM"
	if [ "$LAUNCH_AGENT" -eq 1 ] || [ "$SYSTEMD" -eq 1 ]; then
		if [ "$INSTALL_APP" -eq 1 ]; then
			printf 'After installation, start the app and run: %s open\n' "$CLI_SHIM"
		else
			printf 'After the service starts, run: %s open (interactive stdout only; opens a pairing page when available).\n' "$CLI_SHIM"
		fi
	elif [ "$INSTALL_APP" -eq 1 ]; then
		printf 'After starting the app, run: %s open\n' "$CLI_SHIM"
	else
		printf 'Run this to start the daemon:\n  %q %q --port 7490 --state-dir %q --web-dir %q\n' \
			"$BUN_PATH" "$REPO_ROOT/packages/daemon/src/main.ts" "$STATE_DIR" "$REPO_ROOT/packages/web/dist"
		printf 'Then run: %s open\n' "$CLI_SHIM"
	fi
	exit 0
fi

if ! (cd "$REPO_ROOT" && "$BUN_PATH" install --frozen-lockfile); then
	printf 'bun install failed. If it reports a lockfile problem, upgrade Bun (`bun upgrade`) and run this script again.\n' >&2
	exit 1
fi
(cd "$REPO_ROOT/packages/web" && "$BUN_PATH" run build)

mkdir -p "$STATE_DIR" "$(dirname -- "$CLI_SHIM")"
if [ -L "$ENV_FILE" ] || { [ -e "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; }; then
	printf 'Refusing to use a non-regular omp-console env file: %s\n' "$ENV_FILE" >&2
	exit 1
fi
if [ ! -e "$ENV_FILE" ]; then
	(umask 077; printf '# Optional daemon environment. Use literal KEY=value lines.\n# Keep this file mode 0600; never put secrets in shell commands.\n' > "$ENV_FILE")
fi
if [ "$OS" = Darwin ]; then ENV_OWNER=$(stat -f '%u' "$ENV_FILE"); else ENV_OWNER=$(stat -c '%u' "$ENV_FILE"); fi
if [ "$ENV_OWNER" != "$(id -u)" ]; then
	printf 'The omp-console env file must be owned by the installing user: %s\n' "$ENV_FILE" >&2
	exit 1
fi
chmod 600 "$ENV_FILE"
has_env_key() {
	local expected=$1 line
	while IFS= read -r line || [ -n "$line" ]; do
		[ "${line%%=*}" = "$expected" ] && return 0
	done < "$ENV_FILE"
	return 1
}
if [ "$(id -u)" -ne 0 ]; then
	for key in PI_CODING_AGENT_DIR PI_CONFIG_DIR; do
		value=
		present=
		case "$key" in
			PI_CODING_AGENT_DIR)
				if [ "${PI_CODING_AGENT_DIR+x}" = x ]; then value=$PI_CODING_AGENT_DIR; present=1; fi
				;;
			PI_CONFIG_DIR)
				if [ "${PI_CONFIG_DIR+x}" = x ]; then value=$PI_CONFIG_DIR; present=1; fi
				;;
		esac
		[ -n "$present" ] && [ -n "$value" ] || continue
		case "$value" in *$'\n'*|*$'\r'*) printf 'Cannot capture %s with a line break.\n' "$key" >&2; exit 1 ;; esac
		if ! has_env_key "$key"; then printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"; fi
	done
fi
SHIM_TMP=$(mktemp "$HOME/.local/bin/.omp-console.XXXXXX")
printf '#!/bin/bash\nexec %q %q "$@"\n' "$BUN_PATH" "$REPO_ROOT/packages/daemon/src/main.ts" > "$SHIM_TMP"
chmod 755 "$SHIM_TMP"
mv "$SHIM_TMP" "$CLI_SHIM"

if [ "$LAUNCH_AGENT" -eq 1 ]; then
	mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/omp-console"
	PLIST_TMP=$(mktemp "$HOME/Library/LaunchAgents/.dev.ompconsole.daemon.XXXXXX")
	cleanup() { rm -f "$PLIST_TMP"; }
	trap cleanup EXIT INT TERM
	RENDER_ARGS=("$LAUNCHD_TEMPLATE" "$PLIST_TMP" "$BUN_PATH" "$REPO_ROOT" "$HOME" "${PATH:-}" "$OWNER")
	if [ "${#ALLOW_HOSTS[@]}" -gt 0 ]; then RENDER_ARGS+=("${ALLOW_HOSTS[@]}"); fi
	"$BUN_PATH" "$REPO_ROOT/scripts/render-launchd.ts" "${RENDER_ARGS[@]}"
	chmod 644 "$PLIST_TMP"
	if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
		launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL"
	fi
	mv "$PLIST_TMP" "$LAUNCH_AGENT_FILE"
	trap - EXIT INT TERM
	launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_FILE"
	printf 'Installed and started %s\n' "$LAUNCH_AGENT_FILE"
fi

if [ "$SYSTEMD" -eq 1 ]; then
	if ! command -v systemctl >/dev/null 2>&1; then
		printf 'systemctl is required for --systemd.\n' >&2
		exit 1
	fi
	mkdir -p "$(dirname -- "$SYSTEMD_UNIT_FILE")"
	UNIT_TMP=$(mktemp "$(dirname -- "$SYSTEMD_UNIT_FILE")/.omp-console.service.XXXXXX")
	cleanup() { rm -f "$UNIT_TMP"; }
	trap cleanup EXIT INT TERM
	RENDER_ARGS=("$SYSTEMD_TEMPLATE" "$UNIT_TMP" "$BUN_PATH" "$REPO_ROOT" "$HOME" "${PATH:-}" "$OWNER")
	if [ "${#ALLOW_HOSTS[@]}" -gt 0 ]; then RENDER_ARGS+=("${ALLOW_HOSTS[@]}"); fi
	"$BUN_PATH" "$REPO_ROOT/scripts/render-systemd.ts" "${RENDER_ARGS[@]}"
	chmod 644 "$UNIT_TMP"
	mv "$UNIT_TMP" "$SYSTEMD_UNIT_FILE"
	trap - EXIT INT TERM
	systemctl --user daemon-reload
	systemctl --user enable "$SYSTEMD_UNIT_LABEL"
	# restart, not start: rerunning the installer after an update must replace a running daemon.
	systemctl --user restart "$SYSTEMD_UNIT_LABEL"
	printf 'Installed and (re)started %s\n' "$SYSTEMD_UNIT_FILE"
fi

if [ "$INSTALL_APP" -eq 1 ]; then
	BUN="$BUN_PATH" OMP_CONSOLE_INSTALL=1 "$REPO_ROOT/apps/mac/scripts/build-app.sh"
fi

if [ "$INSTALL_APP" -eq 1 ]; then
	printf 'Open the omp console app, then run: %s open\n' "$CLI_SHIM"
elif [ "$LAUNCH_AGENT" -eq 1 ] || [ "$SYSTEMD" -eq 1 ]; then
	if [ -t 1 ]; then
		"$CLI_SHIM" open
	else
		printf 'Next, run %s open in a terminal to get a fresh pairing link.\n' "$CLI_SHIM"
	fi
else
	printf 'Run this to start the daemon:\n  %q %q --port 7490 --state-dir %q --web-dir %q\n' \
		"$BUN_PATH" "$REPO_ROOT/packages/daemon/src/main.ts" "$STATE_DIR" "$REPO_ROOT/packages/web/dist"
	printf 'Then run: %s open\n' "$CLI_SHIM"
fi
