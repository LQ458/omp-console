# @omp-console/daemon

Local relay, worker supervisor, control API, static web serving and Web Push sender; one loopback port.

```sh
BUN=bun
${BUN} packages/daemon/src/main.ts --port 7490 --owner alice@example.com --allow-host host.tailnet-example.ts.net --web-dir packages/web/dist --worker-cmd '["bun","packages/session-host/src/main.ts"]'
# stdout: {"t":"listening","port":7490}
```

| Flag | Default |
|---|---|
| `--port` | `7490` (`0` = any free port) |
| `--state-dir` | `~/.omp-console` (devices, pairing control, push subscriptions and VAPID key; sensitive files mode 0600) |
| `--peer <id>=<https-url>` | no peers |
| `--peer-token-file <id>=<0600-file>` | required for every configured peer; remote daemon device token |
| `--owner` | optional expected Tailscale login; a matching header narrows access but never replaces a device token |
| `--allow-host` | repeatable; host names accepted in `Host` / `X-Forwarded-Host` besides `localhost`, `127.0.0.1`, `[::1]`. Add the machine's `*.ts.net` name here (the exact name, no wildcards; a port is ignored) |
| `--push-subject` | `mailto:omp-console@example.invalid`; the VAPID `sub` contact (`mailto:` or `https:`) |
| `--web-dir` | `packages/web/dist` |
| `--worker-cmd` | Bun + `packages/session-host/src/main.ts` (`"exe arg"` or a JSON array) |
| `--stalled-after-ms` | `120000` |
| `--stop-grace-ms` | `5000` (then SIGTERM, 3 s later SIGKILL) |
| `--max-workers` | one per 1.5 GB of memory, 8 to 32 (live plus starting workers on this machine) |
| `--sleep-after` | `120` minutes unless the state directory has a saved sleep setting (`0` disables automatic sleep) |
| `--machine <id>[=<name>]` | `local` / `Local`; this machine's id and name in a multi-machine view (peers may not reuse the id) |
| `--notify-turns-over` | `5` minutes; a finished turn that ran at least this long sends a push notification (`0` = every turn) |

## Feature configuration

An optional JSON object at `<state-dir>/config.json` configures optional integrations and workspace paths. JSON paths are resolved relative to the state directory; paths supplied by CLI flags are resolved from the working directory. Invalid JSON, unknown fields, or invalid field values stop startup with exit code 2. CLI values override the corresponding JSON value; repeatable flags replace that field's JSON list.

| JSON field | Default and behavior |
|---|---|
| `features.librarian` | `false`; Project search routes register only when enabled and both `knowledgeRoot` and at least one `projectRoots` entry are configured. |
| `features.agenda` | `false`; Task board integration needs `agendaHub`, the folder containing the task board app’s files. |
| `features.quickAsk` | `false`; Ask your notes requires `knowledgeRoot` and at least one configured `quickAsk.sources` entry. |
| `quickAsk.sources` | `[]`; allowed values are `siyuan`, `repo`, `web`, and `history`. Requests cannot select a source outside this list; a request without `sources` uses this list. |
| `features.peers` | `false`; Other computers routes mount only when enabled. |
| `peers` | `[]`; configured computer objects have `id`, optional `name`, an HTTPS or loopback `url`, and a `tokenFile` containing a 0600 device token. Configure with JSON or repeatable `--peer <id>=<url>` plus `--peer-token-file <id>=<0600 file>`; entries alone do not enable the feature. |
| `features.openrouterDecisions` | `false`; OpenRouter model choices read the OpenRouter key only when enabled and Project search is active. |
| `features.computerUse` | `false`; set this or `OMP_CONSOLE_COMPUTER_USE=1` to request Computer use tools. The effective capability is false on non-macOS hosts, which log that Computer use is macOS-only. |
| `features.overnight` | `false`; Overnight run routes and overnight session creation are available only when enabled. Keep the daemon running until a run ends. |
| `knowledgeRoot` | Unset; no home-directory default. Needed by Project search and Ask your notes. |
| `projectRoots` | `[]`; no home-directory defaults. At least one is needed by Project search. |
| `scheduleFile` | Unset; an optional local scheduler TOML path. |
| `agendaHub` | Unset; required when Task board is enabled. |

