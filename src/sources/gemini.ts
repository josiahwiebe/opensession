import type { SessionRecord, SessionSource } from "../types"
import { platform } from "../utils/fs"
import { scanFileBackedSessions } from "./shared"

function geminiRoots(): string[] {
  if (platform() === "darwin") {
    return [
      "~/Library/Application Support/Gemini",
      "~/Library/Application Support/google-gemini",
      "~/.gemini",
    ]
  }

  return ["~/.gemini", "~/.config/gemini", "~/.config/google-gemini"]
}

const GEMINI_PATTERNS = [
  "history/**/*.json",
  "history/**/*.jsonl",
  "sessions/**/*.json",
  "sessions/**/*.jsonl",
  "chats/**/*.json",
  "chats/**/*.jsonl",
  "**/*session*.json",
  "**/*chat*.json",
]

export const geminiSource: SessionSource = {
  id: "gemini",
  label: "Gemini",
  async listSessions(): Promise<SessionRecord[]> {
    return scanFileBackedSessions({
      source: "gemini",
      sourceLabel: "Gemini",
      roots: geminiRoots(),
      patterns: GEMINI_PATTERNS,
      maxFiles: 120,
      buildResumeAction: ({ sessionId }) => {
        if (!sessionId) {
          return undefined
        }

        return {
          command: "gemini",
          args: ["resume", sessionId],
        }
      },
      buildResumeHint: ({ sessionId }) =>
        sessionId
          ? "Attempts `gemini resume <session-id>` (depends on installed Gemini CLI)"
          : "No known session ID found",
    })
  },
}
