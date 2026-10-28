# Workspaces, look, rules, quick-ask, safety UI (U1)

Contract: `packages/protocol/src/wave2.ts`.

| Piece | Where | What |
|---|---|---|
| Workspace colour | `src/lib/workspace-color.ts` | `workspaceColor(workspace, theme, takenHues)` and `assignWorkspaceColors`: 12 curated hues 30 degrees apart, knowledge = teal (195), scratch = grey, projects seeded by the FNV-1a hash of the repo directory name, later workspace takes the next hue at least 30 degrees from the taken ones, daemon `hueOverride` wins. OKLCH values are gamut-mapped to sRGB hex, fixed lightness/chroma per theme; tests compute contrast (chip text >= 4.5:1 on its chip over every surface, accent >= 3:1). |
| Mode badges | `src/lib/mode-badges.ts` | `modeBadges(state)`: goal (amber, progress), PLAN (violet; dashed composer border), vibe, phone. See `REQUESTS.md` 1 for the missing wire signals. |
| Session look | `use-session-look.tsx`, `workspaces.css` | `--ws-accent`, `--ws-accent-text`, `--ws-tint`, `--ws-chip-bg` on the session root, 3 px accent bar, header chip (opens the panel), badge strip at the top of the panel (phone: chip and badges), 4-6% composer wash, session-row dot (`SessionWorkspaceDot`). 150 ms transitions, off under `prefers-reduced-motion`. |
| Workspaces sheet | `WorkspacesSheet.tsx`, `WorkspacesPanel.tsx` | Tabs Workspaces / Actions / Moves. Groups by kind, git status, live sessions, "New session here", "Start from current session" (handoff), colour override picker. Opened with `openWorkspaces()` (sidebar button, header chip). |
| Rules editor | `RulesEditor.tsx`, `src/lib/workspaces.ts` | File list (private first), who-sees-what cards, editor, save, git diff for shared files, new-file form with path rules (private under `.omp/rules/`, shared `AGENTS.md` or `docs/`). |
| Quick-ask | `QuickAsk.tsx`, `quick-ask.ts` | Cmd+J (or `openQuickAsk()`): question, source checkboxes (configured sources only; no default selection), `POST /api/quick-ask`, answer in a side sheet that is a second collab guest of the knowledge session. |
| Actions panel | `../safety/ActionsPanel.tsx`, `audit.ts` | `gate()`: modes (read-only, research note), audit table with verdict, kind, text and this-session filters. |
| Drift card | `../safety/DriftCard.tsx`, `drift-poller.ts` | Polls `drift(sessionId)` every 4 s, only for knowledge-workspace sessions and only while the page is visible. Daemon facts first; agent text under an "agent says" label; dismiss mutes the root. |
| Safe move | `src/lib/move.ts`, `../safety/MovePanel.tsx`, `MoveHistory.tsx` | `prepareMove` -> preview (destination, counts, excluded) -> Tauri `invoke("confirm_move", {moveId, nonce, summary})` -> token -> `confirmMove`. No bridge: "Confirm on the Mac app", nothing sent. A cancelled or expired preview ignores a late approval. History with undo (409 explained). |

Every control that has an omp equivalent shows it (`OmpEquivalent`) and records `recordUsage` (`6.workspaces`, `6.rules`, `6.quick-ask`, `7.look`, `9.drift`, `9.move`).

Mock and screenshots: `bun dev/mock-daemon.ts --workspaces`; `bash test/screens/capture-workspaces.sh` writes `test/screens/workspaces-<device>-<state>-<theme>.png` (states: `session-relay`, `session-docs`, `session-job`, `session-scratch`, `panel`, `panel-handoff`, `rules-private`, `rules-shared`, `quick-ask-open`, `quick-ask-answer`, `actions`, `move-needs-mac`, `move-preview`, `moves`).
