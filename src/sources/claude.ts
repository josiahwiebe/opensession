import path from "node:path"
import * as v from "valibot"
import type { LoadMode, SessionRecord, SessionSource } from "../types"
import { withMtimeCache } from "../utils/cache"
import { fileStat, readTextSample, readTextTailSample, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import {
  buildSessionRecord,
  normalizeTimestamp,
  parseJsonLines,
  parseWithSchema,
  textFromContent,
} from "./shared"

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

const ClaudeLineSchema = v.object({
  timestamp: v.optional(v.union([v.string(), v.number()])),
  cwd: v.optional(v.string()),
  session_id: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  role: v.optional(v.string()),
  message: v.optional(v.object({ content: v.optional(v.unknown()) })),
  content: v.optional(v.unknown()),
})

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
  const text = textFromContent(
    content,
    (part) => part.type === "text" || part.type === "input_text" || part.type === "output_text",
  )

  return text ? candidateClaudeText(text) : undefined
}

/** Parses a Claude transcript JSONL file into the metadata we display. */
export function parseClaudeSession(rawText: string, filePath: string): ParsedClaudeSession | undefined {
  const userMessages: string[] = []
  const assistantMessages: string[] = []
  let sessionId: string | undefined
  let workspacePath: string | undefined
  let startedAt: number | undefined
  let updatedAt: number | undefined

  for (const line of parseJsonLines(rawText)) {
    const parsedLine = parseWithSchema(ClaudeLineSchema, line)
    if (!parsedLine) {
      continue
    }

    const timestamp = normalizeTimestamp(parsedLine.timestamp)
    if (timestamp) {
      startedAt = startedAt ?? timestamp
      updatedAt = Math.max(updatedAt ?? timestamp, timestamp)
    }

    if (parsedLine.cwd) {
      workspacePath = parsedLine.cwd
    }

    if (parsedLine.session_id) {
      sessionId = parsedLine.session_id
    } else if (parsedLine.sessionId) {
      sessionId = parsedLine.sessionId
    }

    const text = textFromClaudeContent(parsedLine.message?.content ?? parsedLine.content)
    if (!text) {
      continue
    }

    if (parsedLine.role === "user") {
      userMessages.push(text)
    }

    if (parsedLine.role === "assistant") {
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
  async listSessions(mode: LoadMode = "full"): Promise<SessionRecord[]> {
    const files = await scanFilesByPatterns({
      roots: claudeRoots(),
      patterns: CLAUDE_PATTERNS,
      maxFiles: mode === "fast" ? 40 : 200,
    })

    const sessions = await Promise.all(
      files.map(async (filePath): Promise<SessionRecord | null> => {
        const stat = await fileStat(filePath)
        if (!stat) {
          return null
        }

        const parsed = await withMtimeCache(`claude:parsed:${filePath}`, stat.mtimeMs, async () => {
          const rawText = await readTextSample(filePath, 64_000)
          const tailText = await readTextTailSample(filePath, 64_000)
          return parseClaudeSession(`${rawText}\n${tailText}`, filePath)
        })
        if (!parsed) {
          return null
        }

        const sessionId = parsed.sessionId ?? path.basename(filePath).replace(/\.(jsonl?|md)$/i, "")

        return buildSessionRecord({
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
        })
      }),
    )

    return sessions.filter((session): session is SessionRecord => Boolean(session))
  },
}
