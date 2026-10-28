# Composer, palette and catalog screenshots (B6)

```sh
cd packages/web && bun run build
BUN=<pinned bun> bash test/screens/capture-composer.sh      # composer-<device>-<state>-<theme>.png
BUN=<pinned bun> bash test/screens/verify-composer/run.sh   # behaviour probes, one fresh mock daemon each
```

| State | Probe (`probes-composer/`) | What it shows |
|---|---|---|
| `mention-files` | `mention-files.js` | `@src/re` in the composer: fuzzy file list from the daemon, a directory first |
| `model-mention` | `model-mention.js` | `^an`: models for this turn, unavailable ones disabled |
| `slash-inline` | `slash-inline.js` | `/co` at the composer start: commands with source badges |
| `palette` | `palette.js` | Cmd+K palette: ranked commands and the omp equivalent with a copy button |
| `catalog` | `catalog.js` | "What omp can do", Commands tab |
| `catalog-profiles` | `catalog-profiles.js` | Agent profiles tab with Spawn actions |

Behaviour probes (`verify-composer/`): `accept-file` (Tab through directory then file, quoted path, Esc), `drop-mapping`
(inside cwd, outside cwd, prose), `paste-image` (refused while the client cannot carry images), `palette-run` (command with
arguments reaches the daemon), `slash-run` (inline run, panel event, argument fill), `journal-feedback` (events batch to the
daemon, no prompt text, feedback linked to screen and feature). The mock daemon answers `/api/health` with 404, so every
sweep logs one console error per health poll; that is not from these screens.