Example:

```json
{
  "features": { "librarian": true, "quickAsk": true, "peers": true },
  "quickAsk": { "sources": ["repo"] },
  "knowledgeRoot": "../Knowledge",
  "projectRoots": ["../Projects"],
  "peers": [{ "id": "workstation", "name": "Workstation", "url": "https://host.tailnet-example.ts.net", "tokenFile": "../peer-token" }]
}
```

The CLI equivalents are `--librarian on|off`, `--agenda on|off`, `--quick-ask on|off`, repeatable `--quick-ask-source`, `--peers on|off`, `--openrouter-decisions on|off`, `--computer-use on|off`, and `--overnight on|off`. Path flags are `--knowledge-root`, repeatable `--projects-root`, `--schedule-config`, `--agenda-hub`, and repeatable `--peer-token-file <id>=<0600 file>`. `GET /api/capabilities` reports the effective feature set; disabled feature routes are not registered.

### Other computer token files

To let this daemon connect to another computer, obtain a one-time code from its daemon with `omp-console-daemon pair --state-dir <state-dir>`. Submit that code to the other computer's `POST /api/pair` endpoint and save the `omc_device` cookie value (the `Set-Cookie` header) by itself in a regular file with mode `0600`. Configure that file as the other computer's `tokenFile`; never put the token in `config.json`, a URL, or a screenshot. The web app links to the [other computer token setup instructions](/peer-token-setup.html).


Worker room secrets travel only on the first stdin line. Guest connections use `/r/<roomId>`; host-ticket path routing is blocked on upstream host-only relay URL support.

## Control API

