# Migrate from Claude Code or Codex

Use the **Import from Claude Code or Codex** panel after pairing the browser with the daemon. The daemon reads the source data on the computer where it runs:

- Claude Code: `CLAUDE_CONFIG_DIR`, when set, otherwise `~/.claude`.
- Codex: `~/.codex`.

The panel reports whether each folder exists, groups conversations by project path, and shows a short preview, message count, and last activity. If a folder is missing, start Claude Code or Codex on this computer and refresh. If a transcript cannot be read, its import result shows the error; other selected conversations can still import.

## Import conversations

1. Select conversations under Claude Code or Codex. Use **Select all** to select all eligible conversations for that source.
2. Choose **Import selected** and wait for the per-source progress and results.
3. Choose **Open** beside an imported conversation to continue it in omp.

Imports create omp session copies in the daemon's normal session store; they do not edit or delete source transcripts. Re-importing the same source transcript returns its existing omp session instead of making a duplicate. Opening an imported conversation forks from the copy: the terminal session is unchanged. Malformed or unsupported transcripts are reported individually.

## Use Claude Code setup

omp already reads project-scoped `CLAUDE.md`, `.claude/commands`, `.claude/skills`, `.mcp.json`, and project Claude plugins from the project being used. Claude user configuration, plugins, and MCP servers from `~/.claude.json` can be enabled in the panel; dedicated toggles control user-level skills and commands. `CLAUDE_CONFIG_DIR` makes Claude user configuration active; the panel identifies this as **on because `CLAUDE_CONFIG_DIR` is set**.

Saving these choices updates omp's global settings only: `enabledProviders`, `skills.enableClaudeUser`, and `commands.enableClaudeUser`. Other omp settings are retained. It does not modify Claude Code's files. Running omp sessions need a restart to pick up changes.

Claude Code hooks and `.claude/agents` are not migrated: omp does not run Claude Code lifecycle hooks or load Claude Code agent definitions. Review the panel's **Not migrated** section before relying on those features.

## Privacy and pairing

The import API requires a paired device. Source transcripts stay on the daemon host, and imported conversation content is copied into omp's session store, where paired devices can view it. Do not import conversations into a daemon shared with people who should not see their contents.
