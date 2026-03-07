import path from "node:path"
import * as v from "valibot"
import type { SessionRecord, SessionSource } from "../types"
import { envPath, fileStat, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import { buildSessionRecord, normalizeTimestamp, parseJsonWithSchema, textFromContent } from "./shared"

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

const GeminiMessageSchema = v.object({
  type: v.optional(v.string()),
  content: v.optional(v.unknown()),
  displayContent: v.optional(v.unknown()),
})

const GeminiSessionSchema = v.object({
  sessionId: v.string(),
  messages: v.optional(v.array(GeminiMessageSchema)),
  summary: v.optional(v.string()),
  startTime: v.optional(v.union([v.string(), v.number()])),
  lastUpdated: v.optional(v.union([v.string(), v.number()])),
  directories: v.optional(v.array(v.string())),
  kind: v.optional(v.union([v.literal("main"), v.literal("subagent")])),
})

/** Parses a Gemini session file into the metadata we display. */
export function parseGeminiSession(rawText: string, filePath: string): GeminiSessionMeta | undefined {
  const parsed = parseJsonWithSchema(GeminiSessionSchema, rawText)
  if (!parsed) {
    return undefined
  }

  const messages = parsed.messages ?? []
  const userMessages = messages
    .map((message) => {
      if (message.type !== "user") {
        return undefined
      }

      const text = textFromContent(message.content)
      return text && !text.startsWith("/") && !text.startsWith("?") ? text : undefined
    })
    .filter((text): text is string => Boolean(text))

  const assistantMessages = messages
    .map((message) => {
      if (message.type !== "gemini") {
        return undefined
      }

      return textFromContent(message.displayContent) ?? textFromContent(message.content)
    })
    .filter((text): text is string => Boolean(text))

  const workspacePath = parsed.directories?.find((item) => item.length > 0)

  const explicitSummary = parsed.summary?.trim() || undefined
  const kind = parsed.kind
  const title = userMessages[0] ? truncate(userMessages[0], 90) : truncate(path.basename(filePath), 90)

  let summary = explicitSummary ?? assistantMessages.at(-1) ?? userMessages[1]
  if (kind === "subagent") {
    summary = summary ? `${summary} - subagent session` : "subagent session"
  }

  return {
    sessionId: parsed.sessionId,
    title,
    summary: summary ? truncate(summary, 180) : undefined,
    startedAt: normalizeTimestamp(parsed.startTime),
    updatedAt: normalizeTimestamp(parsed.lastUpdated),
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

        return buildSessionRecord({
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
        })
      }),
    )

    return sessions.filter((session): session is SessionRecord => Boolean(session))
  },
}
