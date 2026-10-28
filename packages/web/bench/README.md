# omp-console web bench

Measures rubric #4 (scroll smoothness on a 50k-line transcript) and the web leg of #5 (token to paint) in the real UI.

## `?bench`

Open the page with `?bench` in the URL. Without it no code runs and no global exists (`installBench` is never called; the two hooks the UI calls are a single null check).

```js
window.__deckBench.start();
await window.__deckBench.scroll({ durationMs: 12000, direction: "down", distancePx: 120000 }); // optional
const result = window.__deckBench.stop();
// { frames, droppedFrames, droppedPct, refreshMs,
//   tokenToPaintMs: { n, p50, p95, max }, longTasks }
```

- Frame log: a `requestAnimationFrame` interval is dropped when it exceeds 1.5x the refresh interval (rubric definition). `refreshMs` is the 25th percentile of the frame intervals, capped by an idle calibration taken on page load, so a run that is janky from its first frame cannot hide its own drops.
- Token to paint: every `message_update`, `tool_execution_update` and `entry` frame is stamped on arrival (`performance.mark deck:rx:<n>`); the transcript's React commit hands the batch to the next paint (`rAF` + `MessageChannel`), where `deck:paint:<n>` is marked and `deck:token-to-paint` measured (visible in DevTools and traces; the buffers are cleared as it goes). This is receive to paint only. The daemon-emit leg of #5 needs a timestamp on the frame and is measured by `packages/web/bench` on one clock.
- `longTasks`: main-thread tasks over 50 ms from the Long Tasks API. Chromium only; Safari reports 0.
- `scroll({ durationMs, direction: "down" | "up" | "bounce", distancePx? })` moves the transcript (`[data-deck-scroller]`) at constant velocity from where it is: `distancePx` (default: to the end in that direction) over `durationMs`, applied incrementally per frame so the list's own scroll corrections are kept. `bounce` goes down then back.

## Fixtures

`make-transcript.ts` generates a deterministic session (default 50,020 lines in 2,637 entries: user prompts, thinking, markdown with code blocks, bash/read/grep calls with their results) and the token sequence for the streaming fixture. `bun dev/mock-daemon.ts --fixtures` adds two live sessions:

| Session id | Content |
|---|---|
| `bench-50k` | the 50k-line transcript, sent as 256-entry snapshot chunks |
| `bench-stream` | a 3,000-line transcript, plus one `message_update` frame per token at 100 tokens/s, 20 s per message, repeating |

Open `http://<daemon>/?bench#session=bench-50k` (the `#session=` deep link selects the session).

### Six panes streaming (tiled layout)

`bun dev/mock-daemon.ts --panes` (the runner starts it for you) adds `pane-1` .. `pane-6`, each streaming 100 tokens/s. `--scenario panes` opens all six the way a user does (Cmd+D / Cmd+Shift+D to split, the `#session=` deep link to fill a pane), waits for every transcript, then records `?bench` frames for `--stream-ms`. The last pane opened has focus, so `result.droppedPct` is the dropped-frame share while the focused pane renders at full rate and the five others batch at 4 Hz (`components/panes/throttled-source.ts`). The probe also reports `streamingPanes`, `mountedRowsPerPane` and `jsHeapMB`. Compare it with `--scenario stream` (one pane, same token rate) for the cost of five more live transcripts.

## Runner

```sh
bun run build                                   # in packages/web
bun bench/run-headless.ts                       # both scenarios, JSON on stdout
bun bench/run-headless.ts --scenario scroll --scroll-px 585000 --scroll-ms 58500   # whole transcript at 10,000 px/s
bun bench/run-headless.ts --width 390 --height 844                                  # phone-sized viewport
bun bench/run-headless.ts --serve               # mock daemon + fixtures for a real device, prints the URLs
bun bench/run-headless.ts --print-probe scroll  # the page-side script, to paste into a device's web inspector
bun bench/run-headless.ts --url 'https://host/?bench#session=bench-50k' --scenario scroll   # any daemon
```

It runs the scenario through `omp-sweep --probe-only --probe-file` (Playwright in its own process, never an interactive tab) and reads the probe result from `report.json`.

**Headless Chromium numbers are not the rubric's.** The rubric measures WKWebView (Mac shell) and iPhone Safari; headless Chromium has neither their compositor, nor ProMotion, nor a phone CPU. Use the headless numbers for regressions and relative cost. For the rubric, open the same URL on the device and run the same probe there (`--print-probe`).

## Transition profiling

`run-transitions.ts` records per-frame rAF intervals and Long Tasks for session switching, pane open/close/split, sidebar fold/unfold, phone action-panel open/close, settings-sheet open, sheet drag spring/close, archive-row collapse (FLIP), toast enter/exit, and widget-figure appearance. It runs five samples per transition in WebKit on iPhone 15 and desktop, then in Chromium at 4× CPU throttling; the Chromium gate requires under 5% of frames over 16.7 ms and no frame over 50 ms. Long Tasks are recorded per transition. WebKit is reported for regressions, not gated on 16.7 ms intervals.

Build the UI first, then run before and after with identical options. The runner starts a seeded local mock daemon and harness and stops both when the run ends.

```sh
OMP_CONSOLE_COMPUTER_USE=0 \
OMP_CONSOLE_SCENARIO_ROOT=/tmp/omp-console-night2/w4-motion \
OMP_CONSOLE_SCENARIO_PORT_BASE=7670 \
"$BUN" bench/run-transitions.ts --out /tmp/omp-console-night2/out/w4-motion/transitions-before --phase before --repeats 5
```

Use `--phase after` and a separate `--out` directory for the second run. Each `transitions.json` stores every rAF interval and Long Task observation. FLIP layout-read ordering is checked in `SessionCardList.tsx`: all row positions are read before any transform writes.

## Transcript windowing: behaviour and limits

- Only rows within 600 px of the viewport are mounted. Row heights are measured with one `ResizeObserver`, cached by entry id, and unmeasured rows count as the measured mean. A row growing in place (streaming markdown, an expanded tool card) and a container width change are handled the same way: a height change above the viewport top adds the same amount to `scrollTop`; the list restores the entry that was at the viewport top after history is prepended or resynced.
- Within 40 px of the bottom the transcript follows the tail (streaming text, appended entries, a shrinking viewport when the keyboard opens). Scrolled away, nothing moves under the reader and a "latest" button appears after 200 px.
- Limits: browser find-in-page (Ctrl/Cmd-F) only sees mounted rows; the scrollbar thumb is approximate until rows have been measured; rows have no enter animation (only the live tail does). Screen readers get `role="feed"` with `aria-posinset`/`aria-setsize` on each mounted row; unmounted rows are not in the accessibility tree. On iOS, writing `scrollTop` during momentum scrolling can stop the momentum (known WebKit behaviour); the overscan keeps most corrections off-screen, but this is unverified on a device.

## Notifications and deep link (for the PWA wave)

- `notificationSignals()` (`src/lib/notifications.ts`) is the page-wide hook. `subscribe(listener)` receives `{ sessionId, reason: "needs-answer" | "turn-finished", title, body, tag, hidden, deliveredToAndroid }` once per occurrence (latched per `${sessionId}:${reason}`, re-armed when the ask is answered or a new turn starts). While the page is hidden it also calls `window.OmpConsoleAndroid?.notify(title, body, tag)`.
- `#session=<sessionId>` selects that session on load and on every hash change, then clears the hash (so tapping the same notification again fires again). A push click handler should open `/#session=<id>` or set it on a client it focuses.
