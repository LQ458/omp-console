# @omp-console/web

omp console UI: a fork of `packages/collab-web` that talks to the omp-console daemon (`@omp-console/protocol`) and is still a full collab guest (`src/lib/{socket,link,codec,client}.ts).

```sh
bun run mock-daemon                 # control API + relay + scripted rooms on :7467 (no real daemon needed)
bun run dev                         # HMR dev server on :3000, proxies /api and /r to $OMP_CONSOLE_DAEMON_URL (default http://127.0.0.1:7467)
bun run build                       # static assets in dist/ (the daemon serves them on the same origin)
bun run screens                     # headless screenshots of every phone/tablet/desktop state (test/screens/), needs omp-sweep
bun dev/mock-daemon.ts --dist dist  # serve the built assets from the mock daemon
bun dev/mock-daemon.ts --agent-tree   # adds the "Agent graph" session (root, 3 children, 1 grandchild: finished, running, stalled, failed)
bun run build && bun run screens:agents # rewrites the B4 agent screenshots (test/screens/)
bun dev/mock-daemon.ts --deny       # every /api call answers 401 (not-authorized UI state)
bun test
bun run check:types
```

The production build intentionally omits Bun's `--splitting`: with Bun 1.4.3, the generated HTML referenced a shared helper chunk instead of the application entry.

- `src/lib/api.ts`: typed `/api` client, error kinds `auth | network | conflict | not-found | bad-request | server`.
- `src/lib/switcher.ts`: session list/health polling (3 s, only while the page is visible), one live guest, switching, create/resume/fork/stop.
- `src/lib/lifecycle.ts`: `visibilitychange`/`online` source. On resume the socket is replaced immediately (`GuestClient.reconnect()`), a fresh welcome resyncs the transcript, and entries are deduplicated by id.
- The phone Actions panel shows up to 10 AI next-step suggestions and 20 locally ranked actions from recent usage, repeated prompts, slash commands, saved replies, and recipes. Recipe and history lookups fail open to the built-in shortcuts.
- The composer, ⌘K and phone Actions route `/tan`, `/omfg` and `/cleanse` to native omp console panels; Tan links its forked session to Agents, OMFG requires explicit review/acceptance before saving a rule, and Cleanse exposes scope selection, live repair progress and cancellation.
- `/skills` opens a session-scoped registry panel; installing a package that ships install scripts needs explicit approval (the dialog lists the files; declining or a 120 s timeout cancels the install). `/git` opens a repository sheet with unified, highlighted diffs, hunk-level staging, local commits and read-only revision views. `/record` captures display/tab video as WebM when available; closing during capture stops and downloads automatically. Probe (2026-10-26, macOS): Playwright WebKit 26.4 and Chromium headless shell 148.0.7778.96 both exposed `getDisplayMedia`, `MediaRecorder`, and WebM/VP8/VP9; each emitted a non-empty WebM from a synthetic canvas stream. Actual native screen-picker capture and omp console app WKWebView permission behavior remain unverified.
- Terminal-only omp controls are mapped to the native UI: pause/resume, queue, restart, collaboration status/view/list, and browser-native join/leave/open/copy/hotkeys/extensions commands are available from the composer and command palette; phone Actions exposes pause/resume.
- `/debug` opens Diagnostics and DAP sessions tabs. Diagnostics return bounded downloads (also saved on the daemon), live-refresh logs/raw SSE, and report browser/session equivalents for terminal-only checks; process-starting DAP launch/attach actions require confirmation. `/live` uses the browser's WebRTC peer for microphone capture and speaker playback, while the worker owns authenticated Codex signaling and sideband events; hiding the page or closing the sheet stops both peer and worker session.
- For isolated UI work, run `bun run build && bun dev/mock-daemon.ts --port <port> --fixtures --dist dist`; the mock daemon exercises pause, queue, restart, room permissions, and collaboration participants without a real worker or model.
- `dev/`: `mock-daemon.ts`, `mock-room.ts` (scripted fixture host), `local-relay.ts` (relay, embeddable via `createRelay`), `mock-host.ts` (standalone relay + one room), `dev-server.ts`.

Service worker: it is registered only on non-loopback origins (tailnet or public HTTPS, i.e. the phones). On `127.0.0.1`/`localhost` (the Mac app and a local browser) the page unregisters any earlier worker and deletes `omp-console-*` caches, because a cached shell there pins an old UI after the daemon serves a new build.
