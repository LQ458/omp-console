# Security

## Threat model

The daemon is a remote-control interface for omp sessions running with the host user's privileges. A successful request can steer agents and invoke the operations they expose, including shell commands. Treat the daemon as sensitive even though it listens only on `127.0.0.1`.

Every API route except `POST /api/pair` and `GET /api/pair/status`, and every relay/live/peer WebSocket and peer proxy route, requires a paired device: an `HttpOnly`, `SameSite=Strict` device cookie set by `POST /api/pair`, or `Authorization: Bearer <device token>`. Device tokens are stored only as SHA-256 hashes in `<state dir>/devices.json` (mode 0600). Static files stay public so the pairing screen can load. On top of pairing, the daemon checks the request host and origin to reject DNS-rebinding and cross-site browser requests.

Pairing codes are one-time, 8 characters, valid for 10 minutes, burned after 5 wrong attempts, and rate-limited. When no device is paired the daemon prints a code at startup and writes it to `<state dir>/pairing-code` (0600); `omp-console-daemon pair` requests a fresh one through private files in the state directory. Settings → Devices shows a code for adding another device and revokes devices; revoking closes that device's open sockets at once.

The Tailscale login header (`Tailscale-User-Login`) never grants access by itself, because any local process can send it to a loopback port. With `--owner` set it only narrows access: a request that carries the header must also match the owner.

What this protects against: web pages in any browser on the machine, other OS users on the host, other tailnet users and devices that have not been paired. What it does **not** protect against: code running as the same OS user, including an omp agent, because it can read the state directory. Keep that boundary in mind before running untrusted code in a session.

On Linux, omp-console does not use the macOS Keychain. Provider credentials come from omp's own authentication storage or the provider's environment variable; the daemon does not copy an API key into its state directory.

Any paired device can read and replace the daemon's optional-feature configuration and request a supervised daemon restart. A normal restart is refused while sessions are streaming or waiting for an answer; an explicit force restart stops those active turns. Treat paired devices as trusted administrators, not read-only viewers. Enabling computer use lets agents control the host Mac through its GUI and requires Accessibility and Screen Recording permission for the daemon process. Enabling peers lets this daemon use a stored peer device token to reach another daemon, extending paired-device session access to that peer host.

## Overnight automation

Overnight runs automatically answer timed-out ask dialogs with the recommended option. Their workers disable Git terminal prompts (`GIT_TERMINAL_PROMPT=0`), default SSH to batch mode (`GIT_SSH_COMMAND=ssh -o BatchMode=yes` when unset), and disable GitHub CLI prompts (`GH_PROMPT_DISABLED=1`). This removes interactive confirmation from those command paths; it does not grant credentials or permissions, answer operating-system dialogs, or make a run guaranteed to finish. Review the saved prompt and policy before leaving work unattended.

Only Tailscale Serve is supported for remote access. Never expose the daemon with Tailscale Funnel. A reverse proxy must implement its own authentication in addition to the daemon's checks; arbitrary reverse-proxy deployments are unsupported. Do not expose the daemon directly to the public internet.

## Revoke access

- Open Settings → Devices on any paired device and revoke the device. Revoking the device you are using signs it out.
- To revoke everything, stop the daemon and delete `<state dir>/devices.json` (default `~/.omp-console/devices.json`); the next start prints a new pairing code.
- Also remove the Tailscale Serve configuration if you no longer need remote access.

## Report a vulnerability

Use a GitHub private security advisory: `<repo>/security/advisories/new`. Do not report exploitable details in a public issue. Include affected versions, reproduction steps, and impact; do not include real credentials or session data.
