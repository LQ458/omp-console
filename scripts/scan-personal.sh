#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DENYLIST=${OMP_CONSOLE_PERSONAL_DENYLIST:-"$SCRIPT_DIR/personal-denylist.txt"}
if [ ! -f "$DENYLIST" ]; then
	printf 'Denylist file not found: %s\n' "$DENYLIST" >&2
	exit 2
fi
FAIL=0
SEEN='|'
USER_HOME_COMPONENT=Users
USER_HOME_PREFIX="/${USER_HOME_COMPONENT}/"


report() {
	KEY="$1:$2"
	case "$SEEN" in *"|$KEY|"*) return ;; esac
	SEEN="${SEEN}${KEY}|"
	printf '%s:%s: matched a personal-data rule\n' "$1" "$2" >&2
	FAIL=1
}


while IFS= read -r -d '' FILE; do
	[ -f "$REPO_ROOT/$FILE" ] && [ ! -L "$REPO_ROOT/$FILE" ] || continue
	while IFS= read -r PATTERN || [ -n "$PATTERN" ]; do
		case "$PATTERN" in ''|'#'*) continue ;; esac
		if MATCHES=$(LC_ALL=C grep -I -nE -- "$PATTERN" "$REPO_ROOT/$FILE" 2>/dev/null); then
			while IFS= read -r MATCH; do
				LINE=${MATCH%%:*}
				report "$FILE" "$LINE"
			done <<< "$MATCHES"
		else
			STATUS=$?
			if [ "$STATUS" -gt 1 ]; then
				printf '%s: invalid denylist expression\n' "$DENYLIST" >&2
				exit 2
			fi
		fi
	done < "$DENYLIST"
		if MATCHES=$(LC_ALL=C grep -I -nEo "${USER_HOME_PREFIX}[^/[:space:]\"<>]+" "$REPO_ROOT/$FILE" 2>/dev/null); then
			while IFS= read -r MATCH; do
				LINE=${MATCH%%:*}
				PATH_VALUE=${MATCH#*:}
				case "$PATH_VALUE" in
					"${USER_HOME_PREFIX}alice"|"${USER_HOME_PREFIX}alice/"*|"${USER_HOME_PREFIX}dev"|"${USER_HOME_PREFIX}dev/"*|"${USER_HOME_PREFIX}you"|"${USER_HOME_PREFIX}you/"*) continue ;;
				esac
				report "$FILE" "$LINE"
			done <<< "$MATCHES"
		fi
		if MATCHES=$(LC_ALL=C grep -I -nEo '([[:alnum:]-]+\.)+[[:alnum:]-]+\.ts\.net' "$REPO_ROOT/$FILE" 2>/dev/null); then
			while IFS= read -r MATCH; do
				LINE=${MATCH%%:*}
				HOST=${MATCH#*:}
				case "$HOST" in
					example.ts.net|*.example.ts.net|*.tailnet.ts.net|*.tailnet-example.ts.net|*.tail1234.ts.net|box.ts.net|a.ts.net|b.ts.net|c.ts.net|other.ts.net) continue ;;
				esac
				report "$FILE" "$LINE"
			done <<< "$MATCHES"
		fi
	done < <(git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -z)

if [ "$FAIL" -ne 0 ]; then
	printf 'Personal-data scan failed. Remove the matched data or add only intentional examples to the local denylist policy.\n' >&2
	exit 1
fi
printf 'Personal-data scan passed.\n'
