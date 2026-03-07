import path from "node:path"
import type { SessionRecord, SessionSource } from "../types"
import { envPath, fileStat, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import { parseJsonSafe } from "./shared"

function geminiRoots(): string[] {
  const home = envPath("GEMINI_CLI_HOME") ?? "~"
  return [`${home}/.gemini`]
}

const GEMINI_PATTERNS = ["tmp/*/chats/session-*.json", "tmp/*/chats/*.json"]

interface GeminiSessionMeta {
  sessionId: string
  title?: string
  summary?: string
  startedAt?: number
  updatedAt?: number
  workspacePath?: string
}

function textFromGeminiPart(part: unknown): string | undefined {
  if (typeof part === "string") {
    const text = part.trim()
    return text.length > 0 ? text : undefined
  }

  if (!part || typeof part !== "object") {
    return undefined
  }

  const value = part as Record<string, unknown>
  if (typeof value.text === "string" && value.text.trim().length > 0) {
    return value.text.trim()
  }

  return undefined
}

function textFromGeminiContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const text = content.trim()
    return text.length > 0 ? text : undefined
  }

  if (Array.isArray(content)) {
    const joined = content.map(textFromGeminiPart).filter(Boolean).join(" ").trim()
    return joined.length > 0 ? joined : undefined
  }

  return textFromGeminiPart(content)
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

function parseGeminiSession(rawText: string, filePath: string): GeminiSessionMeta | undefined {
  const parsed = parseJsonSafe(rawText)
  if (!parsed || typeof parsed !== "object") {
    return undefined
  }

  const value = parsed as Record<string, unknown>
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined
  if (!sessionId) {
    return undefined
  }

  const messages = Array.isArray(value.messages) ? value.messages : []
  const userMessages = messages
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined
      }

      const message = item as Record<string, unknown>
      if (message.type !== "user") {
        return undefined
      }

      const text = textFromGeminiContent(message.content)
      if (!text || text.startsWith("/") || text.startsWith("?")) {
        return undefined
      }

      return text
    })
    .filter((text): text is string => Boolean(text))

  const assistantMessages = messages
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined
      }

      const message = item as Record<string, unknown>
      if (message.type !== "gemini") {
        return undefined
      }

      return textFromGeminiContent(message.displayContent) ?? textFromGeminiContent(message.content)
    })
    .filter((text): text is string => Boolean(text))

  const workspacePath = Array.isArray(value.directories)
    ? value.directories.find((item): item is string => typeof item === "string" && item.length > 0)
    : undefined

  const explicitSummary = typeof value.summary === "string" && value.summary.trim().length > 0 ? value.summary.trim() : undefined
  const kind = value.kind === "subagent" ? "subagent" : value.kind === "main" ? "main" : undefined
  const title = userMessages[0] ? truncate(userMessages[0], 90) : truncate(path.basename(filePath), 90)

  let summary = explicitSummary ?? assistantMessages.at(-1) ?? userMessages[1]
  if (kind === "subagent") {
    summary = summary ? `${summary} - subagent session` : "subagent session"
  }

  return {
    sessionId,
    title,
    summary: summary ? truncate(summary, 180) : undefined,
    startedAt: normalizeDate(value.startTime),
    updatedAt: normalizeDate(value.lastUpdated),
    workspacePath,
  }
}

export const geminiSource: SessionSource = {
  id: "gemini",
  label: "Gemini",
  async listSessions(): Promise<SessionRecord[]> {
    const files = await scanFilesByPatterns({
      roots: geminiRoots(),
      patterns: GEMINI_PATTERNS,
      maxFiles: 120,
    })

    const sessions = await Promise.all(
      files.map(async (filePath): Promise<SessionRecord | null> => {
        const stat = await fileStat(filePath)
        if (!stat) {
          return null
        }

        const rawText = await Bun.file(filePath).text().catch(() => "")
        if (!rawText) {
          return null
        }

        const parsed = parseGeminiSession(rawText, filePath)
        if (!parsed) {
          return null
        }

        return {
          uid: `gemini:${parsed.sessionId}`,
          source: "gemini",
          sourceLabel: "Gemini",
          sessionId: parsed.sessionId,
          title: parsed.title ?? path.basename(filePath),
          summary: parsed.summary,
          filePath,
          workspacePath: parsed.workspacePath,
          updatedAt: parsed.updatedAt ?? stat.mtimeMs,
          startedAt: parsed.startedAt ?? stat.birthtimeMs,
          resumeAction: {
            command: "gemini",
            args: ["--resume", parsed.sessionId],
          },
          resumeHint: "Runs `gemini --resume <session-id>`",
        }
      }),
    )

    return sessions.filter((session): session is SessionRecord => Boolean(session))
  },
}
