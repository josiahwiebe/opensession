import path from "node:path"
import type { SessionRecord, SessionSource } from "../types"
import { fileStat, readTextSample, readTextTailSample, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import { parseJsonSafe } from "./shared"

function claudeRoots(): string[] {
  return ["~/.claude"]
}

const CLAUDE_PATTERNS = [
  "projects/**/*.jsonl",
  "sessions/**/*.jsonl",
  "**/*session*.jsonl",
  "**/*transcript*.jsonl",
]

interface ParsedClaudeSession {
  sessionId?: string
  title?: string
  summary?: string
  startedAt?: number
  updatedAt?: number
  workspacePath?: string
}

function normalizeDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  return undefined
}

function candidateClaudeText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return undefined
  }

  if (normalized.startsWith("<") && normalized.endsWith(">") && !normalized.includes(" ")) {
    return undefined
  }

  return normalized
}

function textFromClaudeContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return candidateClaudeText(content)
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const joined = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined
      }

      const value = item as Record<string, unknown>
      if ((value.type === "text" || value.type === "input_text" || value.type === "output_text") && typeof value.text === "string") {
        return candidateClaudeText(value.text)
      }

      return undefined
    })
    .filter((text): text is string => Boolean(text))
    .join(" ")
    .trim()

  return joined.length > 0 ? joined : undefined
}

function parseClaudeSession(rawText: string, filePath: string): ParsedClaudeSession | undefined {
  const lines = rawText.split("\n").filter(Boolean)
  if (lines.length === 0) {
    return undefined
  }

  const userMessages: string[] = []
  const assistantMessages: string[] = []
  let sessionId: string | undefined
  let workspacePath: string | undefined
  let startedAt: number | undefined
  let updatedAt: number | undefined

  for (const line of lines) {
    const parsed = parseJsonSafe(line)
    if (!parsed || typeof parsed !== "object") {
      continue
    }

    const value = parsed as Record<string, unknown>
    const timestamp = normalizeDate(value.timestamp)
    if (timestamp) {
      startedAt = startedAt ?? timestamp
      updatedAt = Math.max(updatedAt ?? timestamp, timestamp)
    }

    if (typeof value.cwd === "string" && value.cwd.length > 0) {
      workspacePath = value.cwd
    }

    if (typeof value.session_id === "string") {
      sessionId = value.session_id
    } else if (typeof value.sessionId === "string") {
      sessionId = value.sessionId
    }

    const role = value.role
    const message = value.message && typeof value.message === "object" ? (value.message as Record<string, unknown>) : undefined
    const text = textFromClaudeContent(message?.content ?? value.content)
    if (!text) {
      continue
    }

    if (role === "user") {
      userMessages.push(text)
    }

    if (role === "assistant") {
      assistantMessages.push(text)
    }
  }

  if (!sessionId && userMessages.length === 0 && assistantMessages.length === 0) {
    return undefined
  }

  const title = userMessages.at(-1) ?? assistantMessages.at(-1) ?? path.basename(filePath)
  const summary = assistantMessages.at(-1) ?? userMessages.at(-2)

  return {
    sessionId,
    title: truncate(title, 90),
    summary: summary ? truncate(summary, 180) : undefined,
    startedAt,
    updatedAt,
    workspacePath,
  }
}

export const claudeSource: SessionSource = {
  id: "claude",
  label: "Claude",
  async listSessions(): Promise<SessionRecord[]> {
    const files = await scanFilesByPatterns({
      roots: claudeRoots(),
      patterns: CLAUDE_PATTERNS,
      maxFiles: 200,
    })

    const sessions = await Promise.all(
      files.map(async (filePath): Promise<SessionRecord | null> => {
        const stat = await fileStat(filePath)
        if (!stat) {
          return null
        }

        const rawText = await readTextSample(filePath, 64_000)
        const tailText = await readTextTailSample(filePath, 64_000)
        const parsed = parseClaudeSession(`${rawText}\n${tailText}`, filePath)
        if (!parsed) {
          return null
        }

        const sessionId = parsed.sessionId ?? path.basename(filePath).replace(/\.(jsonl?|md)$/i, "")

        return {
          uid: `claude:${sessionId}`,
          source: "claude",
          sourceLabel: "Claude",
          sessionId,
          title: parsed.title ?? path.basename(filePath),
          summary: parsed.summary,
          filePath,
          workspacePath: parsed.workspacePath,
          updatedAt: parsed.updatedAt ?? stat.mtimeMs,
          startedAt: parsed.startedAt ?? stat.birthtimeMs,
          resumeAction: {
            command: "claude",
            args: ["--resume", sessionId],
          },
          resumeHint: "Runs `claude --resume <session-id>`",
        }
      }),
    )

    return sessions.filter((session): session is SessionRecord => Boolean(session))
  },
}
