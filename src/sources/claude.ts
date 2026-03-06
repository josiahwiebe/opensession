import type { SessionRecord, SessionSource } from "../types"
import { scanFileBackedSessions } from "./shared"

const CLAUDE_ROOTS = ["~/.claude/projects", "~/.claude/sessions", "~/.claude"]

const CLAUDE_PATTERNS = [
  "projects/**/*.jsonl",
  "projects/**/*.json",
  "sessions/**/*.jsonl",
  "sessions/**/*.json",
  "**/*session*.jsonl",
  "**/*session*.json",
]

export const claudeSource: SessionSource = {
  id: "claude",
  label: "Claude",
  async listSessions(): Promise<SessionRecord[]> {
    return scanFileBackedSessions({
      source: "claude",
      sourceLabel: "Claude",
      roots: CLAUDE_ROOTS,
      patterns: CLAUDE_PATTERNS,
      maxFiles: 200,
      buildResumeAction: ({ sessionId, filePath }) => {
        if (sessionId) {
          return {
            command: "claude",
            args: ["--resume", sessionId],
          }
        }

        return {
          command: "claude",
          args: ["--resume", filePath],
        }
      },
      buildResumeHint: () => "Runs `claude --resume <session-id>`",
    })
  },
}
