# Open Session

OpenTUI app to aggregate local coding-agent sessions in one place, then jump back in fast.

## What it does

- Scans session history from Claude Code, Codex, OpenCode, Cursor, and Gemini.
- Shows a searchable, unified session list sorted by most recent activity.
- Displays session metadata and transcript path details in a side panel.
- Runs a source-specific resume command when available (`Enter` or `r`).

## Platform support

- macOS
- Linux

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

## Key bindings

- `Tab`: switch focus between search and session list
- `1-6`: jump client filter (All, Claude, Codex, Cursor, Gemini, OpenCode)
- `Enter`: resume selected session
- `r`: resume selected session
- `u`: refresh all sources
- `q`: quit

## Source behavior

- **Codex**: reads `~/.codex/sessions` and resumes with `codex resume <session-id>`.
- **OpenCode**: prefers `opencode session list --format json`, falls back to local session files.
- **Claude Code**: scans `~/.claude` session files and resumes with `claude --resume <session-id>`.
- **Cursor**: scans known session-ish JSON files; if workspace path is found, opens with `cursor <path>`.
- **Gemini**: scans common history/session folders and attempts `gemini resume <session-id>` when possible.
