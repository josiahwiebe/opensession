import type { SessionRecord, SessionSource } from "../types"
import { platform } from "../utils/fs"
import { parseJsonSafe, scanFileBackedSessions } from "./shared"

function cursorRoots(): string[] {
  if (platform() === "darwin") {
    return [
      "~/Library/Application Support/Cursor/User/workspaceStorage",
      "~/Library/Application Support/Cursor/User/globalStorage",
    ]
  }

  return [
    "~/.config/Cursor/User/workspaceStorage",
    "~/.config/Cursor/User/globalStorage",
    "~/.cursor",
  ]
}

const CURSOR_PATTERNS = [
  "**/chatSessions/*.json",
  "**/chat/**/*.json",
  "**/*chat*.json",
  "**/*conversation*.json",
]

function readWorkspacePath(rawText: string): string | undefined {
  const parsed = parseJsonSafe(rawText)
  if (!parsed || typeof parsed !== "object") {
    return undefined
  }

  const candidates = [
    (parsed as any).workspacePath,
    (parsed as any).workspace,
    (parsed as any).cwd,
    (parsed as any).projectPath,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
  }

  return undefined
}

export const cursorSource: SessionSource = {
  id: "cursor",
  label: "Cursor",
  async listSessions(): Promise<SessionRecord[]> {
    const sessions = await scanFileBackedSessions({
      source: "cursor",
      sourceLabel: "Cursor",
      roots: cursorRoots(),
      patterns: CURSOR_PATTERNS,
      maxFiles: 120,
      buildResumeHint: () => "Uses workspace open fallback when available",
    })

    const enriched = await Promise.all(
      sessions.map(async (session) => {
        const rawText = session.filePath ? await Bun.file(session.filePath).slice(0, 16_384).text() : ""
        const workspacePath = readWorkspacePath(rawText)

        if (!workspacePath) {
          return {
            ...session,
            resumeAction: undefined,
            resumeHint: "No stable Cursor session-resume CLI. Open the file manually.",
          }
        }

        return {
          ...session,
          workspacePath,
          resumeAction: {
            command: "cursor",
            args: [workspacePath],
          },
          resumeHint: "Opens workspace in Cursor",
        }
      }),
    )

    return enriched
  },
}
