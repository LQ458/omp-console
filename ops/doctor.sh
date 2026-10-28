#!/bin/sh
set -u

URL=${1:-${OMP_CONSOLE_URL:-http://127.0.0.1:7490}}
FAIL=0
printf 'Daemon (%s): ' "$URL"
if curl --silent --show-error --fail --connect-timeout 2 --max-time 5 "$URL/api/pair/status" >/dev/null 2>&1; then
	printf 'reachable\n'
else
	printf 'unreachable; run ~/.local/bin/omp-console status, then ~/.local/bin/omp-console logs\n'
	FAIL=1
fi
printf 'Pairing: run ~/.local/bin/omp-console open for a fresh one-click link.\n'

ENV_FILE="$HOME/.omp-console/env"
if [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
	if [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
		printf 'Environment file: unsafe (must be a regular file, not a symlink)\n'
		FAIL=1
	else
		if [ "$(uname -s)" = Darwin ]; then
			ENV_OWNER=$(stat -f '%u' "$ENV_FILE")
			ENV_MODE=$(stat -f '%Lp' "$ENV_FILE")
		else
			ENV_OWNER=$(stat -c '%u' "$ENV_FILE")
			ENV_MODE=$(stat -c '%a' "$ENV_FILE")
		fi
		if [ "$ENV_OWNER" = "$(id -u)" ] && [ "$ENV_MODE" = 600 ]; then
			printf 'Environment file: private and owned by this user\n'
		else
			printf 'Environment file: must be owned by this user and mode 0600\n'
			FAIL=1
		fi
	fi
else
	printf 'Environment file: not created yet (optional)\n'
fi

case "$(uname -s)" in
	Darwin)
		LABEL=dev.ompconsole.daemon
		if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
			printf 'LaunchAgent: loaded (%s)\n' "$LABEL"
		else
			printf 'LaunchAgent: not loaded (%s)\n' "$LABEL"
		fi
		;;
	Linux)
		if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet omp-console.service; then
			printf 'systemd user service: active (omp-console.service)\n'
		else
			printf 'systemd user service: not active (omp-console.service)\n'
		fi
		;;
	*)
		printf 'Managed services: unsupported on this platform\n'
		;;
esac

if command -v tailscale >/dev/null 2>&1; then
	printf 'Tailscale Serve status:\n'
	tailscale serve status || printf 'No active Tailscale Serve configuration was reported.\n'
else
	printf 'Tailscale: not installed; Serve status not checked\n'
fi
exit "$FAIL"