- `GET /api/models` returns every known registry model with an `available` boolean and effective `modelRoles`; no credential data is returned. Discovery is cached for 30 seconds.
- `GET /api/capabilities` returns the effective feature flags and configured quick-ask source allowlist.
- `GET /api/config` returns the parsed `config.json` as `file` (including peer token-file paths, never token contents), current `/api/capabilities` data as `effective`, per-feature `configured` / `effective` / `missing` / `overriddenByFlag` status, and whether supervised restart is supported.
- `PUT /api/config` replaces `config.json` after `parseDaemonConfigFile` validation; the body is limited to 64 KiB and the file is atomically replaced with mode `0600`. Invalid input returns 400 without changing the file. Success returns `{"restartRequired":true}`; feature routes do not hot-toggle and remain unchanged until restart.
- `POST /api/daemon/restart` is available only to a daemon supervised by the generated launchd or systemd service (`OMP_CONSOLE_SUPERVISED=1`). It returns 409 with active/asking session details unless the body is `{"force":true}`; force stops those turns. A supported restart returns 202, shuts down through the normal stop path, and exits for the service manager (`KeepAlive` / `Restart=always`) to start it again. An unsupervised daemon returns 409 with `restart the daemon manually`. `PUT /api/config` runs the same peer checks as startup, so a saved config cannot leave the service unable to start.
- `GET /api/profiles` returns bundled and user task-agent profiles. `GET /api/profiles?cwd=<absolute-path>` also includes project profiles discovered from the nearest project config directories; project profile writes accept the same optional `cwd`.
- `PUT /api/profiles/:name/model` sets or clears (`{"selector":null}`) a task-agent model override. `PUT /api/model-roles/:role` updates a model role. Both return 204; unknown profiles/roles return 404 and unresolvable selectors return 400.
- Model and profile writes go through omp's Settings save; it does not preserve comments in `config.yml`.
- `GET /api/sessions/:id/catalog` returns the worker's capability catalog (commands with `remote`/`deckControl`, tools, profiles, skills, roles, MCP servers); 404 unknown session, 500 when the worker does not answer within 10 s.
- `GET /api/sessions/:id/files?q=<query>&limit=<n>` suggests `@file` mentions with omp's native fuzzy finder over the session cwd (`.gitignore` honoured, dotfiles included, 1.5 s timeout, 504 on timeout). An empty query lists the top level; directories end with `/` and have `kind:"dir"`. `limit` defaults to 50 and must be 1 to 200 (400 otherwise); `q` is at most 512 characters. Results are relative to the cwd; anything that is absolute or contains `..` is dropped.
- `POST /api/sessions/:id/command` (`{"text":"/compact soft"}`) runs one remote-invokable slash command: 202 `{"accepted":true}`; 400 not a slash command, unknown or TUI-only; 409 the session is busy and the command needs an idle session; 500 on timeout (30 s).
- `POST /api/sessions/:id/ops` forwards typed worker controls, including diagnostics, the browser-offer live start and DAP operations; invalid fields and oversized offers are rejected before reaching the worker.
- `GET /live/:sessionId` requires a paired device token and upgrades to the session's live state/audio socket. Text PCM frames are size/rate limited and excess frames dropped; binary payloads close with 1003. The current browser WebRTC media path negotiates directly through the worker and uses this socket for device-scoped live state.
- `POST /api/sessions/:id/agents/:agentId/thinking` (`{"level":"high"}`, one of off, minimal, low, medium, high, xhigh, max, auto) answers like the model endpoint with the level now in effect: 200, 400 bad level, 404 unknown agent or session, 409 no live session for the agent or an advisor.
- `POST /api/sessions/:id/agents` (`{"profile","task","name?","isolated?","files?"}`) spawns a subagent of a profile through omp's task tool: 202 `{"agentId"}` as soon as it is registered; 400 unknown profile or invalid body; 409 refused by omp's spawn policy; 500 on timeout (30 s). The result is posted into the session as a visible message and does not start a main-agent turn.
- `POST /api/journal` (`{"events":[...]}`, at most 200 per call), `POST /api/feedback`, `GET /api/journal?limit=` (default 500, at most 5000; the newest rows, oldest first) and `DELETE /api/journal` keep the usage journal and feedback as append-only JSONL under the state dir (`journal.jsonl`, `feedback.jsonl`, mode 0600, rotated at 10 MB to `<name>.1`; one previous generation is kept). Only the fields of `JournalEvent` / `FeedbackEntry` are stored: an unknown `outcome` or `via`, `feature` / `action` / `screen` over 64 characters, `detail` over 120, `sessionId` over 128, feedback `text` over 2000 characters, or a batch with any invalid event is rejected whole (400), and unknown keys are dropped.
- `POST /api/sessions/:id/abort` aborts the active turn without a guest room connection (202 with `{"aborted":true}`); an idle session returns 409 and an unknown session returns 404.
- `GET /api/settings/sleep` and `PUT /api/settings/sleep` read or change the idle sleep delay (`{"minutes":120}`; `0` disables it). The value is persisted in `sleep-settings.json` under the daemon state directory and overrides `--sleep-after` until changed. Eligible sessions must be idle, resumable, unpinned, visible, have no in-flight worker request, have no connected guest, and must not be paused; paused workers never sleep automatically or through the manual sleep route.
- `POST /api/sessions/:id/sleep` writes a bounded, model-free transcript checkpoint if key points are stale, then sleeps without running the before-stop model call. Asleep sessions stay in the separate `asleep` list in `live-sessions.json`; an interrupted `waking` entry recovers as asleep. `POST /api/sessions/:id/room` resumes the same session id before returning a room link.
- `GET /api/overnight/template` returns the saved prompt and policy; `PUT` validates and stores the template under the daemon state directory.
- `GET /api/overnight/preflight?cwd=<absolute-path>` runs bounded non-interactive readiness checks and returns `{checks}`.
- `POST /api/sessions` accepts optional `overnight: {task, policy?, prompt?}` to start an Overnight run with the composed prompt.
- `POST /api/sessions/:id/overnight` starts an Overnight run on an idle existing session (409 while busy); `GET` returns its saved state and morning report; `DELETE` stops the run while leaving the session available for normal use.
- Overnight run phase, deadline, and continuation count are included in session summaries; complete, deadline, and blocked phases send web-push notifications.
- `POST /api/sessions/:id/restart` reopens the worker from its saved session file with the same session id and room secret. A streaming, asking, or awaiting-answer worker returns `409` unless the body is `{"restartAnyway":true}`, which aborts the active turn before restart; the response preserves the room link and reconnects guests.
- `POST /api/sessions/:id/room` accepts `{"permission":"full"|"view"}`. Omitted permission defaults to `view`; full links include a write token only when explicitly requested, while view-only links omit it. The mandatory worker room is not revoked by `/collab stop`; that control explains the limitation instead.
- A worker-limit 409 response includes an optional `sleepCandidate` for the oldest idle, resumable session; sleep that candidate before retrying the original create request.

