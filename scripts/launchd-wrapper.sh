#!/bin/bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
	printf '%s\n' 'launchd wrapper needs a Bun path and daemon arguments' >&2
	exit 2
fi
BUN_PATH=$1
shift
ENV_FILE="${HOME:?}/.omp-console/env"
if [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
	if [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
		printf '%s\n' 'omp-console env must be a regular, non-symlink file' >&2
		exit 1
	fi
	if [ "$(uname -s)" = Darwin ]; then
		OWNER=$(stat -f '%u' "$ENV_FILE")
		MODE=$(stat -f '%Lp' "$ENV_FILE")
	else
		OWNER=$(stat -c '%u' "$ENV_FILE")
		MODE=$(stat -c '%a' "$ENV_FILE")
	fi
	if [ "$OWNER" != "$(id -u)" ]; then
		printf '%s\n' 'omp-console env must be owned by the LaunchAgent user' >&2
		exit 1
	fi
	if [ "$MODE" != 600 ]; then
		printf '%s\n' 'omp-console env must have mode 0600' >&2
		exit 1
	fi
	LINE_NUMBER=0
	while IFS= read -r line || [ -n "$line" ]; do
		LINE_NUMBER=$((LINE_NUMBER + 1))
		if [ -z "$line" ] || [[ "$line" == \#* ]]; then continue; fi
		if [[ "$line" == *$'\r'* || "$line" != *=* ]]; then
			printf 'invalid omp-console env line %s\n' "$LINE_NUMBER" >&2
			exit 1
		fi
		key=${line%%=*}
		if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
			printf 'invalid omp-console env key on line %s\n' "$LINE_NUMBER" >&2
			exit 1
		fi
		value=${line#*=}
		export "$key=$value"
	done < "$ENV_FILE"
fi
exec "$BUN_PATH" "$@"
