#!/bin/sh
set -eu

DRY_RUN=0
if [ "$#" -gt 1 ]; then
	printf 'Usage: %s [--dry-run]\n' "$0" >&2
	exit 2
fi
if [ "$#" -eq 1 ]; then
	if [ "$1" != --dry-run ]; then
		printf 'Unknown option: %s\n' "$1" >&2
		exit 2
	fi
	DRY_RUN=1
fi

if [ "$DRY_RUN" -eq 1 ]; then
	printf 'Would run: tailscale serve --bg --https=7443 http://127.0.0.1:7490\n'
	printf 'Afterward, open the HTTPS URL shown by `tailscale serve status`. Never use Funnel.\n'
	exit 0
fi

if ! command -v tailscale >/dev/null 2>&1; then
	printf 'Tailscale CLI not found. Install and sign in to Tailscale before enabling Serve.\n' >&2
	exit 1
fi
tailscale serve --bg --https=7443 http://127.0.0.1:7490
printf '\nTailscale Serve status (use the printed HTTPS URL on your phone):\n'
tailscale serve status
printf '\nOnly use this tailnet-only Serve endpoint. Do not use Tailscale Funnel.\n'