## Overnight run: guarantees and limits

Overnight run is best-effort, not a guarantee that a task will finish. The daemon persists controller state, continues premature turns, retries recoverable failures, and records blockers instead of bypassing missing model credentials, external permissions, usage limits, or project requirements. Readiness checks are bounded and non-interactive; they report only conditions the daemon can observe.

When an ask dialog times out, the worker automatically answers with the recommended option. Overnight runs disable Git terminal prompting (`GIT_TERMINAL_PROMPT=0`), default SSH to batch mode (`GIT_SSH_COMMAND=ssh -o BatchMode=yes` when unset), and disable GitHub CLI prompts (`GH_PROMPT_DISABLED=1`). These settings do not grant permissions or answer operating-system dialogs. `keepAwake` uses a macOS sleep assertion or a Linux `systemd-inhibit` child while work is active; it cannot prevent sleep caused by closing a lid.

## Subagent events for the plan runner

Every `{t:"agent"}` worker line (a subagent lifecycle transition in a session) is forwarded in worker order to listeners, with this exact signature (exported from `src/supervisor.ts`):

```ts
type AgentEvent = Extract<WorkerStatus, { t: "agent" }>; // { t:"agent"; agentId; parentId?; profile; status: "started"|"completed"|"failed"|"aborted"; summary? }
type AgentEventListener = (sessionId: string, event: AgentEvent) => void;

startDaemon({ ..., onAgentEvent?: AgentEventListener }): Promise<Daemon>   // fixed at start
daemon.onAgentEvent(listener: AgentEventListener): () => void             // added later; returns the unsubscribe function
new Supervisor({ ..., onAgentEvent?: AgentEventListener })                // the layer underneath
daemon.supervisor.spawnAgent(sessionId, request: SpawnAgentRequest): Promise<string>  // registry agent id; SupervisorError on refusal
```

A listener that throws is logged and does not stop the others. `summary` is present on terminal states when the agent had a result or error to report. `supervisor.catalog(id)`, `runCommand(id, text)` and `setAgentThinking(id, agentId, level)` are the same operations the HTTP routes use.

## Running on macOS

Build the web assets and start the daemon in the foreground:

```sh
(cd packages/web && bun run build)
bun packages/daemon/src/main.ts --port 7490 --state-dir ~/.omp-console --web-dir packages/web/dist
```

`./scripts/install.sh --launchd` installs and starts the LaunchAgent. Expose the daemon with **Tailscale Serve only; never use Tailscale Funnel**. Pass the exact `*.ts.net` host to `--allow-host` and, when Serve sends `Tailscale-User-Login`, set `--owner` to the expected tailnet login.

## Running on Linux

Linux uses the browser/PWA and can run the daemon as a user service:

```sh
./scripts/install.sh --systemd
```

The installer renders `ops/systemd/omp-console.service.template` with the Bun it checked (1.4 or newer) and enables `omp-console.service`. Use `loginctl enable-linger "$USER"` if the service must survive logout. Computer use and macOS Accessibility/Screen Recording checks are unavailable on Linux.

