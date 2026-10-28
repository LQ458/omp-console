# Tiled panes, queue chips, prompt history (U2)

Each pane is a full session view with its own header, transcript and composer. Dockview draws the grid; nothing else about the layout lives in Dockview.

## Who owns what

| Concern | Owner | File |
|---|---|---|
| Which panes exist, their sessions, focus, zoom | `PaneModel` (framework-free, the only writer) | `lib/pane-layout.ts` |
| Where the panes are (grid, sashes, sizes) | Dockview | `DockPanes.tsx` |
| Live connections | `GuestPool`: one client per wanted session, shared by panes showing the same session | `lib/guest-pool.ts` |
| What a pane renders | the app (`renderSession`, `renderEmpty`) | `app.tsx` |

Data flows model -> Dockview (`reconcile`). Back from Dockview comes only what the model cannot know: which group was clicked (focus) and sash sizes (saved with the layout). Dockview's tab strip, drag and drop and floating groups are off; structure changes go through the model.

## Opening sessions

- Sidebar click, notification tap, needs-you bar: the session opens in the focused pane. If a pane already shows it, that pane takes focus instead.
- Cmd-click a sidebar row, or Cmd+D / Cmd+Shift+D then open: a new split. Two panes may show one session; they share one connection.
- New / resumed / forked sessions open in the focused pane once the daemon has created them.

## Keys (Mac Command, kitty `splits`)

| Keys | Action |
|---|---|
| Cmd+D / Cmd+Shift+D | split right / split down (the new pane is empty and focused) |
| Cmd+Opt+arrows | focus the neighbour; with two equal neighbours, the one focused last |
| Cmd+Shift+arrows | swap this pane's session with the neighbour's; focus follows the session |
| Cmd+W | close the pane; the last pane returns to the home screen instead of vanishing |
| Cmd+Shift+Enter | zoom the pane; other panes release their transcript DOM until unzoomed |

The same actions are in the pane bar above the grid, with the saved-layouts menu.

## Layouts

`localStorage["omp-console-layout:current"]` is the auto-saved layout (panes, sessions, focus, Dockview grid), written 400 ms after a change. Named layouts are `omp-console-layout:<name>` (Layouts menu: save, load, delete). A grid is kept only when it describes exactly the saved panes; otherwise the panes are rebuilt from their split placements. Joined-room (`link:`) panes are never stored: the link is a secret. After a restore or load, the daemon's first session list empties panes whose session no longer exists.

## Phone (< 760 px)

No splits. A tab strip switches between panes (shown when there are two or more); only the current pane is mounted and only its session stays connected.

## Performance

- The focused pane renders every snapshot; background panes through `ThrottledSource` at 4 Hz (250 ms, leading plus trailing edge). The connection itself still receives every frame.
- A pane Dockview hides (zoom) renders a one-line stub, so its transcript DOM is released.
- Window-level hosts (command palette, spawn dialog, open-agent event, composer insert event) are mounted or enabled only in the focused pane, so a window event is handled once.
- Narrow panes (< 900 px, < 560 px) get the tablet header rules in `panes.css`; the window-level layout mode does not change.

## Queue chips and prompt history

`components/shell/QueueChips.tsx`, `lib/prompt-history.ts`: see the file headers. The chips show what this omp console sent while a turn ran, because the collab wire carries only the queue count (`SessionState.queuedMessageCount`).

## Checks

- Unit: `pane-layout`, `guest-pool`, `throttled-source`, `dock-reconcile`, `prompt-history`, `queue-chips` tests.
- Browser (headless, mock daemon): `bash test/screens/capture-panes.sh` runs the probes in `test/screens/probes-panes/` (split, grid, six panes, zoom, keys, queue chips with the dequeue call, history and drafts, named layouts, restore through a second page load, phone switcher) and writes `test/screens/panes-*.png`.
- Bench: `bun bench/run-headless.ts --scenario panes` (six streaming panes, see `bench/README.md`).
