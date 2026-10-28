# UI screenshots

`capture.sh` drives `omp-sweep` (headless Chromium in its own process, no omp browser tabs) against the mock daemon and writes
`<device>-<state>-<theme>.png` here.

```sh
cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/capture.sh
```

| Device | Viewport |
|---|---|
| `iphone` | 393 x 852 |
| `ipad` | 820 x 1180 |
| `desktop` | 1280 x 800 |

| State | Probe (`probes/`) | What it shows |
|---|---|---|
| `transcript-stream` | `transcript-stream.js` | open session while a turn streams (the mock's `--fixtures` stream room), stop button visible |
| `sessions` | `sessions.js` | phone: full-height session sheet; tablet and desktop: the inline sidebar |
| `needs-bar` | `needs-bar.js` | one session open, another waiting: sticky needs-you bar |
| `ask-form` | `ask-form.js` | the waiting session open: the ask form docked above the keyboard area |
| `status` | `status.js` | status sheet: goal, todos, health |
| `settings` | `settings.js` | settings sheet: notifications, theme, leave |

Each probe is one async expression that `omp-sweep` evaluates before it takes the screenshot; it opens a session through the
`#session=<id>` deep link and clicks the real buttons. A non-empty return value is listed as an issue in the sweep log.

Headless Chromium is not iOS Safari: it has no `visualViewport` keyboard behaviour, no safe-area insets and no Home Screen display
mode, so those are checked by unit tests (`test/viewport.test.ts`) and need a real iPhone.

## Behaviour probes (`verify/`)

Run against `bun dev/mock-daemon.ts --dist dist` with one theme at a time (both probes change daemon state, so run each once per daemon):

```sh
omp-sweep --url http://127.0.0.1:7467/ --widths 393 --height 852 --themes dark --probe-only --probe-file test/screens/verify/two-taps.js
omp-sweep --url http://127.0.0.1:7467/ --widths 393 --height 852 --themes dark --probe-only --probe-file test/screens/verify/live-status.js
```

- `two-taps.js`: with another session open, the needs-you row (tap 1) and an option (tap 2) answer a waiting question; the bar, the form and the daemon's `awaitingAnswer` all clear.
- `live-status.js`: with the status sheet open, a new `todo` result moves the progress from 2/6 to 3/6, and a stalled worker turns its health card to `stalled` within one poll.

## Agent graph, model picker, profiles (`capture-agents.sh`, `probes-agents/`)

```sh
cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/capture-agents.sh
```

Starts the mock daemon with `--agent-tree` (the "Agent graph: relay reconnect" session: root, three children, one grandchild; finished, running, stalled and failed agents) and writes `iphone` (393 x 852) and `desktop` (1280 x 800) shots in light and dark:

| State | What it shows |
|---|---|
| `agent-graph` | the graph tab of the Agents sheet (pan, zoom, fit buttons, legend, summary row) |
| `agent-tree` | the indented tree tab (the phone default) |
| `model-picker` | agent drawer of a running subagent with "Change model" open: role aliases, providers, unavailable models disabled |
| `model-changed` | the inline result after picking a model |
| `profiles` | Settings > Model roles: the warning, agent profiles, and model roles |
| `profiles-confirm` | the confirm step of a profile edit |
