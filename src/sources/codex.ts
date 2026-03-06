import path from "node:path"
import type { SessionRecord, SessionSource } from "../types"
import { fileStat, readTextSample, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import { parseJsonSafe } from "./shared"

const CODEX_ROOTS = ["~/.codex/sessions"]
const CODEX_PATTERNS = ["**/*.jsonl", "**/*.json"]

interface ParsedCodexMeta {
  sessionId?: string
  title?: string
  summary?: string
  workspacePath?: string
}

function candidateUserText(text: string): string | undefined {
  const stripped = text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")

  const normalized = stripped.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return undefined
  }

  const noisePrefixes = [
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<collaboration_mode>",
  ]

  if (noisePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return undefined
  }

  if (normalized.startsWith("<") && normalized.endsWith(">") && !normalized.includes(" ")) {
    return undefined
  }

  if (normalized.length < 4) {
    return undefined
  }

  return normalized
}

/** Parses Codex jsonl transcript lines for metadata. */
function parseCodexSession(rawText: string): ParsedCodexMeta {
  const lines = rawText.split("\n").filter(Boolean)

  let sessionId: string | undefined
  let workspacePath: string | undefined
  const userMessages: string[] = []
  let assistantPreview: string | undefined

  for (const line of lines) {
    const parsed = parseJsonSafe(line)
    if (!parsed || typeof parsed !== "object") {
      continue
    }

    const payload = (parsed as any).payload
    const type = (parsed as any).type

    if (type === "session_meta" && payload && typeof payload === "object") {
      if (typeof payload.id === "string") {
        sessionId = payload.id
      }
      if (typeof payload.cwd === "string") {
        workspacePath = payload.cwd
      }
    }

    if (!payload || typeof payload !== "object") {
      continue
    }

    if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
      for (const contentPart of payload.content) {
        if (contentPart?.type === "input_text" && typeof contentPart.text === "string") {
          const candidate = candidateUserText(contentPart.text)
          if (candidate) {
            userMessages.push(candidate)
          }
        }
      }
    }

    if (
      !assistantPreview &&
      payload.type === "message" &&
      payload.role === "assistant" &&
      Array.isArray(payload.content)
    ) {
      for (const contentPart of payload.content) {
        if (contentPart?.type === "output_text" && typeof contentPart.text === "string") {
          const candidate = candidateUserText(contentPart.text)
          if (candidate) {
            assistantPreview = candidate
            break
          }
        }
      }
    }
  }

  const title = userMessages[0]
    ? truncate(userMessages[0], 90)
    : assistantPreview
      ? truncate(assistantPreview, 90)
      : undefined

  const summary = userMessages[1]
    ? truncate(userMessages[1], 180)
    : assistantPreview
      ? truncate(assistantPreview, 180)
      : undefined

  return {
    sessionId,
    workspacePath,
    title,
    summary,
  }
}

export const codexSource: SessionSource = {
  id: "codex",
  label: "Codex",
  async listSessions(): Promise<SessionRecord[]> {
    const files = await scanFilesByPatterns({
      roots: CODEX_ROOTS,
      patterns: CODEX_PATTERNS,
      maxFiles: 180,
    })

    const sessions = await Promise.all(
      files.map(async (filePath): Promise<SessionRecord | null> => {
        const stat = await fileStat(filePath)
        if (!stat) {
          return null
        }

        const rawText = await readTextSample(filePath, 64_000)
        const parsed = parseCodexSession(rawText)
        const fallbackName = path.basename(filePath)
        const sessionId = parsed.sessionId ?? fallbackName.replace(/\.(jsonl?|md)$/i, "")

        return {
          uid: `codex:${sessionId}`,
          source: "codex",
          sourceLabel: "Codex",
          sessionId,
          title: parsed.title ?? fallbackName,
          summary: parsed.summary,
          workspacePath: parsed.workspacePath,
          filePath,
          updatedAt: stat.mtimeMs,
          startedAt: stat.birthtimeMs,
          resumeAction: {
            command: "codex",
            args: ["resume", sessionId],
          },
          resumeHint: "Runs `codex resume <session-id>`",
        }
      }),
    )

    return sessions.filter((session: SessionRecord | null): session is SessionRecord => Boolean(session))
  },
}