## Authentication

The daemon controls agents that can run commands with the daemon user's privileges. Loopback is not an identity: any web page can reach `127.0.0.1` from its browser, by DNS rebinding or cross-site requests. Existing peer, Host, Origin and fetch-site checks remain in force. Static assets and `index.html` stay public so the pairing screen can load.

Protected routes require a paired-device token: every `/api/*` route except `POST /api/pair` and `GET /api/pair/status`, every `/r/`, `/live/` and `/peers/<id>/r` WebSocket upgrade, and every peer proxy route. Missing, invalid or revoked credentials receive 401 JSON. Browsers use the `HttpOnly; SameSite=Strict` `omc_device` cookie; HTTPS adds `Secure`. Clients without cookies may use `Authorization: Bearer <device-token>`.

At first start with no paired devices, the daemon prints a one-time eight-character Crockford base32 code to stdout and writes it to `<stateDir>/pairing-code` with mode 0600. Codes expire after 10 minutes, permit at most five incorrect attempts, and are rate-limited to 10 attempts per minute at `POST /api/pair`. `omp-console-daemon pair [--state-dir <dir>]` requests a fresh code from a running daemon using request/response files under `<stateDir>/pair-requests`; this local-only control channel does not open an unauthenticated network endpoint. The Mac app can read the code from its configured local state directory; browsers and Android accept the code in the Pair screen.

Device tokens contain 32 random bytes and are stored only as SHA-256 hashes in `<stateDir>/devices.json` (0600, atomically written). Settings → Devices lists paired devices, revokes them immediately (including closing their open sockets), and issues a one-time code to pair another device. Revoking the current device clears its cookie and returns the UI to Pair.

Workers receive a unique short-lived device token only in the existing launch-secrets stdin message; the daemon revokes it when the worker exits. Peer entries use a `tokenFile` containing the remote daemon's device token (mode 0600); `--peer <id>=<url>` must be paired with `--peer-token-file <id>=<path>`. The local daemon attaches that token to peer API and relay requests; the browser never receives it. The service-worker push-answer path continues to use the same-origin device cookie.

Threat model: pairing protects against other OS users, browsers and other tailnet users. It does **not** protect against code running as the same OS user, including the agent itself; same-user code can read state files and act with the daemon user's privileges.

`Tailscale-User-Login` is not a credential. If `--owner` is set and the header is present, it must match; the header can only narrow access, never grant it. Requests still require a paired-device token. Tailscale Funnel is unsupported and must not be used.

## Push

`src/push-sender.ts` sends Web Push (VAPID, aes128gcm via the `web-push` library) to every stored subscription:

- VAPID keys are generated on first start and stored in `<state-dir>/vapid-keys.json` (0600, tightened on every start, never logged). A corrupt file stops the daemon instead of being replaced, since a new key orphans every subscription.
- Triggers: each worker `notify` status (`turn-finished`, `needs-answer`, `needs-approval`) and each worker crash (`worker-crashed`). Title = session title (control characters flattened, 80 characters), body = fixed phrase per reason. The worker's `summary`, tool output and file contents are never sent.
- `Urgency: high`, `TTL` 3600 s, one request per subscription in parallel, 10 s timeout each, no retries. A 404 or 410 removes the subscription; other failures are logged (host only) and the subscription stays.
- At most one push per session and reason per 30 s (extra events in the window are dropped).
- Endpoints: `GET /api/push/public-key`, `POST` and `DELETE /api/push/subscribe`, `POST /api/push/test` (204 when a push service accepted, 409 with no subscription, 502 when none accepted).

## Tests

`bun test` in this directory (fake worker in `test/fixtures`, a fake push service in `test/fake-push-service.ts` that verifies the VAPID JWT and decrypts the payload, no network beyond loopback, no model). Types: `bun run check:types`.

The repository includes `scripts/install.sh`, the LaunchAgent and systemd service templates, and `ops/tailscale-serve.sh`; use Tailscale Serve only for remote access.
